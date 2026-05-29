/**
 * Tests for hook-template installation (Phase 8 — Claude Local Box).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Provider Boxes:
 *   "Hook lifecycle (per Symphony pattern #4) — `after_create / before_run
 *   / after_run / before_remove` with `timeout_ms` and explicit failure
 *   semantics (`after_create` fatal; `after_run` logged-and-ignored)."
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 8 — "Claude Code hook
 * templates: `after_create / before_run / after_run / before_remove`;
 * written by `eleanor4devs install` to user's `~/.claude/settings.json`".
 *
 * Mapping (Eleanor logical hook → Claude Code event name):
 *   after_create   → SessionStart
 *   before_run     → UserPromptSubmit
 *   after_run      → Stop
 *   before_remove  → SessionEnd
 *
 * The 4 hook entries are written to `~/.claude/settings.json` under the
 * `hooks` key. The install MUST merge — existing entries from other agents
 * are preserved, and an existing eleanor4devs entry is replaced in place
 * (not duplicated).
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { install } from "../src/commands/install.js";
import { ALWAYS_APPLY } from "../src/commands/install_skills.js";
import {
  ELEANOR_HOOK_EVENT_MAP,
  ELEANOR_HOOK_MATCHER,
  LEGACY_ELEANOR_HOOK_MATCHER,
  buildHookEntries,
  isEleanorHookEntry,
} from "../src/commands/hook_templates.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGED_SKILLS = join(HERE, "..", "skills", "eleanor4devs");

function freshHomeDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-install-hooks-"));
}

interface ClaudeSettings {
  mcpServers?: Record<string, unknown>;
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      hooks: Array<{ type: string; command: string }>;
    }>
  >;
}

describe("install — Claude Code hook templates", () => {
  it("writes the 4 hook entries (after_create/before_run/after_run/before_remove) to settings.json on fresh install", async () => {
    const home = freshHomeDir();
    const mcpConfigPath = join(home, ".claude", "mcp_servers.json");
    const settingsPath = join(home, ".claude", "settings.json");
    const skillsTargetDir = join(home, ".claude", "skills", "eleanor4devs");
    try {
      await install({
        mcpConfigPath,
        settingsPath,
        skillsSourceDir: PACKAGED_SKILLS,
        skillsTargetDir,
        commandsDir: join(home, ".claude", "commands"),
        statePath: join(home, ".eleanor4devs", "state.json"),
        review: ALWAYS_APPLY,
      });

      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(
        readFileSync(settingsPath, "utf-8"),
      ) as ClaudeSettings;
      expect(settings.hooks).toBeDefined();
      // All 4 Claude Code event names that Eleanor's logical hooks map to.
      for (const [, claudeEvent] of Object.entries(ELEANOR_HOOK_EVENT_MAP)) {
        const entries = settings.hooks?.[claudeEvent] ?? [];
        expect(entries.length).toBeGreaterThan(0);
        // Exactly one of them must be ours, identified by command prefix.
        const ours = entries.filter((e) => isEleanorHookEntry(e));
        expect(ours).toHaveLength(1);
        // The hook must shell out to the eleanor4devs CLI.
        expect(ours[0]!.hooks).toHaveLength(1);
        expect(ours[0]!.hooks[0]!.type).toBe("command");
        expect(ours[0]!.hooks[0]!.command).toMatch(/eleanor4devs hook /);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves existing hooks from other agents when merging", async () => {
    const home = freshHomeDir();
    const mcpConfigPath = join(home, ".claude", "mcp_servers.json");
    const settingsPath = join(home, ".claude", "settings.json");
    const skillsTargetDir = join(home, ".claude", "skills", "eleanor4devs");
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: "some-other-agent",
                hooks: [
                  {
                    type: "command",
                    command: "other-agent-cli hook session-start",
                  },
                ],
              },
            ],
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  { type: "command", command: "user-pre-bash-hook.sh" },
                ],
              },
            ],
          },
        }),
        "utf-8",
      );

      await install({
        mcpConfigPath,
        settingsPath,
        skillsSourceDir: PACKAGED_SKILLS,
        skillsTargetDir,
        commandsDir: join(home, ".claude", "commands"),
        statePath: join(home, ".eleanor4devs", "state.json"),
        review: ALWAYS_APPLY,
      });

      const settings = JSON.parse(
        readFileSync(settingsPath, "utf-8"),
      ) as ClaudeSettings;

      // Pre-existing entries preserved.
      const sessionStart = settings.hooks?.SessionStart ?? [];
      const other = sessionStart.find((e) => e.matcher === "some-other-agent");
      expect(other).toBeDefined();
      expect(other!.hooks[0]!.command).toBe(
        "other-agent-cli hook session-start",
      );

      // Pre-existing PreToolUse entry (untouched event) survives intact.
      expect(settings.hooks?.PreToolUse).toEqual([
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "user-pre-bash-hook.sh" }],
        },
      ]);

      // Our entries are present alongside.
      const ours = sessionStart.find((e) => isEleanorHookEntry(e));
      expect(ours).toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("replaces an existing eleanor4devs hook entry in place (no duplicates on re-install)", async () => {
    const home = freshHomeDir();
    const mcpConfigPath = join(home, ".claude", "mcp_servers.json");
    const settingsPath = join(home, ".claude", "settings.json");
    const skillsTargetDir = join(home, ".claude", "skills", "eleanor4devs");
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      // Pre-existing LEGACY (≤v0.0.12) eleanor4devs entry: the broken
      // matcher "eleanor4devs" + an older command shape. Re-install must
      // detect + remove it (via the legacy-matcher branch of
      // isEleanorHookEntry) and replace it with the corrected entry.
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: LEGACY_ELEANOR_HOOK_MATCHER,
                hooks: [
                  {
                    type: "command",
                    command: "old-eleanor4devs-binary hook after_create",
                  },
                ],
              },
            ],
          },
        }),
        "utf-8",
      );

      // First install.
      await install({
        mcpConfigPath,
        settingsPath,
        skillsSourceDir: PACKAGED_SKILLS,
        skillsTargetDir,
        commandsDir: join(home, ".claude", "commands"),
        statePath: join(home, ".eleanor4devs", "state.json"),
        review: ALWAYS_APPLY,
      });

      // Second install (idempotent re-run).
      await install({
        mcpConfigPath,
        settingsPath,
        skillsSourceDir: PACKAGED_SKILLS,
        skillsTargetDir,
        commandsDir: join(home, ".claude", "commands"),
        statePath: join(home, ".eleanor4devs", "state.json"),
        review: ALWAYS_APPLY,
      });

      const settings = JSON.parse(
        readFileSync(settingsPath, "utf-8"),
      ) as ClaudeSettings;
      const ours = (settings.hooks?.SessionStart ?? []).filter((e) =>
        isEleanorHookEntry(e),
      );
      // Exactly one eleanor4devs entry, despite running install twice
      // and starting from a pre-existing stale (legacy-matcher) entry.
      expect(ours).toHaveLength(1);
      // And the broken legacy matcher is gone — replaced with match-all "".
      expect(ours[0]!.matcher).toBe("");
      // The command was upgraded from the old binary name.
      expect(ours[0]!.hooks[0]!.command).not.toMatch(/old-eleanor4devs-binary/);
      expect(ours[0]!.hooks[0]!.command).toMatch(/eleanor4devs hook /);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("creates a settings.json that is valid JSON and round-trips through JSON.parse", async () => {
    const home = freshHomeDir();
    const mcpConfigPath = join(home, ".claude", "mcp_servers.json");
    const settingsPath = join(home, ".claude", "settings.json");
    const skillsTargetDir = join(home, ".claude", "skills", "eleanor4devs");
    try {
      await install({
        mcpConfigPath,
        settingsPath,
        skillsSourceDir: PACKAGED_SKILLS,
        skillsTargetDir,
        commandsDir: join(home, ".claude", "commands"),
        statePath: join(home, ".eleanor4devs", "state.json"),
        review: ALWAYS_APPLY,
      });
      const raw = readFileSync(settingsPath, "utf-8");
      // JSON.parse alone is the test — any syntax errors throw.
      const parsed = JSON.parse(raw) as ClaudeSettings;
      expect(parsed.hooks).toBeDefined();
      // Trailing newline is present (matches mcp_servers.json convention).
      expect(raw.endsWith("\n")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("buildHookEntries — canonical hook template shape", () => {
  it("produces exactly 4 logical hooks (after_create, before_run, after_run, before_remove)", () => {
    const entries = buildHookEntries();
    expect(Object.keys(entries).sort()).toEqual(
      ["SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"].sort(),
    );
  });

  it("each Claude Code event entry uses the match-all matcher and a `command` typed hook", () => {
    const entries = buildHookEntries();
    for (const [, list] of Object.entries(entries)) {
      expect(list).toHaveLength(1);
      const [entry] = list;
      expect(entry!.matcher).toBe(ELEANOR_HOOK_MATCHER);
      expect(entry!.hooks).toHaveLength(1);
      expect(entry!.hooks[0]!.type).toBe("command");
    }
  });

  it("REGRESSION (v0.0.13): SessionStart/SessionEnd matcher is NOT 'eleanor4devs' — that matched no session source so the hook never fired", () => {
    const entries = buildHookEntries();
    // The match-all matcher is the empty string; the legacy "eleanor4devs"
    // matcher silently disabled SessionStart + SessionEnd.
    expect(ELEANOR_HOOK_MATCHER).toBe("");
    for (const event of ["SessionStart", "SessionEnd"] as const) {
      const m = entries[event]![0]!.matcher;
      expect(m).not.toBe("eleanor4devs");
      expect(m === "" || m === "*").toBe(true);
    }
  });

  it("each entry's command invokes `eleanor4devs hook <logical-name>` with the right mapping", () => {
    const entries = buildHookEntries();
    expect(entries.SessionStart![0]!.hooks[0]!.command).toContain(
      "eleanor4devs hook after_create",
    );
    expect(entries.UserPromptSubmit![0]!.hooks[0]!.command).toContain(
      "eleanor4devs hook before_run",
    );
    expect(entries.Stop![0]!.hooks[0]!.command).toContain(
      "eleanor4devs hook after_run",
    );
    expect(entries.SessionEnd![0]!.hooks[0]!.command).toContain(
      "eleanor4devs hook before_remove",
    );
  });

  it("hook command is a single-line shell-safe string (cross-platform, no embedded newlines)", () => {
    const entries = buildHookEntries();
    for (const [, list] of Object.entries(entries)) {
      for (const entry of list) {
        for (const hook of entry.hooks) {
          expect(hook.command).not.toContain("\n");
          expect(hook.command).not.toContain("\r");
        }
      }
    }
  });
});
