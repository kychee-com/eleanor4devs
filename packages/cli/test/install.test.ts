/**
 * Tests for the `eleanor4devs install` command.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI. Writes
 * the MCP server entry into Claude Code's mcp_servers.json + installs
 * the Core Skills Pack. Merges with existing mcp_servers — never
 * clobbers other agents' entries.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 7 — CLI install.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { install } from "../src/commands/install.js";
import { ALWAYS_APPLY } from "../src/commands/install_skills.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGED_SKILLS = join(HERE, "..", "skills", "eleanor4devs");

function freshHomeDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-install-"));
}

describe("install — fresh install (no existing mcp_servers.json)", () => {
  it("creates mcp_servers.json with the eleanor4devs entry + installs Core Skills Pack", async () => {
    const home = freshHomeDir();
    const mcpConfigPath = join(home, ".claude", "mcp_servers.json");
    const settingsPath = join(home, ".claude", "settings.json");
    const skillsTargetDir = join(home, ".claude", "skills", "eleanor4devs");
    try {
      const result = await install({
        mcpConfigPath,
        settingsPath,
        skillsSourceDir: PACKAGED_SKILLS,
        skillsTargetDir,
        review: ALWAYS_APPLY,
      });
      expect(result.mcpEntryWritten).toBe(true);
      expect(result.skillsInstalled).toHaveLength(7);

      // The mcp_servers.json file now exists and contains the entry.
      expect(existsSync(mcpConfigPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
      expect(parsed.mcpServers.eleanor4devs).toMatchObject({
        command: expect.any(String),
        args: expect.any(Array),
      });

      // The 7 skills are on disk.
      expect(
        existsSync(join(skillsTargetDir, "eleanor4devs-pause-thread.md")),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("install — merge with existing mcp_servers.json", () => {
  it("preserves other agents' entries when adding the eleanor4devs entry", async () => {
    const home = freshHomeDir();
    const mcpConfigPath = join(home, ".claude", "mcp_servers.json");
    const settingsPath = join(home, ".claude", "settings.json");
    const skillsTargetDir = join(home, ".claude", "skills", "eleanor4devs");
    try {
      // Pre-existing mcp_servers.json with someone else's entry.
      mkdirSync(dirname(mcpConfigPath), { recursive: true });
      writeFileSync(
        mcpConfigPath,
        JSON.stringify(
          {
            mcpServers: {
              "some-other-agent": {
                command: "uvx",
                args: ["some-other-mcp"],
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await install({
        mcpConfigPath,
        settingsPath,
        skillsSourceDir: PACKAGED_SKILLS,
        skillsTargetDir,
        review: ALWAYS_APPLY,
      });

      const parsed = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
      // Pre-existing entry preserved unchanged.
      expect(parsed.mcpServers["some-other-agent"]).toEqual({
        command: "uvx",
        args: ["some-other-mcp"],
      });
      // New entry present alongside.
      expect(parsed.mcpServers.eleanor4devs).toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("updates the eleanor4devs entry in place when it already exists", async () => {
    const home = freshHomeDir();
    const mcpConfigPath = join(home, ".claude", "mcp_servers.json");
    const settingsPath = join(home, ".claude", "settings.json");
    const skillsTargetDir = join(home, ".claude", "skills", "eleanor4devs");
    try {
      mkdirSync(dirname(mcpConfigPath), { recursive: true });
      writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            eleanor4devs: { command: "old-command", args: ["legacy"] },
          },
        }),
        "utf-8",
      );

      await install({
        mcpConfigPath,
        settingsPath,
        skillsSourceDir: PACKAGED_SKILLS,
        skillsTargetDir,
        review: ALWAYS_APPLY,
      });

      const parsed = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
      // The eleanor4devs entry should now match the canonical shape,
      // not the old placeholder we wrote.
      expect(parsed.mcpServers.eleanor4devs.command).not.toBe("old-command");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
