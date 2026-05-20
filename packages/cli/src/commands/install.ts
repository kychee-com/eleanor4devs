/**
 * `eleanor4devs install` — the all-in-one onboarding command.
 *
 * 1. Writes the MCP server entry into `~/.claude/mcp_servers.json`
 *    (merging — never clobbering — any existing entries from other
 *    agents).
 * 2. Installs the Core Skills Pack via `installSkills` (which honors
 *    the skill-review-before-apply contract).
 *
 * Hook templates land in a follow-up — they currently belong to the
 * Provider Box phase (Phase 8 task "Claude Code hook templates").
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

const ELEANOR_MCP_ENTRY_NAME = "eleanor4devs";

/** Canonical MCP-server entry shape that gets written to mcp_servers.json. */
const ELEANOR_MCP_ENTRY = {
  command: "npx",
  args: ["-y", "@eleanor4devs/mcp"],
};

export interface InstallOptions {
  /** Path to the agent's MCP config (e.g., ~/.claude/mcp_servers.json). */
  mcpConfigPath: string;
  /** Where the bundled skill markdowns live on disk. */
  skillsSourceDir: string;
  /** Where to write skills on the user's machine. */
  skillsTargetDir: string;
  /** Skill review hook. Defaults to ALWAYS_APPLY via installSkills. */
  review?: SkillReview;
}

export interface InstallResult {
  mcpEntryWritten: boolean;
  skillsInstalled: string[];
  skillsSkipped: string[];
}

export async function install(options: InstallOptions): Promise<InstallResult> {
  writeMcpEntry(options.mcpConfigPath);
  const skillsResult = await installSkills({
    sourceDir: options.skillsSourceDir,
    targetDir: options.skillsTargetDir,
    ...(options.review !== undefined ? { review: options.review } : {}),
  });
  return {
    mcpEntryWritten: true,
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
