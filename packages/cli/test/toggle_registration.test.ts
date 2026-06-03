/**
 * Tests for `runToggle` lazy hook register/de-register wiring
 * (Phase 26, Group C — [[DD-69]] / [[DD-70]]).
 *
 * Spec v0.15.0 § Local Reporting Control:
 *   - The FIRST opt-in on a machine with no eleanor4devs hooks registers all
 *     four lifecycle hooks (idempotent — a second opt-in adds no duplicate).
 *   - Opting out the LAST opted-in session removes all four entries; while
 *     another session stays opted in, the hooks remain.
 *   - A stale (>window-dormant) sibling record is pruned at the toggle write
 *     path ([[DD-70]]); if that empties the enabled set, the hooks de-register.
 *   - A settings.json write failure is NON-FATAL: the local gate still flips
 *     and the audit line is still appended (privacy-monotonic).
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 26, Group C.
 *
 * These tests provide NO credential file, so the best-effort backend POST
 * short-circuits (not-linked) and never touches the network — the focus here
 * is the LOCAL settings.json mutation, which is independent of linking.
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

import { runToggle } from "../src/commands/toggle.js";
import {
  readSessionReporting,
  setSessionReporting,
} from "../src/state.js";
import { registerHooks } from "../src/commands/hook_registry.js";
import {
  ELEANOR_HOOK_EVENT_MAP,
  isEleanorHookEntry,
  type ClaudeHookEntry,
} from "../src/commands/hook_templates.js";

const SID_A = "11111111-1111-1111-1111-111111111111";
const SID_B = "22222222-2222-2222-2222-222222222222";
const BACKEND = "https://api.eleanor4devs.com";
const ALL_EVENTS = Object.values(ELEANOR_HOOK_EVENT_MAP);

const BASE = Date.parse("2026-06-01T00:00:00.000Z");
function at(offsetHours: number): Date {
  return new Date(BASE + offsetHours * 3600_000);
}
function iso(offsetHours: number): string {
  return at(offsetHours).toISOString();
}

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-toggle-reg-"));
}

interface Settings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  [k: string]: unknown;
}

function readSettings(p: string): Settings {
  return JSON.parse(readFileSync(p, "utf-8")) as Settings;
}

/** Count of e4d-owned entries under one event key. */
function ourCount(s: Settings, event: string): number {
  return (s.hooks?.[event] ?? []).filter((e) => isEleanorHookEntry(e)).length;
}

/** Total e4d entries across all events (0 when settings.json is absent). */
function totalEleanorEntries(settingsPath: string): number {
  if (!existsSync(settingsPath)) return 0;
  const s = readSettings(settingsPath);
  return ALL_EVENTS.reduce((n, ev) => n + ourCount(s, ev), 0);
}

function makeLog(): { lines: string[]; log: (text: string) => void } {
  const lines: string[] = [];
  return { lines, log: (text: string) => lines.push(text) };
}

function readAuditEntries(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface Paths {
  dir: string;
  statePath: string;
  auditLogPath: string;
  credentialsPath: string;
  settingsPath: string;
}

function paths(): Paths {
  const dir = freshTempDir();
  return {
    dir,
    statePath: join(dir, "state.json"),
    auditLogPath: join(dir, "audit.log"),
    credentialsPath: join(dir, "auth.json"), // intentionally absent
    settingsPath: join(dir, ".claude", "settings.json"),
  };
}

function baseOpts(p: Paths, sessionId: string, now: Date) {
  const { log } = makeLog();
  return {
    sessionId,
    statePath: p.statePath,
    auditLogPath: p.auditLogPath,
    credentialsPath: p.credentialsPath,
    settingsPath: p.settingsPath,
    backendUrl: BACKEND,
    now: () => now,
    log,
  };
}

// ---------------------------------------------------------------------------
// Opt-IN registers the four hooks (idempotently).
// ---------------------------------------------------------------------------

describe("runToggle — opt-IN registers hooks", () => {
  it("first opt-in on a zero-hook machine registers all 4 lifecycle entries", async () => {
    const p = paths();
    try {
      expect(totalEleanorEntries(p.settingsPath)).toBe(0);
      const code = await runToggle(baseOpts(p, SID_A, at(0)));
      expect(code).toBe(0);
      expect(readSessionReporting(SID_A, { statePath: p.statePath }).enabled).toBe(
        true,
      );
      const s = readSettings(p.settingsPath);
      for (const event of ALL_EVENTS) {
        expect(ourCount(s, event)).toBe(1);
      }
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("opting in a second session when already registered adds no duplicate", async () => {
    const p = paths();
    try {
      await runToggle(baseOpts(p, SID_A, at(0)));
      await runToggle(baseOpts(p, SID_B, at(1)));
      const s = readSettings(p.settingsPath);
      // Still exactly one e4d entry per event despite two opt-ins.
      for (const event of ALL_EVENTS) {
        expect(ourCount(s, event)).toBe(1);
      }
      expect(readSessionReporting(SID_A, { statePath: p.statePath }).enabled).toBe(
        true,
      );
      expect(readSessionReporting(SID_B, { statePath: p.statePath }).enabled).toBe(
        true,
      );
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Opt-OUT de-registers only when the last enabled session leaves.
// ---------------------------------------------------------------------------

describe("runToggle — opt-OUT de-registers on the last session", () => {
  it("opting out the ONLY enabled session removes all 4 entries", async () => {
    const p = paths();
    try {
      await runToggle(baseOpts(p, SID_A, at(0))); // opt-in → registers
      expect(totalEleanorEntries(p.settingsPath)).toBe(4);
      await runToggle(baseOpts(p, SID_A, at(1))); // opt-out → last one
      expect(readSessionReporting(SID_A, { statePath: p.statePath }).enabled).toBe(
        false,
      );
      expect(totalEleanorEntries(p.settingsPath)).toBe(0);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("opting out while another session stays enabled keeps the hooks", async () => {
    const p = paths();
    try {
      await runToggle(baseOpts(p, SID_A, at(0))); // opt-in
      await runToggle(baseOpts(p, SID_B, at(1))); // opt-in
      await runToggle(baseOpts(p, SID_A, at(2))); // opt-out A; B still on
      expect(readSessionReporting(SID_A, { statePath: p.statePath }).enabled).toBe(
        false,
      );
      expect(readSessionReporting(SID_B, { statePath: p.statePath }).enabled).toBe(
        true,
      );
      // Hooks remain because SID_B is still enabled.
      expect(totalEleanorEntries(p.settingsPath)).toBe(4);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("prunes a stale enabled sibling at opt-out and de-registers when that empties the set ([[DD-70]])", async () => {
    const p = paths();
    try {
      mkdirSync(join(p.dir, ".claude"), { recursive: true });
      // SID_A fresh+enabled (toggled at hour 100); SID_B enabled but dormant
      // since hour 0 (100h ago → stale under the default 72h window).
      writeFileSync(
        p.statePath,
        JSON.stringify({
          version: 2,
          sessions: {
            [SID_A]: { enabled: true, toggled_at: iso(100) },
            [SID_B]: { enabled: true, toggled_at: iso(0) },
          },
        }),
        "utf-8",
      );
      registerHooks(p.settingsPath);
      expect(totalEleanorEntries(p.settingsPath)).toBe(4);

      // Opt OUT SID_A at hour 100. After the flip, SID_A is disabled and the
      // stale SID_B is pruned → enabled count 0 → hooks de-register.
      await runToggle(baseOpts(p, SID_A, at(100)));

      expect(readSessionReporting(SID_A, { statePath: p.statePath }).enabled).toBe(
        false,
      );
      // SID_B was pruned (dormant >72h), so it reads as not-enabled too.
      expect(readSessionReporting(SID_B, { statePath: p.statePath }).enabled).toBe(
        false,
      );
      expect(totalEleanorEntries(p.settingsPath)).toBe(0);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A settings.json write failure is NON-FATAL.
// ---------------------------------------------------------------------------

describe("runToggle — settings mutator failure is non-fatal", () => {
  it("a thrown register error still flips the local gate, appends audit, exits 0", async () => {
    const p = paths();
    try {
      // Make the settings write path un-creatable: its parent is a regular
      // FILE, so registerHooks' mkdirSync throws deterministically.
      const blocker = join(p.dir, "blocker");
      writeFileSync(blocker, "x", "utf-8");
      const badSettingsPath = join(blocker, "settings.json");

      const { log } = makeLog();
      const code = await runToggle({
        sessionId: SID_A,
        statePath: p.statePath,
        auditLogPath: p.auditLogPath,
        credentialsPath: p.credentialsPath,
        settingsPath: badSettingsPath,
        backendUrl: BACKEND,
        now: () => at(0),
        log,
      });

      // Non-fatal: the toggle still succeeds.
      expect(code).toBe(0);
      // Local gate flipped despite the settings write failure.
      expect(readSessionReporting(SID_A, { statePath: p.statePath }).enabled).toBe(
        true,
      );
      // Audit line still written.
      const audit = readAuditEntries(p.auditLogPath);
      expect(audit).toHaveLength(1);
      expect((audit[0] as { state: string }).state).toBe("on");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Existing-session opt-OUT with NO prior hooks must not crash.
// ---------------------------------------------------------------------------

describe("runToggle — opt-OUT with no registered hooks is a clean no-op", () => {
  it("opting out the last session when settings.json never existed leaves it absent", async () => {
    const p = paths();
    try {
      // SID_A enabled in state but hooks were never registered (no settings.json).
      setSessionReporting(SID_A, true, {
        statePath: p.statePath,
        now: () => at(0),
      });
      const code = await runToggle(baseOpts(p, SID_A, at(1))); // opt-out
      expect(code).toBe(0);
      // deregister no-ops on an absent settings.json (never creates one).
      expect(existsSync(p.settingsPath)).toBe(false);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});
