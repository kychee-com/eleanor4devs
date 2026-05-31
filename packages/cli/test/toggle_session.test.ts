/**
 * Tests for `runToggle({sessionId, ...})` — the per-session opt-in/opt-out
 * verb that backs the `/e4d` slash command (Phase 23, Group A).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control (v0.14.0 — per-session, acceptance lines 461-465) +
 *   § Auth & Reporting Pipeline (lines 143-148).
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 23, Group A.
 *
 * Contract:
 *   - Reads / writes the per-session record in `state.json` via the new
 *     `readSessionReporting`/`setSessionReporting` API.
 *   - On opt-IN: POSTs `/hooks/opt-in` with bearer auth. On opt-OUT:
 *     POSTs `/hooks/disable`. Both are best-effort; the local gate
 *     ALWAYS flips, regardless of network outcome (privacy-monotonic).
 *   - Audit log entry per toggle: `{ts, kind: "toggle", session_id, state}`.
 *   - `${CLAUDE_SESSION_ID}` literal validator: an unsubstituted template
 *     value exits non-zero with a clear error, no state mutation.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runToggle } from "../src/commands/toggle.js";
import { readSessionReporting } from "../src/state.js";

const SID_A = "11111111-1111-1111-1111-111111111111";
const SID_B = "22222222-2222-2222-2222-222222222222";
const BACKEND = "https://api.eleanor4devs.com";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-toggle-session-"));
}

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

function makeLog(): { lines: string[]; log: (text: string) => void } {
  const lines: string[] = [];
  return { lines, log: (text: string) => lines.push(text) };
}

function makeWarn(): { warnings: string[]; warn: (text: string) => void } {
  const warnings: string[] = [];
  return { warnings, warn: (text: string) => warnings.push(text) };
}

function readAuditEntries(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeCred(path: string, refresh: string): void {
  writeFileSync(path, JSON.stringify({ refresh_token: refresh }), "utf-8");
}

function makeFetch(
  routes: Record<string, (req: { url: string; init?: RequestInit }) => Response>,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const opts = init !== undefined ? { url, init } : { url };
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.endsWith(pattern)) return handler(opts);
    }
    throw new Error(`no mock route for ${url}`);
  }) as typeof globalThis.fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Happy paths — opt-in and opt-out flip local state + POST + audit.
// ---------------------------------------------------------------------------

describe("runToggle — opt-IN on a fresh session", () => {
  it("flips local state to ON, POSTs /hooks/opt-in, prints ON, appends audit", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      const { lines, log } = makeLog();
      const calls: string[] = [];
      const fetch = makeFetch({
        "/auth/refresh": () => {
          calls.push("/auth/refresh");
          return jsonResponse(200, { access_token: "at-xyz" });
        },
        "/hooks/opt-in": ({ init }) => {
          calls.push("/hooks/opt-in");
          const body = JSON.parse(String(init?.body ?? "{}"));
          expect(body.session_id).toBe(SID_A);
          return jsonResponse(200, { registered: true, thread_id: "tid-1" });
        },
      });
      const code = await runToggle({
        sessionId: SID_A,
        statePath,
        auditLogPath,
        credentialsPath,
        backendUrl: BACKEND,
        now: fixedNow("2026-05-31T10:00:00.000Z"),
        log,
        fetch,
      });
      expect(code).toBe(0);
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(true);
      expect(calls).toEqual(["/auth/refresh", "/hooks/opt-in"]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("Eleanor4Devs is now ON for this session.");
      const audit = readAuditEntries(auditLogPath);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toEqual({
        ts: "2026-05-31T10:00:00.000Z",
        kind: "toggle",
        session_id: SID_A,
        state: "on",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runToggle — opt-OUT on an already-ON session", () => {
  it("flips local state to OFF, POSTs /hooks/disable, prints OFF, appends audit", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      // Pre-existing ON state.
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 2,
          sessions: {
            [SID_A]: { enabled: true, toggled_at: "2026-05-30T10:00:00.000Z" },
          },
        }),
        "utf-8",
      );
      const { lines, log } = makeLog();
      const calls: string[] = [];
      const fetch = makeFetch({
        "/auth/refresh": () => {
          calls.push("/auth/refresh");
          return jsonResponse(200, { access_token: "at-xyz" });
        },
        "/hooks/disable": ({ init }) => {
          calls.push("/hooks/disable");
          const body = JSON.parse(String(init?.body ?? "{}"));
          expect(body.session_id).toBe(SID_A);
          return jsonResponse(200, { disabled: true });
        },
      });
      const code = await runToggle({
        sessionId: SID_A,
        statePath,
        auditLogPath,
        credentialsPath,
        backendUrl: BACKEND,
        now: fixedNow("2026-05-31T11:00:00.000Z"),
        log,
        fetch,
      });
      expect(code).toBe(0);
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(false);
      expect(calls).toEqual(["/auth/refresh", "/hooks/disable"]);
      expect(lines[0]).toContain("Eleanor4Devs is now OFF for this session.");
      const audit = readAuditEntries(auditLogPath);
      expect(audit).toHaveLength(1);
      expect((audit[0] as { state: string }).state).toBe("off");
      expect((audit[0] as { session_id: string }).session_id).toBe(SID_A);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Session isolation — flipping one session never touches another.
// ---------------------------------------------------------------------------

describe("runToggle — session isolation", () => {
  it("two different --session ids produce two distinct, correctly-keyed records", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      const { log } = makeLog();
      const fetch = makeFetch({
        "/auth/refresh": () => jsonResponse(200, { access_token: "at" }),
        "/hooks/opt-in": () => jsonResponse(200, { registered: true }),
      });
      await runToggle({
        sessionId: SID_A,
        statePath,
        auditLogPath,
        credentialsPath,
        backendUrl: BACKEND,
        now: fixedNow("2026-05-31T10:00:00.000Z"),
        log,
        fetch,
      });
      await runToggle({
        sessionId: SID_B,
        statePath,
        auditLogPath,
        credentialsPath,
        backendUrl: BACKEND,
        now: fixedNow("2026-05-31T11:00:00.000Z"),
        log,
        fetch,
      });
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(true);
      expect(readSessionReporting(SID_B, { statePath }).enabled).toBe(true);
      const audit = readAuditEntries(auditLogPath);
      expect(audit).toHaveLength(2);
      const sids = audit.map((e) => (e as { session_id: string }).session_id);
      expect(sids).toEqual([SID_A, SID_B]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Not-linked path — opt-IN on an unlinked machine surfaces guidance.
// ---------------------------------------------------------------------------

describe("runToggle — not-linked machine", () => {
  it("opt-IN with no credential → state still flips locally + not-linked note printed", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      // No credential file written.
      const { lines, log } = makeLog();
      let fetchCalled = false;
      const fetch = (async () => {
        fetchCalled = true;
        return jsonResponse(500, {});
      }) as typeof globalThis.fetch;
      const code = await runToggle({
        sessionId: SID_A,
        statePath,
        auditLogPath,
        credentialsPath,
        backendUrl: BACKEND,
        now: fixedNow("2026-05-31T10:00:00.000Z"),
        log,
        fetch,
      });
      expect(code).toBe(0);
      // Network was NOT touched because credential read returned null.
      expect(fetchCalled).toBe(false);
      // Local state still flipped — the user's intent always wins locally.
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(true);
      // The state line includes a not-linked hint so the user knows.
      expect(lines[0]).toContain("ON");
      expect(lines[0].toLowerCase()).toContain("not linked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opt-IN with refresh 401 → state flips + not-linked note printed", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-revoked");
      const { lines, log } = makeLog();
      const fetch = makeFetch({
        "/auth/refresh": () => jsonResponse(401, { error: "revoked" }),
      });
      await runToggle({
        sessionId: SID_A,
        statePath,
        auditLogPath,
        credentialsPath,
        backendUrl: BACKEND,
        now: fixedNow("2026-05-31T10:00:00.000Z"),
        log,
        fetch,
      });
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(true);
      expect(lines[0].toLowerCase()).toContain("not linked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Privacy-monotonic — opt-OUT always flips local gate, even on backend errors.
// ---------------------------------------------------------------------------

describe("runToggle — privacy-monotonic opt-OUT", () => {
  it("opt-OUT with backend 5xx still flips local gate", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 2,
          sessions: {
            [SID_A]: { enabled: true, toggled_at: "2026-05-30T10:00:00.000Z" },
          },
        }),
        "utf-8",
      );
      const { log } = makeLog();
      const fetch = makeFetch({
        "/auth/refresh": () => jsonResponse(200, { access_token: "at" }),
        "/hooks/disable": () => jsonResponse(503, { error: "server down" }),
      });
      const code = await runToggle({
        sessionId: SID_A,
        statePath,
        auditLogPath,
        credentialsPath,
        backendUrl: BACKEND,
        now: fixedNow("2026-05-31T11:00:00.000Z"),
        log,
        fetch,
      });
      expect(code).toBe(0);
      // Privacy-monotonic: opt-OUT is sacred. Local gate flips no matter what.
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opt-OUT with backend 404 (endpoint not deployed yet) flips local gate, no error exit", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 2,
          sessions: {
            [SID_A]: { enabled: true, toggled_at: "2026-05-30T10:00:00.000Z" },
          },
        }),
        "utf-8",
      );
      const { log } = makeLog();
      const fetch = makeFetch({
        "/auth/refresh": () => jsonResponse(200, { access_token: "at" }),
        "/hooks/disable": () => jsonResponse(404, { error: "not found" }),
      });
      const code = await runToggle({
        sessionId: SID_A,
        statePath,
        auditLogPath,
        credentialsPath,
        backendUrl: BACKEND,
        now: fixedNow("2026-05-31T11:00:00.000Z"),
        log,
        fetch,
      });
      expect(code).toBe(0);
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// `${CLAUDE_SESSION_ID}` literal validator — fail loud on unsubstituted templates.
// ---------------------------------------------------------------------------

describe("runToggle — ${CLAUDE_SESSION_ID} literal validator", () => {
  it("--session ${CLAUDE_SESSION_ID} (literal, unsubstituted) → exits non-zero, no mutation", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      const { lines, log } = makeLog();
      const { warnings, warn } = makeWarn();
      let fetchCalled = false;
      const fetch = (async () => {
        fetchCalled = true;
        return jsonResponse(200, {});
      }) as typeof globalThis.fetch;
      const code = await runToggle({
        sessionId: "${CLAUDE_SESSION_ID}",
        statePath,
        auditLogPath,
        credentialsPath,
        backendUrl: BACKEND,
        now: fixedNow("2026-05-31T10:00:00.000Z"),
        log,
        warn,
        fetch,
      });
      expect(code).not.toBe(0);
      // No state file written (no mutation).
      expect(existsSync(statePath)).toBe(false);
      // No POST attempted.
      expect(fetchCalled).toBe(false);
      // No state line printed; only a stderr warning.
      expect(lines).toEqual([]);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].toLowerCase()).toContain("unsubstituted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--session value starting with ${ → exits non-zero", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      const { log } = makeLog();
      const { warn } = makeWarn();
      const code = await runToggle({
        sessionId: "${SOME_OTHER_TEMPLATE}",
        statePath,
        auditLogPath,
        credentialsPath,
        backendUrl: BACKEND,
        log,
        warn,
      });
      expect(code).not.toBe(0);
      expect(existsSync(statePath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency — same toggle twice still appends an audit line each time.
// ---------------------------------------------------------------------------

describe("runToggle — idempotency", () => {
  it("toggling the same session twice in a row flips ON→OFF→ON, 2 audit entries", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      const { log } = makeLog();
      const fetch = makeFetch({
        "/auth/refresh": () => jsonResponse(200, { access_token: "at" }),
        "/hooks/opt-in": () => jsonResponse(200, { registered: true }),
        "/hooks/disable": () => jsonResponse(200, { disabled: true }),
      });
      await runToggle({
        sessionId: SID_A,
        statePath,
        auditLogPath,
        credentialsPath,
        backendUrl: BACKEND,
        now: fixedNow("2026-05-31T10:00:00.000Z"),
        log,
        fetch,
      });
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(true);
      await runToggle({
        sessionId: SID_A,
        statePath,
        auditLogPath,
        credentialsPath,
        backendUrl: BACKEND,
        now: fixedNow("2026-05-31T11:00:00.000Z"),
        log,
        fetch,
      });
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(false);
      const audit = readAuditEntries(auditLogPath);
      expect(audit).toHaveLength(2);
      expect(audit.map((e) => (e as { state: string }).state)).toEqual([
        "on",
        "off",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
