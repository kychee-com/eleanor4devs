/**
 * Tests for the local audit log writer.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § audit log
 * + DD-13. JSONL format; one event per line. Local audit log fields:
 * timestamp, thread_id, event_type, payload_digest (NOT raw payload —
 * the digest is the credential-isolation boundary).
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 7 — Local audit log writer.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { LocalAuditLog } from "../src/audit_log.js";

function freshTmpPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "e4d-audit-"));
  return { dir, path: join(dir, "audit.log") };
}

describe("LocalAuditLog.append", () => {
  it("appends a single JSONL line with the 4 standard fields", () => {
    const { dir, path } = freshTmpPath();
    try {
      const log = new LocalAuditLog({ path });
      log.append({
        thread_id: "thread-7a1b",
        event_type: "report.progress",
        payload: { event: "progress", text: "Working..." },
      });

      const content = readFileSync(path, "utf-8");
      const lines = content.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      // The 4 fields from DD-13 must all be present.
      expect(entry).toHaveProperty("timestamp");
      expect(entry).toHaveProperty("thread_id", "thread-7a1b");
      expect(entry).toHaveProperty("event_type", "report.progress");
      expect(entry).toHaveProperty("payload_digest");
      // CRITICAL: raw payload must NOT be in the local audit log.
      // The digest is the credential-isolation boundary.
      expect(entry).not.toHaveProperty("payload");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("payload_digest is the sha256 hex of canonicalized JSON of the payload", () => {
    const { dir, path } = freshTmpPath();
    try {
      const log = new LocalAuditLog({ path });
      const payload = { event: "info", text: "Hello" };
      log.append({
        thread_id: "t-1",
        event_type: "report.info",
        payload,
      });
      const entry = JSON.parse(readFileSync(path, "utf-8").trim());
      // sha256 over the canonical JSON form of the payload. The test
      // computes the expected digest independently with node:crypto.
      const expected = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
      expect(entry.payload_digest).toBe(expected);
      // sha256-hex is always 64 lowercase hex chars.
      expect(entry.payload_digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends across multiple writes (does not overwrite previous lines)", () => {
    const { dir, path } = freshTmpPath();
    try {
      const log = new LocalAuditLog({ path });
      for (let i = 0; i < 3; i += 1) {
        log.append({
          thread_id: `t-${i}`,
          event_type: `report.progress`,
          payload: { event: "progress", n: i },
        });
      }
      const lines = readFileSync(path, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines).toHaveLength(3);
      const threadIds = lines.map((l) => JSON.parse(l).thread_id);
      expect(threadIds).toEqual(["t-0", "t-1", "t-2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LocalAuditLog offline-readability (Phase 8)", () => {
  // Pinning tests for the spec's "cat/grep/text-editor accessible without
  // Eleanor running" invariant. The format must stay standard NDJSON: each
  // line is independently parseable; values are JSON-escaped so embedded
  // newlines never break the line boundary; UTF-8 round-trips cleanly;
  // and a `grep <thread_id> audit.log` recovers exactly the entries that
  // contain that thread.

  it("each line of a multi-entry log parses independently as JSON", () => {
    const { dir, path } = freshTmpPath();
    try {
      const log = new LocalAuditLog({ path });
      const inputs = [
        { thread_id: "t-a", event_type: "report.progress", payload: { n: 1 } },
        { thread_id: "t-b", event_type: "report.done", payload: { n: 2 } },
        { thread_id: "t-c", event_type: "report.info", payload: { n: 3 } },
        { thread_id: "t-d", event_type: "report.error", payload: { n: 4 } },
        { thread_id: "t-e", event_type: "report.blocked", payload: { n: 5 } },
      ];
      for (const i of inputs) log.append(i);
      const lines = readFileSync(path, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines).toHaveLength(5);
      // Each line must parse on its own (no need to read the whole file).
      for (let i = 0; i < lines.length; i += 1) {
        const entry = JSON.parse(lines[i]);
        expect(entry.thread_id).toBe(inputs[i].thread_id);
        expect(entry.event_type).toBe(inputs[i].event_type);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("embedded newlines in field values do NOT break the NDJSON line boundary", () => {
    const { dir, path } = freshTmpPath();
    try {
      const log = new LocalAuditLog({ path });
      // Adversarial input: an event_type containing a real newline char.
      // JSON.stringify must escape it; the on-disk file must still have
      // exactly one logical entry per `\n`-delimited line.
      log.append({
        thread_id: "t-1",
        event_type: "report.error\ninjected_second_line",
        payload: { event: "error" },
      });
      const content = readFileSync(path, "utf-8");
      const lines = content.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      // The literal newline is preserved in the round-tripped value.
      expect(entry.event_type).toBe("report.error\ninjected_second_line");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("UTF-8 round-trip — non-ASCII characters survive write+read intact", () => {
    const { dir, path } = freshTmpPath();
    try {
      const log = new LocalAuditLog({ path });
      log.append({
        thread_id: "t-utf8-café",
        event_type: "report.info",
        payload: { event: "info", text: "naïve déjà vu — 日本語" },
      });
      const entry = JSON.parse(readFileSync(path, "utf-8").trim());
      expect(entry.thread_id).toBe("t-utf8-café");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("grep-able: substring search for a thread_id matches only that entry's line", () => {
    const { dir, path } = freshTmpPath();
    try {
      const log = new LocalAuditLog({ path });
      log.append({
        thread_id: "t-needle-abc123",
        event_type: "report.info",
        payload: { event: "info" },
      });
      log.append({
        thread_id: "t-haystack-other",
        event_type: "report.info",
        payload: { event: "info" },
      });
      log.append({
        thread_id: "t-haystack-yetanother",
        event_type: "report.info",
        payload: { event: "info" },
      });
      const content = readFileSync(path, "utf-8");
      const matchingLines = content
        .split("\n")
        .filter((l) => l.includes("t-needle-abc123"));
      expect(matchingLines).toHaveLength(1);
      const entry = JSON.parse(matchingLines[0]);
      expect(entry.thread_id).toBe("t-needle-abc123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LocalAuditLog path resolution", () => {
  it("resolves to ~/.eleanor4devs/audit.log when no path option is provided", () => {
    // The spec mandates ~/.eleanor4devs/audit.log as the canonical
    // local audit log location. Production callers should construct
    // with no options; tests inject explicit paths to avoid touching
    // the user's real home dir. Path is exposed as a readable
    // property so callers (and tests) can inspect where the log lives.
    const log = new LocalAuditLog();
    expect(log.path).toBe(join(homedir(), ".eleanor4devs", "audit.log"));
  });

  it("creates the parent directory on first append if it doesn't already exist", () => {
    // First-run scenario: the CLI has just installed and the
    // ~/.eleanor4devs directory doesn't exist yet. The audit log
    // writer must NOT crash with ENOENT — it should mkdir -p the
    // parent and write the line.
    const dir = mkdtempSync(join(tmpdir(), "e4d-audit-mkdir-"));
    const nestedPath = join(dir, "deeply", "nested", "audit.log");
    try {
      const log = new LocalAuditLog({ path: nestedPath });
      log.append({
        thread_id: "t-1",
        event_type: "report.info",
        payload: { event: "info" },
      });
      const content = readFileSync(nestedPath, "utf-8");
      expect(content.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
