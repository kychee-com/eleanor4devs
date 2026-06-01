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
  isEleanorHookEntry,
  type ClaudeHookEntry,
} from "./hook_templates.js";

const ELEANOR_MCP_ENTRY_NAME = "eleanor4devs";

/** Canonical MCP-server entry shape that gets written to mcp_servers.json. */
const ELEANOR_MCP_ENTRY = {
  command: "npx",
  args: ["-y", "@eleanor4devs/mcp"],
};

/**
 * Canonical body of `~/.claude/commands/e4d.md` (Phase 23, [[DD-54]]).
 *
 * Claude Code reads slash-command markdown files from
 * `~/.claude/commands/<name>.md` and sends the BODY VERBATIM as the
 * assistant's prompt — with Claude-Code-level substitution of
 * `${CLAUDE_SESSION_ID}` to the current session's UUID at file-load
 * time (confirmed live via SPIKE A1 on 2026-05-31). The leading
 * `!command` bash-passthrough syntax works in INTERACTIVE chat input,
 * NOT inside slash command files — caught 2026-05-28 across two live
 * smokes where `!eleanor4devs toggle` arrived in the conversation as
 * literal text.
 *
 * The reliable pattern is a plain-language INSTRUCTION the assistant
 * executes via the Bash tool (granted by the `allowed-tools` line in
 * the frontmatter). `Bash(eleanor4devs:*)` narrowly scopes the
 * permission to just the eleanor4devs binary so this slash command
 * can't be repurposed to run arbitrary shell.
 *
 * The `--session ${CLAUDE_SESSION_ID}` flag is the Phase 23 per-session
 * mechanism: each session toggles independently, replacing the pre-
 * v0.14.0 machine-wide on/off that caused cross-session interference.
 *
 * The single source of truth for this file body lives here so install
 * + tests + future docs all reference the same string.
 */
export const E4D_SLASH_COMMAND_BODY =
  "---\n" +
  "description: Toggle Eleanor4Devs reporting for THIS session (ON / OFF)\n" +
  "allowed-tools: Bash(eleanor4devs:*)\n" +
  "---\n" +
  "Run `eleanor4devs toggle --session ${CLAUDE_SESSION_ID}` via the Bash " +
  "tool, then print ONLY the single stdout line it returned (either " +
  "`Eleanor4Devs is now ON for this session.` or `Eleanor4Devs is now OFF " +
  "for this session.`, possibly with a trailing parenthetical from the " +
  "backend such as `(✓ registered)` or `(not linked — run \\`eleanor4devs " +
  "auth\\`)` — include it verbatim). No commentary, no explanation, no " +
  "code block — just the raw line.\n";

/**
 * Canonical body of `~/.claude/commands/e4d-status.md` (Phase 21).
 *
 * Read-only counterpart to `/e4d`: it runs `eleanor4devs status` (which
 * NEVER changes state) and surfaces the reporting line + recent-sessions
 * table. Same proven Bash-tool-instruction pattern + narrowly-scoped
 * `allowed-tools` as `e4d.md`.
 */
export const E4D_STATUS_SLASH_COMMAND_BODY =
  "---\n" +
  "description: Show Eleanor4Devs status — reporting state + recent sessions (read-only)\n" +
  "allowed-tools: Bash(eleanor4devs:*)\n" +
  "---\n" +
  "Run this command via the Bash tool and print its full output verbatim:\n" +
  "`eleanor4devs status --session ${CLAUDE_SESSION_ID}`\n" +
  "It prints the machine link line + monitored count, the recent-sessions " +
  "table (all five states), and a final line stating whether THIS session " +
  "is monitored. This is READ-ONLY — it makes no state-changing backend " +
  "call and writes no audit entry. Do NOT toggle or change any state.\n";

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
  writeFileSync(join(commandsDir, "e4d.md"), E4D_SLASH_COMMAND_BODY, "utf-8");
  writeFileSync(
    join(commandsDir, "e4d-status.md"),
    E4D_STATUS_SLASH_COMMAND_BODY,
    "utf-8",
  );
}

/**
 * If `statePath` does not exist, create it with the empty v2 per-session
 * map `{version: 2, sessions: {}}` and return true. If it already exists —
 * corrupt or well-formed (v1 or v2) — leave it untouched and return false.
 * Rationale (Phase 23 [[DD-53]]):
 *   - Overwriting an existing v2 file would silently un-opt every session
 *     the user has currently opted in. Privacy-correct default is to
 *     preserve user state.
 *   - Overwriting a v1 file is the migration's job — `setSessionReporting`
 *     replaces it on the first write. Install does not pre-migrate.
 *   - Overwriting a corrupt file would erase forensic evidence; the
 *     fail-closed reader treats corrupt-as-OFF anyway.
 */
function initializeStateFile(statePath: string): boolean {
  if (existsSync(statePath)) {
    return false;
  }
  mkdirSync(dirname(statePath), { recursive: true });
  const body =
    JSON.stringify({ version: 2, sessions: {} }, null, 2) + "\n";
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
  // eleanor4devs-owned entries (identified by command prefix, or the
  // legacy "eleanor4devs" matcher from ≤v0.0.12) from each event's list
  // so we can add fresh ones below. Other agents' hooks are untouched.
  for (const [eventName, list] of Object.entries(existingHooks)) {
    mergedHooks[eventName] = list.filter((e) => !isEleanorHookEntry(e));
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
