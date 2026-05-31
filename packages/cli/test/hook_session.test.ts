/**
 * Tests for `runHook` per-session gating + disabled-cache local half
 * (Phase 23, Group A — DD-53 / DD-60).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control (lines 461-465) + § Auth & Reporting Pipeline.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 23, Group A.
 *
 * Replaces the Phase 19/20 global-toggle gate. Each hook now:
 *   1. Parses session_id from stdin.
 *   2. Calls readSessionReporting(session_id) — not-opted-in → exit 0,
 *      NO network call (the cross-session interference fix).
 *   3. For opted-in sessions: same auth + POST + visible-feedback flow
 *      as before.
 *   4. If the backend response carries `{registered:false, reason:"disabled"}`,
 *      locally caches that session as disabled (setSessionReporting(false))
 *      so the NEXT hook for that session no-ops without a round-trip.
 *      The disable-cache write is wrapped in try/catch — disk failure
 *      never aborts the hook.
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

import { runHook } from "../src/commands/hook.js";
import {
  readSessionReporting,
  setSessionReporting,
} from "../src/state.js";

const SID_A = "11111111-1111-1111-1111-111111111111";
const SID_B = "22222222-2222-2222-2222-222222222222";
const BACKEND = "https://api.eleanor4devs.com";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-hook-session-"));
}

function writeCred(path: string, refresh: string): void {
  writeFileSync(path, JSON.stringify({ refresh_token: refresh }), "utf-8");
}

function readAuditEntries(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makeFetch(
  routes: Record<string, (req: { url: string; init?: RequestInit }) => Response>,
): { fn: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push(url);
    const optsArg = init !== undefined ? { url, init } : { url };
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.endsWith(pattern)) return handler(optsArg);
    }
    throw new Error(`no mock route for ${url}`);
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const FIXED_NOW = "2026-05-31T10:00:00.000Z";

// ---------------------------------------------------------------------------
// Per-session gate — the interference fix.
// ---------------------------------------------------------------------------

describe("runHook — per-session gate (interference fix)", () => {
  it("for a not-opted-in session: NO network call, exits ok, no audit", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      // SID_A is NOT in state.json.
      const { fn: fetch, calls } = makeFetch({});
      const result = await runHook({
        hookName: "before_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A, foo: "bar" }),
        statePath,
        credentialsPath,
        auditLogPath,
        fetch,
      });
      expect(result.ok).toBe(true);
      expect(result.fatal).toBe(false);
      expect(calls).toEqual([]);
      expect(existsSync(auditLogPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session isolation: SID_A opted in, SID_B's hook no-ops", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      setSessionReporting(SID_A, true, {
        statePath,
        now: () => new Date(FIXED_NOW),
      });
      const { fn: fetch, calls } = makeFetch({});
      // SID_B is NOT opted in — its hook must no-op.
      const result = await runHook({
        hookName: "before_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_B }),
        statePath,
        credentialsPath,
        auditLogPath,
        fetch,
      });
      expect(result.ok).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("all four hook events no-op for a not-opted-in session", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      const { fn: fetch, calls } = makeFetch({});
      for (const hookName of [
        "after_create",
        "before_run",
        "after_run",
        "before_remove",
      ] as const) {
        const result = await runHook({
          hookName,
          backendUrl: BACKEND,
          stdinJson: JSON.stringify({ session_id: SID_A }),
          statePath,
          credentialsPath,
          auditLogPath,
          fetch,
        });
        expect(result.ok).toBe(true);
        expect(result.fatal).toBe(false);
      }
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opted-in session: full POST flow runs (refresh + /hooks/<event>)", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      setSessionReporting(SID_A, true, {
        statePath,
        now: () => new Date(FIXED_NOW),
      });
      const { fn: fetch, calls } = makeFetch({
        "/auth/refresh": () => jsonResponse(200, { access_token: "at" }),
        "/hooks/before_run": () => jsonResponse(200, { registered: true }),
      });
      const result = await runHook({
        hookName: "before_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A, foo: "bar" }),
        statePath,
        credentialsPath,
        auditLogPath,
        fetch,
      });
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain("/auth/refresh");
      expect(calls[1]).toContain("/hooks/before_run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Missing session_id → fail-closed (treat as not-opted-in).
// ---------------------------------------------------------------------------

describe("runHook — missing session_id in stdin", () => {
  it("payload with no session_id → no network, audit entry, exit ok", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      const { fn: fetch, calls } = makeFetch({});
      const result = await runHook({
        hookName: "before_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ foo: "bar" }), // no session_id
        statePath,
        credentialsPath,
        auditLogPath,
        fetch,
      });
      expect(result.ok).toBe(true);
      expect(result.fatal).toBe(false);
      expect(calls).toEqual([]);
      const audit = readAuditEntries(auditLogPath);
      expect(audit).toHaveLength(1);
      expect((audit[0] as { kind: string }).kind).toBe("hook_error");
      expect(String((audit[0] as { reason: string }).reason)).toMatch(
        /missing_session_id/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Disabled-cache local half (DD-60 — backend tells CLI "disabled" → cache it).
// ---------------------------------------------------------------------------

describe("runHook — disabled-cache local half", () => {
  it("backend response {registered:false, reason:'disabled'} → next hook for that session no-ops", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      setSessionReporting(SID_A, true, {
        statePath,
        now: () => new Date(FIXED_NOW),
      });
      const { fn: fetch, calls } = makeFetch({
        "/auth/refresh": () => jsonResponse(200, { access_token: "at" }),
        "/hooks/before_run": () =>
          jsonResponse(200, { registered: false, reason: "disabled" }),
      });
      // First hook: gets the disabled response from backend.
      await runHook({
        hookName: "before_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        credentialsPath,
        auditLogPath,
        fetch,
      });
      // Local state should now be disabled for SID_A.
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(false);
      // Second hook for the same session: no further network calls.
      const before = calls.length;
      await runHook({
        hookName: "after_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        credentialsPath,
        auditLogPath,
        fetch,
      });
      expect(calls.length).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backend response {registered:false, reason:'orphan'} does NOT flip local gate", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      setSessionReporting(SID_A, true, {
        statePath,
        now: () => new Date(FIXED_NOW),
      });
      const { fn: fetch } = makeFetch({
        "/auth/refresh": () => jsonResponse(200, { access_token: "at" }),
        "/hooks/before_run": () =>
          jsonResponse(200, { registered: false, reason: "orphan" }),
      });
      await runHook({
        hookName: "before_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        credentialsPath,
        auditLogPath,
        fetch,
      });
      // ONLY reason="disabled" flips the local gate. orphan/other → leave it.
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Non-fatal invariant — even with broken disk, hook never throws.
// ---------------------------------------------------------------------------

describe("runHook — non-fatal invariant", () => {
  it("a missing credential for an opted-in session → not-linked guidance, exit ok", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      // No credential file.
      setSessionReporting(SID_A, true, {
        statePath,
        now: () => new Date(FIXED_NOW),
      });
      const { fn: fetch, calls } = makeFetch({});
      const result = await runHook({
        hookName: "after_create",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        credentialsPath,
        auditLogPath,
        fetch,
      });
      expect(result.ok).toBe(true);
      expect(result.fatal).toBe(false);
      expect(result.userMessage).toMatch(/isn't linked|not linked/);
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a 401 refresh on an opted-in session → not-linked, no /hooks POST", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-revoked");
      setSessionReporting(SID_A, true, {
        statePath,
        now: () => new Date(FIXED_NOW),
      });
      const { fn: fetch, calls } = makeFetch({
        "/auth/refresh": () => jsonResponse(401, { error: "revoked" }),
      });
      const result = await runHook({
        hookName: "after_create",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        credentialsPath,
        auditLogPath,
        fetch,
      });
      expect(result.ok).toBe(true);
      expect(result.userMessage).toMatch(/isn't linked|not linked/);
      // Refresh was called; /hooks was NOT.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("/auth/refresh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Visible feedback on SessionStart — DD-48 carried forward.
// ---------------------------------------------------------------------------

describe("runHook — visible feedback (DD-48)", () => {
  it("SessionStart on a registered opted-in session → ✓ message", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      setSessionReporting(SID_A, true, {
        statePath,
        now: () => new Date(FIXED_NOW),
      });
      const { fn: fetch } = makeFetch({
        "/auth/refresh": () => jsonResponse(200, { access_token: "at" }),
        "/hooks/after_create": () =>
          jsonResponse(200, { registered: true, thread_id: "tid-1" }),
      });
      const result = await runHook({
        hookName: "after_create",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        credentialsPath,
        auditLogPath,
        fetch,
      });
      expect(result.userMessage).toContain("registered");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-SessionStart hook on a not-opted-in session → NO userMessage (silent)", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      const { fn: fetch } = makeFetch({});
      const result = await runHook({
        hookName: "before_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        credentialsPath,
        auditLogPath,
        fetch,
      });
      expect(result.ok).toBe(true);
      expect(result.userMessage).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SessionStart on a not-opted-in session → NO userMessage (do NOT prompt to link merely because session started)", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditLogPath = join(dir, "audit.log");
      const credentialsPath = join(dir, "auth.json");
      writeCred(credentialsPath, "rt-abc");
      const { fn: fetch } = makeFetch({});
      const result = await runHook({
        hookName: "after_create",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        credentialsPath,
        auditLogPath,
        fetch,
      });
      expect(result.ok).toBe(true);
      // Spec line 143-144: merely starting a session never surfaces the
      // not-linked prompt; only opt-IN does.
      expect(result.userMessage).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
