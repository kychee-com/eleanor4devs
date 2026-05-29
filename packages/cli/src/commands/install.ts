/**
 * `eleanor4devs install` — the all-in-one onboarding command.
 *
 * 1. Writes the MCP server entry into `~/.claude/mcp_servers.json`
 *    (merging — never clobbering — any existing entries from other
 *    agents).
 * 2. Writes the 4 Claude Code hook entries (after_create / before_run /
 *    after_run / before_remove) into `~/.claude/settings.json` under
 *    the `hooks` key (Phase 8 — Claude Local Box). Other agents' hooks
 *    are preserved; an existing eleanor4devs entry is replaced in place
 *    so re-runs are idempotent.
 * 3. Installs the Core Skills Pack via `installSkills` (which honors
 *    the skill-review-before-apply contract).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  installSkills,
  type SkillReview,
} from "./install_skills.js";
import {
  buildHookEntries,
  ELEANOR_HOOK_MATCHER,
  type ClaudeHookEntry,
} from "./hook_templates.js";

const ELEANOR_MCP_ENTRY_NAME = "eleanor4devs";

/** Canonical MCP-server entry shape that gets written to mcp_servers.json. */
const ELEANOR_MCP_ENTRY = {
  command: "npx",
  args: ["-y", "@eleanor4devs/mcp"],
};

/**
 * Canonical body of `~/.claude/commands/e4d.md` (Phase 19, [[DD-41]]).
 *
 * Claude Code reads slash-command markdown files from
 * `~/.claude/commands/<name>.md`. Lines beginning with `!` execute as
 * bash via the command-passthrough syntax — BUT ONLY when the
 * frontmatter declares `allowed-tools: Bash(...)`. Without that
 * declaration the `!command` line is treated as literal prompt text
 * and is sent to the assistant verbatim (caught 2026-05-28 live smoke:
 * user typed `/e4d`, "`!eleanor4devs toggle`" landed in the
 * conversation as literal text instead of executing).
 *
 * `Bash(eleanor4devs:*)` narrowly scopes the permission to just the
 * eleanor4devs binary so this slash command can't be repurposed to
 * run arbitrary shell. The single source of truth for this file body
 * lives here so install + tests + future docs all reference the same
 * string.
 */
export const E4D_SLASH_COMMAND_BODY =
  "---\n" +
  "description: Toggle Eleanor4Devs local reporting (ON / OFF)\n" +
  "allowed-tools: Bash(eleanor4devs:*)\n" +
  "---\n" +
  "!eleanor4devs toggle\n";

export interface InstallOptions {
  /** Path to the agent's MCP config (e.g., ~/.claude/mcp_servers.json). */
  mcpConfigPath: string;
  /** Path to the agent's settings file (e.g., ~/.claude/settings.json) — hook templates land here. */
  settingsPath: string;
  /** Where the bundled skill markdowns live on disk. */
  skillsSourceDir: string;
  /** Where to write skills on the user's machine. */
  skillsTargetDir: string;
  /**
   * Directory where Claude Code looks up user slash commands. Phase 19
   * writes `e4d.md` here. Defaults in cli.ts to
   * `~/.claude/commands`; tests inject a temp dir.
   */
  commandsDir: string;
  /**
   * Path to `~/.eleanor4devs/state.json` (the Local Reporting Control
   * state file). Phase 19 initializes this to `{enabled: false,
   * toggled_at: null}` on a fresh install ONLY — re-running install on
   * an existing file (even a corrupt one) leaves the file untouched.
   */
  statePath: string;
  /** Skill review hook. Defaults to ALWAYS_APPLY via installSkills. */
  review?: SkillReview;
}

export interface InstallResult {
  mcpEntryWritten: boolean;
  hookEntriesWritten: boolean;
  skillsInstalled: string[];
  skillsSkipped: string[];
  /** True on every install run — the slash-command file is always written (overwrite-safe). */
  slashCommandWritten: boolean;
  /** True iff this install run created `state.json` because the file didn't exist. */
  stateInitialized: boolean;
}

export async function install(options: InstallOptions): Promise<InstallResult> {
  writeMcpEntry(options.mcpConfigPath);
  writeHookEntries(options.settingsPath);
  writeSlashCommand(options.commandsDir);
  const stateInitialized = initializeStateFile(options.statePath);
  const skillsResult = await installSkills({
    sourceDir: options.skillsSourceDir,
    targetDir: options.skillsTargetDir,
    ...(options.review !== undefined ? { review: options.review } : {}),
  });
  return {
    mcpEntryWritten: true,
    hookEntriesWritten: true,
    skillsInstalled: skillsResult.installed,
    skillsSkipped: skillsResult.skipped,
    slashCommandWritten: true,
    stateInitialized,
  };
}

/**
 * Write `<commandsDir>/e4d.md` with the canonical slash-command body.
 * Always overwrites — the body is deterministic, so a user who deleted
 * a line gets the canonical file back on re-install.
 */
function writeSlashCommand(commandsDir: string): void {
  mkdirSync(commandsDir, { recursive: true });
  const path = join(commandsDir, "e4d.md");
  writeFileSync(path, E4D_SLASH_COMMAND_BODY, "utf-8");
}

/**
 * If `statePath` does not exist, create it with the OFF default
 * `{enabled: false, toggled_at: null}` and return true. If it already
 * exists — corrupt or well-formed — leave it untouched and return
 * false. Rationale (per Phase 19 Group C task 2):
 *   - Overwriting a toggled-ON file would silently re-disable a user
 *     who opted in. Privacy-correct default is to preserve user state.
 *   - Overwriting a corrupt file would erase forensic evidence; the
 *     fail-closed reader treats corrupt-as-OFF anyway, so the user is
 *     no worse off (still OFF) but the corruption can be diagnosed.
 */
function initializeStateFile(statePath: string): boolean {
  if (existsSync(statePath)) {
    return false;
  }
  mkdirSync(dirname(statePath), { recursive: true });
  const body =
    JSON.stringify({ enabled: false, toggled_at: null }, null, 2) + "\n";
  writeFileSync(statePath, body, "utf-8");
  return true;
}

function writeMcpEntry(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const existing: { mcpServers?: Record<string, unknown> } = existsSync(
    configPath,
  )
    ? (JSON.parse(readFileSync(configPath, "utf-8")) as {
        mcpServers?: Record<string, unknown>;
      })
    : {};
  const merged = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      [ELEANOR_MCP_ENTRY_NAME]: ELEANOR_MCP_ENTRY,
    },
  };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

/**
 * Write the 4 eleanor4devs hook entries to ~/.claude/settings.json.
 *
 * Merge rules:
 *   - Other agents' hooks (different matcher) are preserved untouched.
 *   - Pre-existing eleanor4devs entries (matcher === "eleanor4devs") are
 *     REMOVED before adding the new ones, so re-runs are idempotent and
 *     stale commands don't pile up.
 *   - Hook events not produced by us (PreToolUse, PostToolUse, etc.)
 *     are left exactly as-is.
 */
function writeHookEntries(settingsPath: string): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const existing: { hooks?: Record<string, ClaudeHookEntry[]> } = existsSync(
    settingsPath,
  )
    ? (JSON.parse(readFileSync(settingsPath, "utf-8")) as {
        hooks?: Record<string, ClaudeHookEntry[]>;
      })
    : {};

  const existingHooks: Record<string, ClaudeHookEntry[]> =
    existing.hooks ?? {};
  const ourEntries = buildHookEntries();
  const mergedHooks: Record<string, ClaudeHookEntry[]> = {};

  // Start with every event the user already had — but strip any
  // eleanor4devs-owned entries from each event's list so we can add
  // fresh ones below.
  for (const [eventName, list] of Object.entries(existingHooks)) {
    mergedHooks[eventName] = list.filter(
      (e) => e.matcher !== ELEANOR_HOOK_MATCHER,
    );
  }

  // Append our entries, preserving other agents' entries in the same event.
  for (const [eventName, list] of Object.entries(ourEntries)) {
    const prior = mergedHooks[eventName] ?? [];
    mergedHooks[eventName] = [...prior, ...list];
  }

  const merged = {
    ...existing,
    hooks: mergedHooks,
  };
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}
