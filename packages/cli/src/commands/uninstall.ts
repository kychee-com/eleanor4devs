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
import { revokeAndClearCredential } from "./logout.js";
import { readRefreshToken, refreshToAccessToken } from "../auth_refresh.js";
import { listEnabledSessions } from "../state.js";

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

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface BackendOutcome {
  sessionsDisabled: number;
  credentialRevoked: boolean;
}

/**
 * Best-effort backend courtesy (AC-149) — runs FIRST because it needs
 * `state.json` (the enabled-session list) and `auth.json` (the credential),
 * both deleted later in the sweep:
 *
 *   - report every locally-ENABLED session `disabled` so its Thread lands
 *     in the semantically-right retired state (a failed POST is warned and
 *     skipped — the backend staleness sweep retires it instead);
 *   - revoke + clear the credential (the shared `revokeAndClearCredential`
 *     core from `logout`).
 *
 * Unlinked machine (no readable refresh_token) → NO network call at all.
 * Never throws; never blocks the local sweep.
 */
async function backendBestEffort(
  opts: UninstallOptions,
): Promise<BackendOutcome> {
  const warn = opts.errorLog ?? opts.log;
  const refreshToken = readRefreshToken(opts.credentialsPath);
  if (refreshToken === null) {
    return { sessionsDisabled: 0, credentialRevoked: false };
  }

  const fetchOpts = opts.fetch !== undefined ? { fetch: opts.fetch } : {};
  let sessionsDisabled = 0;
  const enabled = listEnabledSessions({ statePath: opts.statePath });
  if (enabled.length > 0) {
    const auth = await refreshToAccessToken({
      backendUrl: opts.backendUrl,
      refreshToken,
      ...fetchOpts,
    });
    if (auth.ok) {
      const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
      const base = opts.backendUrl.replace(/\/$/, "");
      for (const sessionId of enabled) {
        try {
          const res = await fetchFn(`${base}/hooks/disable`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${auth.accessToken}`,
            },
            body: JSON.stringify({ session_id: sessionId }),
          });
          if (res.ok) {
            sessionsDisabled += 1;
          } else {
            warn(
              `eleanor4devs uninstall: backend disable for session ${sessionId} ` +
                `failed (http_${res.status}) — the staleness sweep will retire it.`,
            );
          }
        } catch (err) {
          warn(
            `eleanor4devs uninstall: backend disable for session ${sessionId} ` +
              `did not land (${errText(err)}) — the staleness sweep will retire it.`,
          );
        }
      }
    } else {
      warn(
        `eleanor4devs uninstall: could not authenticate to the backend ` +
          `(${auth.reason}); session disables did not land — the staleness ` +
          `sweep will retire them.`,
      );
    }
  }

  const revoke = await revokeAndClearCredential({
    credentialsPath: opts.credentialsPath,
    backendUrl: opts.backendUrl,
    warn,
    ...fetchOpts,
  });
  return { sessionsDisabled, credentialRevoked: revoke.revoked };
}

/** The one artifact uninstall leaves behind — printed, never executed (AC-152). */
export const NPM_FINAL_STEP = "npm uninstall -g @eleanor4devs/cli";

/** Exit-code mapping for cli.ts: only the non-TTY refusal is an error. */
export function uninstallExitCode(outcome: UninstallOutcome): number {
  return outcome === "refused" ? 1 : 0;
}

/**
 * Render the post-run summary (AC-152). A COMPLETED sweep (and a
 * nothing-to-remove run) ends with the final-step line naming the npm
 * uninstall the user performs themselves. A declined/refused run prints
 * NO npm line — the artifacts remain, and removing the package then
 * would orphan the still-registered hooks.
 */
export function renderUninstallOutcome(
  result: UninstallResult,
  log: (text: string) => void,
): void {
  if (result.outcome === "declined" || result.outcome === "refused") {
    return; // runUninstall already printed the aborted/refused line.
  }
  if (result.outcome === "completed") {
    if (result.hooksDeregistered) {
      log("removed: eleanor4devs lifecycle hook entries (settings.json)");
    }
    if (result.mcpEntryRemoved) {
      log("removed: eleanor4devs MCP entry (mcp_servers.json)");
    }
    if (result.commandsRemoved.length > 0) {
      log(`removed: slash commands ${result.commandsRemoved.join(", ")}`);
    }
    for (const dir of result.skillsRemoved) {
      log(`removed: skill pack ${dir}`);
    }
    if (result.stateRemoved) {
      log(
        "removed: local state dir (per-session reporting state, device credential, audit log)",
      );
    }
    if (result.sessionsDisabled > 0) {
      log(`backend: ${result.sessionsDisabled} session(s) reported disabled`);
    }
    if (result.credentialRevoked) {
      log("backend: device credential revoked");
    }
  }
  log(`Final step (not performed automatically): ${NPM_FINAL_STEP}`);
}

/**
 * Render the will-remove summary the interactive confirmation shows —
 * exactly the artifacts that are PRESENT, plus the backend actions a
 * linked machine will attempt (AC-151).
 */
function buildSummary(inventory: Inventory, opts: UninstallOptions): string {
  const lines: string[] = ["eleanor4devs uninstall will remove:"];
  if (inventory.hooks) {
    lines.push(
      `  - the eleanor4devs lifecycle hook entries in ${opts.settingsPath}`,
    );
  }
  if (inventory.mcpEntry) {
    lines.push(`  - the eleanor4devs MCP entry in ${opts.mcpConfigPath}`);
  }
  if (inventory.commands.length > 0) {
    lines.push(
      `  - slash commands: ${inventory.commands.join(", ")} (in ${opts.commandsDir})`,
    );
  }
  for (const dir of inventory.skillDirs) {
    lines.push(`  - skill pack: ${dir}`);
  }
  if (inventory.stateDir) {
    lines.push(
      `  - ${opts.stateDir} (per-session reporting state, device credential, local audit log)`,
    );
  }
  if (readRefreshToken(opts.credentialsPath) !== null) {
    lines.push(
      "and will attempt, best-effort: report this machine's opted-in sessions " +
        "as disabled and revoke the device credential server-side.",
    );
  }
  lines.push("The npm package itself stays — the final step is printed at the end.");
  return lines.join("\n");
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

  // Confirmation gate (AC-151) — BEFORE any mutation and before the backend
  // step, so declining costs zero mutations and zero network ([[DD-74]]
  // default-deny: a non-TTY run must opt in explicitly with --yes).
  if (!opts.yes) {
    const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
    if (!isTTY) {
      (opts.errorLog ?? opts.log)(
        "eleanor4devs uninstall: refusing to run non-interactively without " +
          "--yes. Re-run with: eleanor4devs uninstall --yes",
      );
      return emptyResult("refused");
    }
    const proceed =
      opts.confirm !== undefined
        ? await opts.confirm(buildSummary(inventory, opts))
        : false;
    if (!proceed) {
      opts.log("eleanor4devs uninstall: aborted — nothing removed.");
      return emptyResult("declined");
    }
  }

  // (1) Backend best-effort FIRST — needs state.json + auth.json intact
  //     (AC-149). Never blocks the local sweep.
  step(opts, "backend-disable-revoke");
  const backend = await backendBestEffort(opts);

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
    sessionsDisabled: backend.sessionsDisabled,
    credentialRevoked: backend.credentialRevoked,
    hooksDeregistered: inventory.hooks,
    mcpEntryRemoved,
    commandsRemoved,
    skillsRemoved,
    stateRemoved,
  };
}
