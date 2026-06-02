/**
 * Tests for install's hook handling (Phase 26 — [[DD-69]], lazy registration).
 *
 * Spec v0.15.0 § Local Reporting Control + Auth & Reporting Pipeline:
 *   `eleanor4devs install` registers NO Claude Code hooks. Instead it PRUNES
 *   any stale eleanor4devs hook entries left in `~/.claude/settings.json` by a
 *   prior version (DD-64 hygiene), deleting any event key it empties and
 *   touching only eleanor4devs entries. The four lifecycle hooks are registered
 *   lazily by the first `/e4d` opt-in (see hook_registry.test.ts).
 *
 * Mapping (Eleanor logical hook → Claude Code event name) is unchanged:
 *   after_create → SessionStart, before_run → UserPromptSubmit,
 *   after_run → Stop, before_remove → SessionEnd.
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

import { install, type InstallOptions } from "../src/commands/install.js";
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

/** Build a complete InstallOptions for a fresh temp home. */
function baseOpts(home: string, settingsPath: string): InstallOptions {
  return {
    mcpConfigPath: join(home, ".claude", "mcp_servers.json"),
    settingsPath,
    skillsSourceDir: PACKAGED_SKILLS,
    skillsTargetDir: join(home, ".claude", "skills", "eleanor4devs"),
    commandsDir: join(home, ".claude", "commands"),
    statePath: join(home, ".eleanor4devs", "state.json"),
    review: ALWAYS_APPLY,
  };
}

/** Count eleanor4devs hook entries across every event (0 when no file). */
function e4dHookCount(settingsPath: string): number {
  if (!existsSync(settingsPath)) return 0;
  const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as ClaudeSettings;
  return Object.values(s.hooks ?? {})
    .flat()
    .filter((e) => isEleanorHookEntry(e)).length;
}

describe("install — prunes stale eleanor4devs hooks, registers none (Phase 26, DD-69)", () => {
  it("registers ZERO eleanor4devs hooks on a fresh install", async () => {
    const home = freshHomeDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      await install(baseOpts(home, settingsPath));
      expect(e4dHookCount(settingsPath)).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prunes pre-existing eleanor4devs hook entries (left by an earlier version) and deletes the emptied event keys", async () => {
    const home = freshHomeDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      // A machine upgraded from a build that registered hooks at install time:
      // all four eleanor4devs entries present (the canonical shape).
      writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: buildHookEntries() }),
        "utf-8",
      );

      await install(baseOpts(home, settingsPath));

      expect(e4dHookCount(settingsPath)).toBe(0);
      const s = JSON.parse(
        readFileSync(settingsPath, "utf-8"),
      ) as ClaudeSettings;
      // Each now-empty event key is removed entirely (not left as `[]`).
      for (const event of Object.values(ELEANOR_HOOK_EVENT_MAP)) {
        expect(s.hooks?.[event]).toBeUndefined();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prunes a legacy (≤v0.0.12, matcher='eleanor4devs') entry too", async () => {
    const home = freshHomeDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
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

      await install(baseOpts(home, settingsPath));

      expect(e4dHookCount(settingsPath)).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prunes eleanor4devs entries but preserves a foreign-agent entry in the same event", async () => {
    const home = freshHomeDir();
    const settingsPath = join(home, ".claude", "settings.json");
    const foreign = {
      matcher: "some-other-agent",
      hooks: [
        { type: "command", command: "other-agent-cli hook session-start" },
      ],
    };
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: { SessionStart: [foreign, ...buildHookEntries().SessionStart] },
        }),
        "utf-8",
      );

      await install(baseOpts(home, settingsPath));

      expect(e4dHookCount(settingsPath)).toBe(0);
      const s = JSON.parse(
        readFileSync(settingsPath, "utf-8"),
      ) as ClaudeSettings;
      // Foreign entry survives; its event key is NOT deleted (still populated).
      expect(s.hooks?.SessionStart).toEqual([foreign]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves a foreign-only settings.json byte-for-byte untouched (nothing to prune)", async () => {
    const home = freshHomeDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      const original = JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "x.sh" }] },
          ],
        },
      });
      writeFileSync(settingsPath, original, "utf-8");

      await install(baseOpts(home, settingsPath));

      // The prune is a no-op when there are no eleanor4devs entries — it must
      // not rewrite (or reformat) an unrelated settings file.
      expect(readFileSync(settingsPath, "utf-8")).toBe(original);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("re-install is idempotent — still zero eleanor4devs hooks", async () => {
    const home = freshHomeDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      await install(baseOpts(home, settingsPath));
      await install(baseOpts(home, settingsPath));
      expect(e4dHookCount(settingsPath)).toBe(0);
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
