/**
 * Tests for `packages/cli/src/audit.ts` — the shared JSONL audit-log
 * writer (Phase 19, Group F).
 *
 * Format pinned by [[DD-13]]: one JSON object per line, newline-
 * delimited, no array wrapper, no trailing comma.
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

import { appendAuditEntry } from "../src/audit.js";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-audit-"));
}

describe("appendAuditEntry", () => {
  it("appends one JSONL entry that round-trips through JSON.parse", () => {
    const dir = freshTempDir();
    try {
      const auditLogPath = join(dir, "audit.log");
      const entry = {
        ts: "2026-05-28T15:42:00Z",
        kind: "toggle",
        state: "on",
      };
      appendAuditEntry(entry, { auditLogPath });
      const body = readFileSync(auditLogPath, "utf-8");
      const lines = body.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual(entry);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends a second entry without overwriting the first", () => {
    const dir = freshTempDir();
    try {
      const auditLogPath = join(dir, "audit.log");
      appendAuditEntry(
        { ts: "2026-05-28T15:42:00Z", kind: "toggle", state: "on" },
        { auditLogPath },
      );
      appendAuditEntry(
        { ts: "2026-05-28T16:00:00Z", kind: "toggle", state: "off" },
        { auditLogPath },
      );
      const lines = readFileSync(auditLogPath, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).state).toBe("on");
      expect(JSON.parse(lines[1]!).state).toBe("off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("each line is independently parseable as JSON (JSONL contract — no array wrapper)", () => {
    const dir = freshTempDir();
    try {
      const auditLogPath = join(dir, "audit.log");
      for (let i = 0; i < 5; i++) {
        appendAuditEntry(
          { ts: `2026-05-28T15:00:0${i}Z`, kind: "toggle", state: "on" },
          { auditLogPath },
        );
      }
      const body = readFileSync(auditLogPath, "utf-8");
      // No array wrapper (no leading `[`, no trailing `]`).
      expect(body.startsWith("[")).toBe(false);
      expect(body.trimEnd().endsWith("]")).toBe(false);
      // No trailing comma — every non-empty line is valid JSON in
      // isolation.
      for (const line of body.split("\n").filter((l) => l.length > 0)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-creates the parent directory when missing", () => {
    const dir = freshTempDir();
    try {
      const auditLogPath = join(dir, "nested", "deep", "audit.log");
      expect(existsSync(join(dir, "nested"))).toBe(false);
      appendAuditEntry(
        { ts: "2026-05-28T15:42:00Z", kind: "toggle", state: "on" },
        { auditLogPath },
      );
      expect(existsSync(auditLogPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
