/**
 * Tests for lazy hook registration (Phase 26 — [[DD-69]]).
 *
 * Spec v0.15.0 § Local Reporting Control + Auth & Reporting Pipeline:
 *   `eleanor4devs install` registers ZERO Claude Code hooks; the first `/e4d`
 *   on registers the four lifecycle hooks; the last opt-out (or the 72h local
 *   staleness prune) de-registers them. So a never-opted-in machine carries
 *   zero eleanor4devs hook entries.
 *
 * This module owns the shared, symlink-aware ([[DD-64]]), atomic settings.json
 * mutator that backs both the toggle (register/deregister) and the install
 * prune. The two operations:
 *   registerHooks(settingsPath)   — idempotent: 4 entries present, no dupes.
 *   deregisterHooks(settingsPath) — remove every e4d entry + clean emptied keys.
 *
 * DD-64 hazard under test: a naive temp+rename over a SYMLINKED settings.json
 * would replace the symlink with a regular file, breaking a dotfile-repo
 * setup. The registrar must resolve the symlink and write THROUGH it.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { dirname, join } from "node:path";

import {
  deregisterHooks,
  registerHooks,
  stripEleanorHookEntries,
} from "../src/commands/hook_registry.js";
import {
  ELEANOR_HOOK_EVENT_MAP,
  type ClaudeHookEntry,
  isEleanorHookEntry,
} from "../src/commands/hook_templates.js";

const ALL_EVENTS = Object.values(ELEANOR_HOOK_EVENT_MAP);

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-hook-registry-"));
}

interface Settings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  [k: string]: unknown;
}

function readSettings(p: string): Settings {
  return JSON.parse(readFileSync(p, "utf-8")) as Settings;
}

function ourCount(s: Settings, event: string): number {
  return (s.hooks?.[event] ?? []).filter((e) => isEleanorHookEntry(e)).length;
}

const FOREIGN: ClaudeHookEntry = {
  matcher: "some-other-agent",
  hooks: [{ type: "command", command: "other-agent-cli hook session-start" }],
};

describe("registerHooks", () => {
  it("writes the 4 e4d entries to an absent settings.json", () => {
    const home = freshDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      registerHooks(settingsPath);
      expect(existsSync(settingsPath)).toBe(true);
      const s = readSettings(settingsPath);
      for (const event of ALL_EVENTS) {
        expect(ourCount(s, event)).toBe(1);
      }
      // The four entries shell out to the eleanor4devs CLI.
      expect(s.hooks?.SessionStart?.[0]?.hooks[0]?.command).toMatch(
        /eleanor4devs hook /,
      );
      // Trailing newline (matches the project's JSON-write convention).
      expect(readFileSync(settingsPath, "utf-8").endsWith("\n")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is idempotent — registering twice yields exactly one e4d entry per event", () => {
    const home = freshDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      registerHooks(settingsPath);
      registerHooks(settingsPath);
      const s = readSettings(settingsPath);
      for (const event of ALL_EVENTS) {
        expect(ourCount(s, event)).toBe(1);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves a foreign-agent entry in the same event", () => {
    const home = freshDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: { SessionStart: [FOREIGN] } }),
        "utf-8",
      );
      registerHooks(settingsPath);
      const s = readSettings(settingsPath);
      // Foreign entry survives.
      expect(
        s.hooks?.SessionStart?.some((e) => e.matcher === "some-other-agent"),
      ).toBe(true);
      // Plus exactly one of ours.
      expect(ourCount(s, "SessionStart")).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves non-hook settings keys untouched", () => {
    const home = freshDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({ model: "opus", hooks: {} }),
        "utf-8",
      );
      registerHooks(settingsPath);
      const s = readSettings(settingsPath);
      expect(s.model).toBe("opus");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("deregisterHooks", () => {
  it("removes all 4 e4d entries and deletes the emptied event keys", () => {
    const home = freshDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      registerHooks(settingsPath);
      deregisterHooks(settingsPath);
      const s = readSettings(settingsPath);
      for (const event of ALL_EVENTS) {
        // No e4d entry AND the now-empty event key is gone entirely.
        expect(s.hooks?.[event]).toBeUndefined();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves foreign entries and only removes e4d", () => {
    const home = freshDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [FOREIGN],
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "x.sh" }] },
            ],
          },
        }),
        "utf-8",
      );
      registerHooks(settingsPath);
      deregisterHooks(settingsPath);
      const s = readSettings(settingsPath);
      // Foreign SessionStart entry survives; the e4d one is gone.
      expect(s.hooks?.SessionStart).toEqual([FOREIGN]);
      expect(ourCount(s, "SessionStart")).toBe(0);
      // Untouched event survives intact.
      expect(s.hooks?.PreToolUse).toEqual([
        { matcher: "Bash", hooks: [{ type: "command", command: "x.sh" }] },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is a no-op (no rewrite) when no e4d entries are present", () => {
    const home = freshDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      const original = JSON.stringify({ hooks: { SessionStart: [FOREIGN] } });
      writeFileSync(settingsPath, original, "utf-8");
      deregisterHooks(settingsPath);
      // Byte-for-byte unchanged — deregister must not reformat an unrelated file.
      expect(readFileSync(settingsPath, "utf-8")).toBe(original);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is a no-op on an absent settings.json (never creates one)", () => {
    const home = freshDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      deregisterHooks(settingsPath);
      expect(existsSync(settingsPath)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("round-trip register→deregister returns to the original entry set", () => {
    const home = freshDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: { SessionStart: [FOREIGN] } }, null, 2) + "\n",
        "utf-8",
      );
      registerHooks(settingsPath);
      deregisterHooks(settingsPath);
      const s = readSettings(settingsPath);
      // Only the foreign entry remains; no leftover e4d entries.
      expect(s.hooks?.SessionStart).toEqual([FOREIGN]);
      for (const event of ALL_EVENTS) {
        expect(ourCount(s, event)).toBe(0);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("stripEleanorHookEntries (shared prune predicate)", () => {
  it("deletes an event key whose only entry was e4d", () => {
    const home = freshDir();
    const settingsPath = join(home, ".claude", "settings.json");
    try {
      registerHooks(settingsPath);
      const s = readSettings(settingsPath);
      const stripped = stripEleanorHookEntries(s.hooks ?? {});
      // Every event was e4d-only → all keys gone.
      expect(Object.keys(stripped)).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps an event key that still has a foreign entry", () => {
    const stripped = stripEleanorHookEntries({
      SessionStart: [
        FOREIGN,
        { matcher: "", hooks: [{ type: "command", command: "eleanor4devs hook after_create" }] },
      ],
    });
    expect(stripped.SessionStart).toEqual([FOREIGN]);
  });

  it("is a no-op on a hooks map with no e4d entries", () => {
    const input = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" as const, command: "x.sh" }] }] };
    expect(stripEleanorHookEntries(input)).toEqual(input);
  });
});

// Symlink creation needs admin on Windows — skip there (matches the existing
// install-hygiene convention). The DD-64 hazard is POSIX-relevant anyway.
describe.skipIf(platform() === "win32")("symlink-aware write (DD-64)", () => {
  it("writes THROUGH a symlinked settings.json without destroying the symlink", () => {
    const home = freshDir();
    try {
      const realDir = join(home, "real");
      const linkDir = join(home, ".claude");
      mkdirSync(realDir, { recursive: true });
      mkdirSync(linkDir, { recursive: true });
      const realFile = join(realDir, "settings.json");
      writeFileSync(realFile, JSON.stringify({ hooks: {} }), "utf-8");
      const linkPath = join(linkDir, "settings.json");
      symlinkSync(realFile, linkPath);

      registerHooks(linkPath);

      // The symlink is STILL a symlink (not clobbered into a regular file).
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      // And the real file received the hooks.
      const s = JSON.parse(readFileSync(realFile, "utf-8")) as Settings;
      expect(ourCount(s, "SessionStart")).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
