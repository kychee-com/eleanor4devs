/**
 * Robustness tests (Phase 19, Group F task 2): when the audit-log
 * append fails (EACCES, ENOSPC, locked file...), the toggle verb MUST
 * STILL persist the state and STILL print the new state line on stdout.
 * The verb emits a stderr warning and returns 0.
 *
 * Rationale: a locked / unwritable audit log must never prevent the
 * user from changing their reporting state — that would leave the user
 * stuck in whatever state the audit log went unwritable in.
 */
import { describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOn, runOff, runToggle } from "../src/commands/toggle.js";
import { readReportingState } from "../src/state.js";
import * as audit from "../src/audit.js";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-toggle-robust-"));
}

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

function captureLog(): { lines: string[]; log: (text: string) => void } {
  const lines: string[] = [];
  return { lines, log: (text: string) => lines.push(text) };
}

function captureWarn(): { lines: string[]; warn: (text: string) => void } {
  const lines: string[] = [];
  return { lines, warn: (text: string) => lines.push(text) };
}

function makeAuditMock(): () => void {
  const spy = vi
    .spyOn(audit, "appendAuditEntry")
    .mockImplementation(() => {
      const err = new Error("EACCES: permission denied (simulated)");
      throw err;
    });
  return () => spy.mockRestore();
}

describe("toggle robustness — audit-log append failures (Phase 19 Group F)", () => {
  it("runOn: state file IS written, stdout IS printed, stderr warns, exit 0", async () => {
    const dir = freshTempDir();
    const restore = makeAuditMock();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const { lines: stdoutLines, log } = captureLog();
      const { lines: stderrLines, warn } = captureWarn();
      const code = await runOn({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:42:00.000Z"),
        log,
        warn,
      });
      expect(code).toBe(0);
      expect(stdoutLines).toEqual(["Eleanor4Devs is now ON."]);
      expect(stderrLines.some((l) => /audit log append failed/.test(l))).toBe(
        true,
      );
      expect(readReportingState({ statePath }).enabled).toBe(true);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runOff: same observable behavior (state persisted, stdout printed, stderr warn, exit 0)", async () => {
    const dir = freshTempDir();
    const restore = makeAuditMock();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const { lines: stdoutLines, log } = captureLog();
      const { lines: stderrLines, warn } = captureWarn();
      const code = await runOff({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:42:00.000Z"),
        log,
        warn,
      });
      expect(code).toBe(0);
      expect(stdoutLines).toEqual(["Eleanor4Devs is now OFF."]);
      expect(stderrLines.some((l) => /audit log append failed/.test(l))).toBe(
        true,
      );
      expect(readReportingState({ statePath }).enabled).toBe(false);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runToggle: same observable behavior", async () => {
    const dir = freshTempDir();
    const restore = makeAuditMock();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const { lines: stdoutLines, log } = captureLog();
      const { lines: stderrLines, warn } = captureWarn();
      const code = await runToggle({
        statePath,
        auditLogPath,
        now: fixedNow("2026-05-28T15:42:00.000Z"),
        log,
        warn,
      });
      expect(code).toBe(0);
      // Fresh state (no file) → fail-closed OFF → flipped to ON.
      expect(stdoutLines).toEqual(["Eleanor4Devs is now ON."]);
      expect(stderrLines.some((l) => /audit log append failed/.test(l))).toBe(
        true,
      );
      expect(readReportingState({ statePath }).enabled).toBe(true);
      // The audit log was never written (mock threw).
      expect(existsSync(auditLogPath)).toBe(false);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
