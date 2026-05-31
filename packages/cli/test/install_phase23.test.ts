/**
 * Phase 23 Group A install regression tests.
 *
 * Pins:
 *   - The `e4d.md` body uses the new per-session form
 *     `eleanor4devs toggle --session ${CLAUDE_SESSION_ID}`.
 *   - The body uses a Bash-tool INSTRUCTION pattern (NOT `!cmd`
 *     passthrough, which doesn't execute in command files —
 *     [[feedback_slash_command_bash_passthrough]]).
 *   - Fresh install initializes `state.json` to the v2 empty map.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control (v0.14.0).
 * Plan: docs/plans/eleanor4devs-plan.md Phase 23, Group A.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  E4D_SLASH_COMMAND_BODY,
  install,
} from "../src/commands/install.js";
import { ALWAYS_APPLY } from "../src/commands/install_skills.js";

function freshTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "e4d-install-p23-"));
  // Install reads skillsSourceDir — must exist (can be empty).
  mkdirSync(join(dir, "src-skills"), { recursive: true });
  return dir;
}

describe("Phase 23 — e4d.md slash-command body", () => {
  it("uses the per-session form `toggle --session ${CLAUDE_SESSION_ID}`", () => {
    expect(E4D_SLASH_COMMAND_BODY).toContain("--session ${CLAUDE_SESSION_ID}");
  });

  it("instructs via the Bash tool — NOT the `!cmd` passthrough form", () => {
    // The Bash-tool-instruction pattern reads like prose ("Run X via the
    // Bash tool"). The `!cmd` passthrough form ("`!eleanor4devs …`") is
    // interactive-only and would arrive in the conversation as literal
    // text — caught 2026-05-28 in a live smoke (see install.ts docstring).
    expect(E4D_SLASH_COMMAND_BODY.toLowerCase()).toContain("via the bash tool");
    expect(E4D_SLASH_COMMAND_BODY).not.toMatch(/`!eleanor4devs/);
    expect(E4D_SLASH_COMMAND_BODY).not.toMatch(/^!eleanor4devs/m);
  });

  it("scopes allowed-tools narrowly to the eleanor4devs binary", () => {
    expect(E4D_SLASH_COMMAND_BODY).toContain("allowed-tools: Bash(eleanor4devs:*)");
  });
});

describe("Phase 23 — fresh install writes the empty v2 per-session map", () => {
  it("fresh install creates state.json with `{version: 2, sessions: {}}`", async () => {
    const dir = freshTempDir();
    try {
      const result = await install({
        mcpConfigPath: join(dir, "mcp_servers.json"),
        settingsPath: join(dir, "settings.json"),
        skillsSourceDir: join(dir, "src-skills"),
        skillsTargetDir: join(dir, "dst-skills"),
        commandsDir: join(dir, "commands"),
        statePath: join(dir, "state.json"),
        review: ALWAYS_APPLY,
      });
      expect(result.stateInitialized).toBe(true);
      const parsed = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
      expect(parsed).toEqual({ version: 2, sessions: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-install does NOT clobber an existing per-session map", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const existing = {
        version: 2,
        sessions: {
          "abc-123": { enabled: true, toggled_at: "2026-05-31T10:00:00.000Z" },
        },
      };
      writeFileSync(statePath, JSON.stringify(existing, null, 2), "utf-8");
      const result = await install({
        mcpConfigPath: join(dir, "mcp_servers.json"),
        settingsPath: join(dir, "settings.json"),
        skillsSourceDir: join(dir, "src-skills"),
        skillsTargetDir: join(dir, "dst-skills"),
        commandsDir: join(dir, "commands"),
        statePath,
        review: ALWAYS_APPLY,
      });
      expect(result.stateInitialized).toBe(false);
      const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(parsed).toEqual(existing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-install does NOT clobber an existing v1 file (let migration handle it)", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      // Legacy v1 file from a pre-v0.14.0 install.
      const v1Body = JSON.stringify({
        enabled: true,
        toggled_at: "2026-05-29T10:00:00Z",
      });
      writeFileSync(statePath, v1Body, "utf-8");
      const result = await install({
        mcpConfigPath: join(dir, "mcp_servers.json"),
        settingsPath: join(dir, "settings.json"),
        skillsSourceDir: join(dir, "src-skills"),
        skillsTargetDir: join(dir, "dst-skills"),
        commandsDir: join(dir, "commands"),
        statePath,
        review: ALWAYS_APPLY,
      });
      expect(result.stateInitialized).toBe(false);
      // File untouched — the migration to v2 happens on the first
      // `setSessionReporting` call (per [[DD-53]] read-only migration).
      expect(readFileSync(statePath, "utf-8")).toBe(v1Body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Phase 23 — written e4d.md matches the canonical body", () => {
  it("install writes a commands/e4d.md whose contents == E4D_SLASH_COMMAND_BODY", async () => {
    const dir = freshTempDir();
    try {
      await install({
        mcpConfigPath: join(dir, "mcp_servers.json"),
        settingsPath: join(dir, "settings.json"),
        skillsSourceDir: join(dir, "src-skills"),
        skillsTargetDir: join(dir, "dst-skills"),
        commandsDir: join(dir, "commands"),
        statePath: join(dir, "state.json"),
        review: ALWAYS_APPLY,
      });
      const e4dPath = join(dir, "commands", "e4d.md");
      expect(existsSync(e4dPath)).toBe(true);
      expect(readFileSync(e4dPath, "utf-8")).toBe(E4D_SLASH_COMMAND_BODY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
