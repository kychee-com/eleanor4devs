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
import { dirname } from "node:path";

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

export interface InstallOptions {
  /** Path to the agent's MCP config (e.g., ~/.claude/mcp_servers.json). */
  mcpConfigPath: string;
  /** Path to the agent's settings file (e.g., ~/.claude/settings.json) — hook templates land here. */
  settingsPath: string;
  /** Where the bundled skill markdowns live on disk. */
  skillsSourceDir: string;
  /** Where to write skills on the user's machine. */
  skillsTargetDir: string;
  /** Skill review hook. Defaults to ALWAYS_APPLY via installSkills. */
  review?: SkillReview;
}

export interface InstallResult {
  mcpEntryWritten: boolean;
  hookEntriesWritten: boolean;
  skillsInstalled: string[];
  skillsSkipped: string[];
}

export async function install(options: InstallOptions): Promise<InstallResult> {
  writeMcpEntry(options.mcpConfigPath);
  writeHookEntries(options.settingsPath);
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
  };
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
