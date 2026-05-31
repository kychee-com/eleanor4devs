/**
 * Tests for the per-session reporting-state API (Phase 23, [[DD-53]]).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control (v0.14.0 — per-session opt-in, acceptance lines 461-465).
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 23, Group A.
 *
 * Contract (per [[DD-53]]):
 *   - On-disk shape: `{version: 2, sessions: {<session_id>: {enabled, toggled_at}}}`.
 *   - Reader is FAIL-CLOSED: any read failure or unknown session_id →
 *     `{enabled: false, toggledAt: null}`.
 *   - Writer is ATOMIC: temp + rename.
 *   - v1 → v2 migration is READ-ONLY: a v1 file `{enabled, toggled_at}`
 *     on disk causes every session to read as not-enabled (privacy-safe);
 *     a global `enabled:true` is NEVER auto-applied to any session.
 *   - First `setSessionReporting` after a v1 file performs a fresh read
 *     of the disk shape and writes a clean v2 map containing only the
 *     session being set.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readSessionReporting,
  setSessionReporting,
} from "../src/state.js";

const SID_A = "11111111-1111-1111-1111-111111111111";
const SID_B = "22222222-2222-2222-2222-222222222222";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-state-session-"));
}

describe("readSessionReporting — fail-closed for every read failure mode", () => {
  it("returns {enabled: false, toggledAt: null} when the state file is missing", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      expect(existsSync(path)).toBe(false);
      expect(readSessionReporting(SID_A, { statePath: path })).toEqual({
        enabled: false,
        toggledAt: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns OFF default for non-JSON garbage", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(path, "not json", "utf-8");
      expect(readSessionReporting(SID_A, { statePath: path })).toEqual({
        enabled: false,
        toggledAt: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns OFF default when JSON root is an array", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(path, "[1,2,3]", "utf-8");
      expect(readSessionReporting(SID_A, { statePath: path })).toEqual({
        enabled: false,
        toggledAt: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns OFF for an unknown session_id even when the file has v2 data", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: 2,
          sessions: {
            [SID_A]: { enabled: true, toggled_at: "2026-05-30T10:00:00Z" },
          },
        }),
        "utf-8",
      );
      // SID_B was never opted in.
      expect(readSessionReporting(SID_B, { statePath: path })).toEqual({
        enabled: false,
        toggledAt: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns OFF default when a session's record has wrong types", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: 2,
          sessions: {
            [SID_A]: { enabled: "yes", toggled_at: 12345 },
          },
        }),
        "utf-8",
      );
      expect(readSessionReporting(SID_A, { statePath: path })).toEqual({
        enabled: false,
        toggledAt: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the correct {enabled, toggledAt} for a well-formed v2 session record", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: 2,
          sessions: {
            [SID_A]: { enabled: true, toggled_at: "2026-05-30T10:00:00Z" },
          },
        }),
        "utf-8",
      );
      expect(readSessionReporting(SID_A, { statePath: path })).toEqual({
        enabled: true,
        toggledAt: "2026-05-30T10:00:00Z",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isolates sessions — opting in SID_A does not enable SID_B", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      setSessionReporting(SID_A, true, {
        statePath: path,
        now: () => new Date("2026-05-30T10:00:00Z"),
      });
      expect(readSessionReporting(SID_A, { statePath: path }).enabled).toBe(
        true,
      );
      expect(readSessionReporting(SID_B, { statePath: path }).enabled).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("setSessionReporting — atomic write + round-trip", () => {
  it("round-trips a single-session set", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      setSessionReporting(SID_A, true, {
        statePath: path,
        now: () => new Date("2026-05-30T10:00:00Z"),
      });
      expect(readSessionReporting(SID_A, { statePath: path })).toEqual({
        enabled: true,
        toggledAt: "2026-05-30T10:00:00.000Z",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves other sessions when setting one", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      setSessionReporting(SID_A, true, {
        statePath: path,
        now: () => new Date("2026-05-30T10:00:00Z"),
      });
      setSessionReporting(SID_B, true, {
        statePath: path,
        now: () => new Date("2026-05-30T11:00:00Z"),
      });
      expect(readSessionReporting(SID_A, { statePath: path }).enabled).toBe(
        true,
      );
      expect(readSessionReporting(SID_B, { statePath: path }).enabled).toBe(
        true,
      );
      // Disk shape: both sessions present in the map.
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      expect(parsed.version).toBe(2);
      expect(Object.keys(parsed.sessions).sort()).toEqual([SID_A, SID_B]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-creates the parent directory when it doesn't exist", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "nested", "deep", "state.json");
      expect(existsSync(join(dir, "nested"))).toBe(false);
      setSessionReporting(SID_A, true, {
        statePath: path,
        now: () => new Date("2026-05-30T10:00:00Z"),
      });
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes atomically — no .tmp leftover after a successful write", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      setSessionReporting(SID_A, true, {
        statePath: path,
        now: () => new Date("2026-05-30T10:00:00Z"),
      });
      const siblings = readdirSync(dir);
      expect(siblings.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opting OUT updates toggled_at and persists the disabled state for that session", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      setSessionReporting(SID_A, true, {
        statePath: path,
        now: () => new Date("2026-05-30T10:00:00Z"),
      });
      setSessionReporting(SID_A, false, {
        statePath: path,
        now: () => new Date("2026-05-30T11:00:00Z"),
      });
      expect(readSessionReporting(SID_A, { statePath: path })).toEqual({
        enabled: false,
        toggledAt: "2026-05-30T11:00:00.000Z",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v1 → v2 migration — READ-ONLY, privacy-safe", () => {
  it("a v1 file with enabled:true does NOT auto-opt-in any session on read", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      // Legacy v1 shape — the global toggle. enabled:true was the kill switch.
      writeFileSync(
        path,
        JSON.stringify({ enabled: true, toggled_at: "2026-05-29T10:00:00Z" }),
        "utf-8",
      );
      // Every session must read as NOT enabled — a stale global ON must not
      // silently re-enable any session post-migration.
      expect(readSessionReporting(SID_A, { statePath: path }).enabled).toBe(
        false,
      );
      expect(readSessionReporting(SID_B, { statePath: path }).enabled).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reading a v1 file does NOT modify it on disk (read-only migration)", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      const v1Body = JSON.stringify({
        enabled: true,
        toggled_at: "2026-05-29T10:00:00Z",
      });
      writeFileSync(path, v1Body, "utf-8");
      const beforeMtime = readFileSync(path, "utf-8");
      readSessionReporting(SID_A, { statePath: path });
      readSessionReporting(SID_B, { statePath: path });
      const afterMtime = readFileSync(path, "utf-8");
      // Disk contents are byte-for-byte identical — no write happened.
      expect(afterMtime).toBe(beforeMtime);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the FIRST setSessionReporting after a v1 file replaces it with a clean v2 map", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(
        path,
        JSON.stringify({ enabled: true, toggled_at: "2026-05-29T10:00:00Z" }),
        "utf-8",
      );
      setSessionReporting(SID_A, true, {
        statePath: path,
        now: () => new Date("2026-05-30T10:00:00Z"),
      });
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      expect(parsed.version).toBe(2);
      // ONLY SID_A is in the map — v1's "global enabled:true" did NOT auto-
      // populate any other session.
      expect(Object.keys(parsed.sessions)).toEqual([SID_A]);
      expect(parsed.sessions[SID_A].enabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a v1 file with enabled:false also produces an empty v2 map on first write", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(
        path,
        JSON.stringify({ enabled: false, toggled_at: null }),
        "utf-8",
      );
      setSessionReporting(SID_A, true, {
        statePath: path,
        now: () => new Date("2026-05-30T10:00:00Z"),
      });
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      expect(parsed.version).toBe(2);
      expect(Object.keys(parsed.sessions)).toEqual([SID_A]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
