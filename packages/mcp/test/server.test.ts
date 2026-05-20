/**
 * Tests for @eleanor4devs/mcp — the single-verb MCP server surface.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § MCP. The MCP
 * server exposes ONE verb: `report({event, ...})`. Any other verb name
 * is rejected. The event field is itself a closed enum (progress,
 * done, blocked, context_warning, error, info, question). When the
 * event is "question", the report call blocks per DD-11 until
 * Eleanor's backend posts the user's decision back.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 7 Task 2.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "../src/index.js";
import { LocalAuditLog } from "../src/audit_log.js";

function freshAuditLog(): { dir: string; auditLog: LocalAuditLog; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "e4d-mcp-test-"));
  const path = join(dir, "audit.log");
  return { dir, auditLog: new LocalAuditLog({ path }), path };
}

describe("McpServer.call — verb whitelist (single-verb surface)", () => {
  it("returns an unknown_verb error for any verb name other than 'report'", async () => {
    const server = new McpServer();
    const result = await server.call("read_file", { path: "/etc/passwd" });
    expect(result).toEqual({
      error: {
        code: "unknown_verb",
        message: expect.stringContaining("read_file"),
      },
    });
  });
});

describe("McpServer.call('report', ...) — event enum validation", () => {
  it("returns unknown_event for an event name not in the closed enum", async () => {
    const server = new McpServer();
    const result = await server.call("report", { event: "ship_it" });
    expect(result).toEqual({
      error: {
        code: "unknown_event",
        message: expect.stringContaining("ship_it"),
      },
    });
  });

  it("accepts each of the 7 documented event types as a non-error response shape", async () => {
    // Locks the closed enum from the spec: progress, done, blocked,
    // context_warning, error, info, question. Any of these MUST NOT
    // come back as unknown_event. (The 'question' event is the only
    // one that blocks, asserted separately in cycle 3.)
    const server = new McpServer();
    const events: string[] = [
      "progress",
      "done",
      "blocked",
      "context_warning",
      "error",
      "info",
      // "question" is exercised in the blocking-semantics cycle.
    ];
    for (const event of events) {
      const result = await server.call("report", { event });
      expect(result).not.toMatchObject({
        error: { code: "unknown_event" },
      });
    }
  });
});

describe("McpServer — DD-11 blocking semantics for event='question'", () => {
  it("holds the report call open until postDecision is invoked for the same call_id", async () => {
    const server = new McpServer();
    let resolvedTo: unknown = "NOT_YET";

    // Kick off the report but DON'T await — capture the promise so we
    // can prove it's still pending across event-loop ticks.
    const reportPromise = server
      .call("report", {
        event: "question",
        call_id: "q-abc-123",
        text: "Permission to delete file?",
      })
      .then((r) => {
        resolvedTo = r;
        return r;
      });

    // Tick the microtask queue a couple of times. The report MUST
    // still be pending — no synthetic timeout, no early resolution.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(resolvedTo).toBe("NOT_YET");

    // Backend posts the decision. The blocked call wakes up.
    server.postDecision("q-abc-123", { decision: "approve" });
    const result = await reportPromise;
    expect(result).toEqual({ result: { decision: "approve" } });
  });

  it("does NOT block for non-question events (progress/done/blocked/etc. return immediately)", async () => {
    const server = new McpServer();
    // Race the report against a 50 ms timer. Any non-question event
    // must win the race — i.e., it returns before 50 ms.
    const sentinel = Symbol("timed_out");
    const winner = await Promise.race([
      server.call("report", { event: "progress" }),
      new Promise((resolve) => setTimeout(() => resolve(sentinel), 50)),
    ]);
    expect(winner).not.toBe(sentinel);
  });

  it("postDecision for an unknown call_id is a silent no-op (no crash, no error thrown)", async () => {
    // Edge case: backend posts a decision but the matching report is
    // already gone (timeout on backend side, race, etc.). Must not
    // crash the server process.
    const server = new McpServer();
    expect(() => server.postDecision("never-existed", { decision: "deny" })).not.toThrow();
  });
});

describe("McpServer.call('report', ...) — argument shape validation (credential isolation)", () => {
  // The "no new vector" principle: the MCP must not give the agent a
  // way to ask Eleanor's backend to read files, fetch URLs, or exec
  // shell commands. Even if Eleanor herself never honors them, the
  // mere presence of these keys in a `report` payload is a regression
  // signal — somebody, somewhere, is treating the MCP as a side-door
  // tool surface. Reject at the wire boundary.
  const forbiddenKeys = ["command", "path", "read", "write", "fetch"];

  for (const key of forbiddenKeys) {
    it(`rejects report payloads containing the '${key}' key with invalid_argument`, async () => {
      const server = new McpServer();
      const payload: Record<string, unknown> = { event: "info" };
      payload[key] = "anything-non-empty";
      const result = await server.call("report", payload);
      expect(result).toEqual({
        error: {
          code: "invalid_argument",
          message: expect.stringContaining(key),
        },
      });
    });
  }

  it("accepts a clean report payload with only safe fields", async () => {
    // The complement: a payload with no forbidden keys passes
    // validation. Locks the boundary at the forbidden-key set rather
    // than allow-listing every safe key.
    const server = new McpServer();
    const result = await server.call("report", {
      event: "info",
      text: "Hello",
      thread_id: "thread-7a1b",
    });
    expect(result).toMatchObject({ result: { accepted: true } });
  });
});

describe("McpServer — wire-level 1:1 audit logging (credential isolation)", () => {
  it("emits exactly one local audit log line per successful report call", async () => {
    const { dir, auditLog, path } = freshAuditLog();
    try {
      const server = new McpServer({ auditLog });
      await server.call("report", {
        event: "progress",
        thread_id: "thread-7a1b",
        text: "Working...",
      });
      const lines = readFileSync(path, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(entry).toMatchObject({
        thread_id: "thread-7a1b",
        event_type: "report.progress",
      });
      // Credential-isolation invariant: the line carries a digest,
      // NOT the raw payload contents.
      expect(entry).toHaveProperty("payload_digest");
      expect(entry).not.toHaveProperty("payload");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("audits rejected calls too (unknown_verb still emits one line)", async () => {
    // Rejections are interesting forensically — an agent attempting
    // an unknown verb might be a probing pattern worth surfacing.
    const { dir, auditLog, path } = freshAuditLog();
    try {
      const server = new McpServer({ auditLog });
      await server.call("read_file", { path: "/etc/passwd" });
      const lines = readFileSync(path, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      // The event_type captures the rejection so a grep over the log
      // surfaces the pattern without needing to decode the digest.
      expect(entry.event_type).toMatch(/^error\.unknown_verb/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits one line per call even for a blocking question event (logged at call entry)", async () => {
    // The DD-11 blocking path holds the response open, but the call
    // attempt itself must be audited at entry time so the local log
    // captures the question even if no decision ever arrives.
    const { dir, auditLog, path } = freshAuditLog();
    try {
      const server = new McpServer({ auditLog });
      const reportPromise = server.call("report", {
        event: "question",
        call_id: "q-1",
        thread_id: "thread-x",
        text: "Delete file?",
      });
      // Don't await the report — the question blocks. Audit line
      // should already be on disk.
      await new Promise((r) => setImmediate(r));
      const lines = readFileSync(path, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).event_type).toBe("report.question");
      // Resolve so the promise doesn't dangle past the test.
      server.postDecision("q-1", { decision: "deny" });
      await reportPromise;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
