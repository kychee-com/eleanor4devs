/**
 * Tests for `runOn / runOff / runToggle` (Phase 19, Group B).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control (acceptance lines 404-406, 408).
 *
 * Per [[DD-43]]: all three verbs are idempotent (calling `on` when
 * already ON still re-prints the state line and still appends an
 * audit-log entry — the spec promise is "every toggle event recorded").
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOn, runOff, runToggle } from "../src/commands/toggle.js";
import { readReportingState } from "../src/state.js";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-toggle-"));
}

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
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

describe("runOn — sets state to ON, prints, appends audit", () => {
  it("writes enabled=true and prints 'Eleanor4Devs is now ON.'", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const { lines, log } = makeLog();
      const code = await runOn({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:42:00.000Z"),
        log,
      });
      expect(code).toBe(0);
      expect(readReportingState({ statePath })).toEqual({
        enabled: true,
        toggledAt: "2026-05-28T15:42:00.000Z",
      });
      expect(lines).toEqual(["Eleanor4Devs is now ON."]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runOff — sets state to OFF, prints, appends audit", () => {
  it("writes enabled=false and prints 'Eleanor4Devs is now OFF.'", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const { lines, log } = makeLog();
      const code = await runOff({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:42:00.000Z"),
        log,
      });
      expect(code).toBe(0);
      expect(readReportingState({ statePath })).toEqual({
        enabled: false,
        toggledAt: "2026-05-28T15:42:00.000Z",
      });
      expect(lines).toEqual(["Eleanor4Devs is now OFF."]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runToggle — flips current state", () => {
  it("flips OFF → ON and prints 'Eleanor4Devs is now ON.'", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      // Seed state OFF first.
      await runOff({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:00:00.000Z"),
        log: () => {},
      });
      const { lines, log } = makeLog();
      const code = await runToggle({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:42:00.000Z"),
        log,
      });
      expect(code).toBe(0);
      expect(readReportingState({ statePath }).enabled).toBe(true);
      expect(lines).toEqual(["Eleanor4Devs is now ON."]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flips ON → OFF and prints 'Eleanor4Devs is now OFF.'", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      await runOn({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:00:00.000Z"),
        log: () => {},
      });
      const { lines, log } = makeLog();
      const code = await runToggle({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:42:00.000Z"),
        log,
      });
      expect(code).toBe(0);
      expect(readReportingState({ statePath }).enabled).toBe(false);
      expect(lines).toEqual(["Eleanor4Devs is now OFF."]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("on a missing state file (fail-closed → OFF), flips to ON", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      expect(existsSync(statePath)).toBe(false);
      const { lines, log } = makeLog();
      const code = await runToggle({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:42:00.000Z"),
        log,
      });
      expect(code).toBe(0);
      expect(readReportingState({ statePath }).enabled).toBe(true);
      expect(lines).toEqual(["Eleanor4Devs is now ON."]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("idempotence — per [[DD-43]]", () => {
  it("runOn then runOn produces two audit entries, both state:on, both print ON", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const { lines, log } = makeLog();
      await runOn({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:00:00.000Z"),
        log,
      });
      await runOn({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:42:00.000Z"),
        log,
      });
      expect(lines).toEqual([
        "Eleanor4Devs is now ON.",
        "Eleanor4Devs is now ON.",
      ]);
      const entries = readAuditEntries(auditLogPath);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ kind: "toggle", state: "on" });
      expect(entries[1]).toMatchObject({ kind: "toggle", state: "on" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runOff then runOff produces two audit entries, both state:off", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      await runOff({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:00:00.000Z"),
        log: () => {},
      });
      await runOff({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:42:00.000Z"),
        log: () => {},
      });
      const entries = readAuditEntries(auditLogPath);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ kind: "toggle", state: "off" });
      expect(entries[1]).toMatchObject({ kind: "toggle", state: "off" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("audit-log entry shape", () => {
  it("each entry has {ts, kind: 'toggle', state: 'on'|'off'} with ISO ts", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      await runOn({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:42:00.000Z"),
        log: () => {},
      });
      const entries = readAuditEntries(auditLogPath);
      expect(entries).toHaveLength(1);
      const e = entries[0]!;
      expect(e).toEqual({
        ts: "2026-05-28T15:42:00.000Z",
        kind: "toggle",
        state: "on",
      });
      // Ts parses as a valid Date.
      expect(Number.isNaN(new Date(e.ts as string).getTime())).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
