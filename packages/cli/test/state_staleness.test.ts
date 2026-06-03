/**
 * Tests for the local opt-in staleness API (Phase 26, Group C — [[DD-70]]).
 *
 * Spec v0.15.0 § Local Reporting Control + Data & Content ("Local reporting
 * opt-in record"):
 *   - Each per-session record gains a `last_seen_at` (last-activity timestamp),
 *     refreshed when a lifecycle hook fires for that session.
 *   - A record with no hook activity for the staleness window (default 72h,
 *     `ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS` — the SAME env as the backend sweep)
 *     is pruned on the next `eleanor4devs` invocation.
 *   - The local record is the reference count for hook registration: the four
 *     hooks de-register when the enabled count reaches 0.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 26, Group C.
 *
 * Contract:
 *   - `refreshLastSeen(sessionId, now, opts)` — DEBOUNCED: rewrites
 *     `last_seen_at` only when it would advance by more than the debounce
 *     interval (default 1h). No-op for an absent / not-enabled record.
 *   - `pruneStaleSessions(now, opts)` — drops every record whose effective
 *     activity time (`last_seen_at` ?? `toggled_at`) is older than the window;
 *     returns the count of ENABLED records remaining. Fail-closed: a missing /
 *     corrupt / v1 file prunes nothing and returns 0.
 *   - `countEnabledSessions(opts)` — count of `enabled:true` records; 0 on any
 *     read failure (fail-closed).
 *   - `setSessionReporting` PRESERVES a sibling record's `last_seen_at`.
 */
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countEnabledSessions,
  pruneStaleSessions,
  refreshLastSeen,
  setSessionReporting,
  readSessionReporting,
} from "../src/state.js";

const SID_A = "11111111-1111-1111-1111-111111111111";
const SID_B = "22222222-2222-2222-2222-222222222222";
const SID_C = "33333333-3333-3333-3333-333333333333";

/** Fixed reference epoch so every timestamp is wall-clock independent. */
const BASE = Date.parse("2026-06-01T00:00:00.000Z");
const HOUR_MS = 3600_000;
function at(offsetHours: number): Date {
  return new Date(BASE + offsetHours * HOUR_MS);
}
function iso(offsetHours: number): string {
  return at(offsetHours).toISOString();
}

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-state-staleness-"));
}

interface OnDiskRecord {
  enabled: boolean;
  toggled_at: string | null;
  last_seen_at?: string | null;
}

function writeV2(
  path: string,
  sessions: Record<string, OnDiskRecord>,
): void {
  writeFileSync(
    path,
    JSON.stringify({ version: 2, sessions }, null, 2) + "\n",
    "utf-8",
  );
}

function readRaw(path: string): Record<string, OnDiskRecord> {
  return (
    JSON.parse(readFileSync(path, "utf-8")) as {
      sessions: Record<string, OnDiskRecord>;
    }
  ).sessions;
}

// ---------------------------------------------------------------------------
// countEnabledSessions — the reference count, fail-closed.
// ---------------------------------------------------------------------------

describe("countEnabledSessions", () => {
  it("counts only enabled:true records (ignores enabled:false)", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeV2(path, {
        [SID_A]: { enabled: true, toggled_at: iso(0) },
        [SID_B]: { enabled: false, toggled_at: iso(0) },
        [SID_C]: { enabled: true, toggled_at: iso(0) },
      });
      expect(countEnabledSessions({ statePath: path })).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 for a missing file (fail-closed)", () => {
    const dir = freshTempDir();
    try {
      expect(
        countEnabledSessions({ statePath: join(dir, "nope.json") }),
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 for a corrupt file (fail-closed)", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(path, "not json {", "utf-8");
      expect(countEnabledSessions({ statePath: path })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 for a legacy v1 file (fail-closed — global enabled is never counted)", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(
        path,
        JSON.stringify({ enabled: true, toggled_at: iso(0) }),
        "utf-8",
      );
      expect(countEnabledSessions({ statePath: path })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// pruneStaleSessions — drop records older than the window, return enabled count.
// ---------------------------------------------------------------------------

describe("pruneStaleSessions", () => {
  it("drops a >window-dormant record and keeps a fresh one; returns remaining enabled count", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeV2(path, {
        [SID_A]: { enabled: true, toggled_at: iso(0) }, // 100h dormant
        [SID_B]: { enabled: true, toggled_at: iso(99) }, // 1h dormant
      });
      const remaining = pruneStaleSessions(at(100), {
        statePath: path,
        windowSeconds: 72 * 3600,
      });
      expect(remaining).toBe(1);
      expect(readSessionReporting(SID_A, { statePath: path }).enabled).toBe(
        false,
      );
      expect(readSessionReporting(SID_B, { statePath: path }).enabled).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses toggled_at for staleness when last_seen_at is absent", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      // No last_seen_at — toggled_at (100h ago) is the only timestamp.
      writeV2(path, {
        [SID_A]: { enabled: true, toggled_at: iso(0) },
      });
      const remaining = pruneStaleSessions(at(100), {
        statePath: path,
        windowSeconds: 72 * 3600,
      });
      expect(remaining).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers last_seen_at over toggled_at — a recently-seen record with an old toggle survives", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      // Toggled 100h ago but seen 1h ago → NOT stale under a 72h window.
      writeV2(path, {
        [SID_A]: {
          enabled: true,
          toggled_at: iso(0),
          last_seen_at: iso(99),
        },
      });
      const remaining = pruneStaleSessions(at(100), {
        statePath: path,
        windowSeconds: 72 * 3600,
      });
      expect(remaining).toBe(1);
      expect(readSessionReporting(SID_A, { statePath: path }).enabled).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts only ENABLED survivors — a fresh disabled record is kept but not counted", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeV2(path, {
        [SID_A]: { enabled: true, toggled_at: iso(99) },
        [SID_B]: { enabled: true, toggled_at: iso(99) },
        [SID_C]: { enabled: false, toggled_at: iso(99) },
      });
      const remaining = pruneStaleSessions(at(100), {
        statePath: path,
        windowSeconds: 72 * 3600,
      });
      expect(remaining).toBe(2);
      // The disabled record is fresh, so it is NOT pruned (still on disk).
      expect(readRaw(path)[SID_C]).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT rewrite the file when nothing is stale (byte-identical)", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeV2(path, {
        [SID_A]: { enabled: true, toggled_at: iso(99) },
      });
      const before = readFileSync(path, "utf-8");
      pruneStaleSessions(at(100), { statePath: path, windowSeconds: 72 * 3600 });
      expect(readFileSync(path, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 and creates no file for a missing state file (fail-closed)", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "nope.json");
      expect(
        pruneStaleSessions(at(100), { statePath: path, windowSeconds: 3600 }),
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS when windowSeconds is not passed", () => {
    const dir = freshTempDir();
    const prev = process.env.ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS;
    try {
      const path = join(dir, "state.json");
      writeV2(path, {
        [SID_A]: { enabled: true, toggled_at: iso(98) }, // 2h dormant
      });
      // Env window = 1h → the 2h-dormant record is stale.
      process.env.ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS = "3600";
      expect(pruneStaleSessions(at(100), { statePath: path })).toBe(0);
    } finally {
      if (prev === undefined) {
        delete process.env.ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS;
      } else {
        process.env.ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS = prev;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to the 72h window when neither windowSeconds nor env is set", () => {
    const dir = freshTempDir();
    const prev = process.env.ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS;
    try {
      const path = join(dir, "state.json");
      // 2h dormant — well within the default 72h, so it survives.
      writeV2(path, {
        [SID_A]: { enabled: true, toggled_at: iso(98) },
      });
      delete process.env.ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS;
      expect(pruneStaleSessions(at(100), { statePath: path })).toBe(1);
    } finally {
      if (prev !== undefined) {
        process.env.ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS = prev;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// refreshLastSeen — debounced last-activity stamp.
// ---------------------------------------------------------------------------

describe("refreshLastSeen", () => {
  it("stamps last_seen_at when the record has none and the toggle is older than the debounce", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      setSessionReporting(SID_A, true, { statePath: path, now: () => at(0) });
      // 2h after the toggle, beyond the 1h debounce → writes last_seen_at.
      refreshLastSeen(SID_A, at(2), { statePath: path, debounceSeconds: 3600 });
      expect(readRaw(path)[SID_A].last_seen_at).toBe(iso(2));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is DEBOUNCED — a second refresh within the interval does not rewrite the file", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      setSessionReporting(SID_A, true, { statePath: path, now: () => at(0) });
      refreshLastSeen(SID_A, at(2), { statePath: path, debounceSeconds: 3600 });
      const afterFirst = readFileSync(path, "utf-8");
      // 30 min later — within the 1h debounce of the last_seen_at just written.
      refreshLastSeen(SID_A, at(2.5), {
        statePath: path,
        debounceSeconds: 3600,
      });
      expect(readFileSync(path, "utf-8")).toBe(afterFirst);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advances last_seen_at again once the debounce interval has elapsed", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      setSessionReporting(SID_A, true, { statePath: path, now: () => at(0) });
      refreshLastSeen(SID_A, at(2), { statePath: path, debounceSeconds: 3600 });
      refreshLastSeen(SID_A, at(4), { statePath: path, debounceSeconds: 3600 });
      expect(readRaw(path)[SID_A].last_seen_at).toBe(iso(4));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op for a session that has no record (never creates one)", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      setSessionReporting(SID_A, true, { statePath: path, now: () => at(0) });
      const before = readFileSync(path, "utf-8");
      refreshLastSeen(SID_B, at(5), { statePath: path, debounceSeconds: 3600 });
      // SID_B was never opted in — refresh must not add it or rewrite the file.
      expect(readFileSync(path, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op for a not-enabled record (only live opt-ins are refreshed)", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeV2(path, {
        [SID_A]: { enabled: false, toggled_at: iso(0) },
      });
      const before = readFileSync(path, "utf-8");
      refreshLastSeen(SID_A, at(5), { statePath: path, debounceSeconds: 3600 });
      expect(readFileSync(path, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves sibling records when refreshing one session", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeV2(path, {
        [SID_A]: { enabled: true, toggled_at: iso(0) },
        [SID_B]: { enabled: true, toggled_at: iso(0), last_seen_at: iso(1) },
      });
      refreshLastSeen(SID_A, at(5), { statePath: path, debounceSeconds: 3600 });
      const raw = readRaw(path);
      expect(raw[SID_A].last_seen_at).toBe(iso(5));
      // SID_B untouched.
      expect(raw[SID_B].last_seen_at).toBe(iso(1));
      expect(raw[SID_B].enabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// setSessionReporting — sibling last_seen_at must survive a write of another id.
// ---------------------------------------------------------------------------

describe("setSessionReporting — last_seen_at preservation", () => {
  it("preserves a sibling's last_seen_at when setting a different session", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeV2(path, {
        [SID_A]: { enabled: true, toggled_at: iso(0), last_seen_at: iso(3) },
      });
      setSessionReporting(SID_B, true, { statePath: path, now: () => at(5) });
      const raw = readRaw(path);
      // SID_A's last_seen_at survived the write of SID_B.
      expect(raw[SID_A].last_seen_at).toBe(iso(3));
      expect(raw[SID_B].enabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
