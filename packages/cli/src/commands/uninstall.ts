/**
 * `eleanor4devs uninstall` — remove every eleanor4devs artifact from the
 * machine except the npm package itself (Phase 29, [[DD-74]]).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI (spec
 * v0.17.0, F-11, AC-147..AC-152) — the clean reverse of `install`.
 *
 * Fixed sweep order ([[DD-74]]):
 *
 *   1. Backend best-effort (needs state.json + auth.json, so it runs
 *      before ANY deletion): disable every locally-enabled session, then
 *      revoke + clear the credential (the `runLogout` flow).
 *   2. De-register the four lifecycle hooks — BEFORE any file removal,
 *      so no Claude Code lifecycle event ever targets a half-removed
 *      install (AC-148).
 *   3. Remove the eleanor4devs `mcpServers` entry (foreign entries kept).
 *   4. Remove the `/e4d` + `/e4d-status` slash commands.
 *   5. Remove the core skills dir (+ the legacy `~/.agent` twin).
 *   6. Remove `~/.eleanor4devs` LAST — so a mid-run hook from a
 *      concurrent session still fail-closes against an intact state file
 *      (AC-118 semantics hold to the final moment).
 *
 * Every removal is idempotent; an absent artifact is recorded, never an
 * error (AC-150). Foreign artifacts — other agents' hooks, MCP entries,
 * slash commands, skills — are preserved untouched (AC-147).
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deregisterHooks, resolveRealPath } from "./hook_registry.js";
import { isEleanorHookEntry, type ClaudeHookEntry } from "./hook_templates.js";

const ELEANOR_MCP_ENTRY_NAME = "eleanor4devs";
const ELEANOR_COMMAND_FILES = ["e4d.md", "e4d-status.md"] as const;

export interface UninstallOptions {
  /** Path to the agent's MCP config (e.g., ~/.claude/mcp_servers.json). */
  mcpConfigPath: string;
  /** Path to the agent's settings file (e.g., ~/.claude/settings.json). */
  settingsPath: string;
  /** Installed core-pack dir (e.g., ~/.claude/skills/eleanor4devs). */
  skillsTargetDir: string;
  /**
   * Legacy twin left by a pre-v0.0.x installer (~/.agent/skills/eleanor4devs)
   * — swept as hygiene when present ([[DD-74]]). Optional.
   */
  agentSkillsTwinDir?: string;
  /** Claude Code user slash-command dir (e.g., ~/.claude/commands). */
  commandsDir: string;
  /** The whole local state dir (~/.eleanor4devs) — removed LAST. */
  stateDir: string;
  /** Path to state.json inside stateDir (per-session opt-in records). */
  statePath: string;
  /** Path to auth.json inside stateDir (device credential). */
  credentialsPath: string;
  /** Backend base URL, e.g. https://api.eleanor4devs.com. */
  backendUrl: string;
  /** `--yes`: skip the interactive confirmation. */
  yes: boolean;
  /** Whether stdin is a TTY. Defaults to `process.stdin.isTTY`. */
  isTTY?: boolean;
  /**
   * Interactive confirmation hook — receives the removal summary, resolves
   * true to proceed. Injected by cli.ts (node:readline) and by tests.
   * Only consulted when `yes` is false and `isTTY` is true.
   */
  confirm?: (summary: string) => Promise<boolean>;
  /** Stdout sink. */
  log: (text: string) => void;
  /** Stderr sink. Defaults to `log`. */
  errorLog?: (text: string) => void;
  /** Fetch override for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Test-only step observer — the AC-148 ordering pin reads this. */
  onStep?: (step: string) => void;
}

export type UninstallOutcome =
  | "completed"
  | "nothing-to-remove"
  | "declined"
  | "refused";

export interface UninstallResult {
  outcome: UninstallOutcome;
  /** Locally-enabled sessions reported `disabled` to the backend. */
  sessionsDisabled: number;
  /** True when a stored credential was revoked (or cleared) this run. */
  credentialRevoked: boolean;
  /** True when e4d hook entries were present and de-registered. */
  hooksDeregistered: boolean;
  /** True when the eleanor4devs MCP entry was present and removed. */
  mcpEntryRemoved: boolean;
  /** Basenames of the slash-command files actually removed. */
  commandsRemoved: string[];
  /** Paths of the skill-pack dirs actually removed. */
  skillsRemoved: string[];
  /** True when the state dir existed and was removed. */
  stateRemoved: boolean;
}

function emptyResult(outcome: UninstallOutcome): UninstallResult {
  return {
    outcome,
    sessionsDisabled: 0,
    credentialRevoked: false,
    hooksDeregistered: false,
    mcpEntryRemoved: false,
    commandsRemoved: [],
    skillsRemoved: [],
    stateRemoved: false,
  };
}

interface Inventory {
  hooks: boolean;
  mcpEntry: boolean;
  /** Present e4d command-file basenames. */
  commands: string[];
  /** Present skill-pack dirs (target + legacy twin). */
  skillDirs: string[];
  stateDir: boolean;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* unreadable → treat as absent */
  }
  return null;
}

function hasEleanorHooks(settingsPath: string): boolean {
  const settings = readJsonObject(settingsPath);
  const hooks = (settings?.["hooks"] ?? {}) as Record<string, ClaudeHookEntry[]>;
  if (typeof hooks !== "object" || hooks === null) return false;
  return Object.values(hooks).some(
    (list) => Array.isArray(list) && list.some((e) => isEleanorHookEntry(e)),
  );
}

function hasMcpEntry(mcpConfigPath: string): boolean {
  const config = readJsonObject(mcpConfigPath);
  const servers = config?.["mcpServers"];
  return (
    typeof servers === "object" &&
    servers !== null &&
    ELEANOR_MCP_ENTRY_NAME in (servers as Record<string, unknown>)
  );
}

function takeInventory(opts: UninstallOptions): Inventory {
  const commands = ELEANOR_COMMAND_FILES.filter((f) =>
    existsSync(join(opts.commandsDir, f)),
  );
  const skillDirs = [opts.skillsTargetDir, opts.agentSkillsTwinDir].filter(
    (d): d is string => d !== undefined && existsSync(d),
  );
  return {
    hooks: hasEleanorHooks(opts.settingsPath),
    mcpEntry: hasMcpEntry(opts.mcpConfigPath),
    commands,
    skillDirs,
    stateDir: existsSync(opts.stateDir),
  };
}

/**
 * Remove ONLY the eleanor4devs key from `mcpServers`, preserving every
 * foreign entry and unrelated top-level key. Symlink-aware atomic write
 * ([[DD-64]] discipline); absent file/key → no-op, NO rewrite.
 */
function removeMcpEntry(mcpConfigPath: string): boolean {
  const config = readJsonObject(mcpConfigPath);
  const servers = config?.["mcpServers"];
  if (
    config === null ||
    typeof servers !== "object" ||
    servers === null ||
    !(ELEANOR_MCP_ENTRY_NAME in (servers as Record<string, unknown>))
  ) {
    return false;
  }
  delete (servers as Record<string, unknown>)[ELEANOR_MCP_ENTRY_NAME];
  const real = resolveRealPath(mcpConfigPath);
  const tmp = `${real}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
  renameSync(tmp, real);
  return true;
}

function step(opts: UninstallOptions, name: string): void {
  opts.onStep?.(name);
}

/**
 * Execute the uninstall sweep. See the module docstring for the fixed
 * order and the spec criteria each step satisfies.
 */
export async function runUninstall(
  opts: UninstallOptions,
): Promise<UninstallResult> {
  const inventory = takeInventory(opts);
  const anythingPresent =
    inventory.hooks ||
    inventory.mcpEntry ||
    inventory.commands.length > 0 ||
    inventory.skillDirs.length > 0 ||
    inventory.stateDir;

  if (!anythingPresent) {
    opts.log(
      "eleanor4devs: nothing to remove — no eleanor4devs artifacts found on this machine.",
    );
    return emptyResult("nothing-to-remove");
  }

  // (2) De-register the four lifecycle hooks BEFORE any file removal (AC-148).
  step(opts, "deregister-hooks");
  if (inventory.hooks) {
    deregisterHooks(opts.settingsPath);
  }

  // (3) MCP entry.
  step(opts, "remove-mcp-entry");
  const mcpEntryRemoved = removeMcpEntry(opts.mcpConfigPath);

  // (4) Slash commands.
  step(opts, "remove-commands");
  const commandsRemoved: string[] = [];
  for (const file of inventory.commands) {
    rmSync(join(opts.commandsDir, file), { force: true });
    commandsRemoved.push(file);
  }

  // (5) Skill packs (target dir + legacy twin; junction-tolerant — a path
  //     already gone because it resolved to the same real dir just no-ops).
  step(opts, "remove-skills");
  const skillsRemoved: string[] = [];
  for (const dir of inventory.skillDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      skillsRemoved.push(dir);
    }
  }

  // (6) The state dir — LAST ([[DD-74]]).
  step(opts, "remove-state-dir");
  let stateRemoved = false;
  if (inventory.stateDir) {
    rmSync(opts.stateDir, { recursive: true, force: true });
    stateRemoved = true;
  }

  return {
    outcome: "completed",
    sessionsDisabled: 0,
    credentialRevoked: false,
    hooksDeregistered: inventory.hooks,
    mcpEntryRemoved,
    commandsRemoved,
    skillsRemoved,
    stateRemoved,
  };
}
