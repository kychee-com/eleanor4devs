/**
 * Tests for `eleanor4devs status` (Phase 23 Group F, spec v0.14.0).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI line 209.
 *
 * Phase 23 ([[DD-52]]) replaced the machine-wide reporting ON/OFF first
 * line with a per-session model: the first line is now a machine LINK line
 * + a count of currently-monitored sessions (active + paused); the table
 * renders all five states. There is no global reporting toggle anymore.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runStatus } from "../src/commands/status.js";
import { setSessionReporting } from "../src/state.js";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-status-"));
}

function captureLog(): { lines: string[]; log: (t: string) => void } {
  const lines: string[] = [];
  return { lines, log: (t: string) => lines.push(t) };
}

function writeCred(dir: string): string {
  const p = join(dir, "auth.json");
  writeFileSync(p, JSON.stringify({ refresh_token: "rt-x" }), "utf-8");
  return p;
}

interface FetchOpts {
  refreshStatus?: number;
  sessions?: unknown[];
  sessionsStatus?: number;
  boom?: boolean;
}

function makeFetch(o: FetchOpts): typeof globalThis.fetch {
  return (async (input: unknown) => {
    if (o.boom) throw new Error("network down");
    const url = String(input);
    if (url.endsWith("/auth/refresh")) {
      const st = o.refreshStatus ?? 200;
      if (st !== 200) return new Response("{}", { status: st });
      return new Response(JSON.stringify({ access_token: "at-x" }), { status: 200 });
    }
    return new Response(JSON.stringify({ sessions: o.sessions ?? [] }), {
      status: o.sessionsStatus ?? 200,
    });
  }) as typeof globalThis.fetch;
}

function row(state: string, name: string) {
  return {
    thread_id: `t-${name}`,
    display_name: name,
    state,
    repo: "eleanor4devs",
    last_event_at: new Date().toISOString(),
  };
}

describe("runStatus — link line (Phase 23 Group F)", () => {
  it("linked → 'linked · N sessions monitored' counting active + paused", async () => {
    const dir = freshTempDir();
    try {
      const sessions = [
        row("active", "alpha"),
        row("paused", "beta"),
        row("active", "gamma"),
        row("disabled", "delta"), // retired — NOT counted
        row("archived", "epsilon"), // retired — NOT counted
        row("expired", "zeta"), // retired — NOT counted
      ];
      const { lines, log } = captureLog();
      const code = await runStatus({
        statePath: join(dir, "state.json"),
        log,
        backendUrl: "https://api.test",
        credentialsPath: writeCred(dir),
        fetch: makeFetch({ sessions }),
      });
      expect(code).toBe(0);
      expect(lines[0]).toBe("Eleanor4Devs: linked · 3 sessions monitored");
      // No machine-wide ON/OFF anywhere.
      expect(lines.join("\n")).not.toContain("reporting: ON");
      expect(lines.join("\n")).not.toContain("reporting: OFF");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exactly one monitored → singular 'session'", async () => {
    const dir = freshTempDir();
    try {
      const { lines, log } = captureLog();
      await runStatus({
        statePath: join(dir, "state.json"),
        log,
        backendUrl: "https://api.test",
        credentialsPath: writeCred(dir),
        fetch: makeFetch({ sessions: [row("active", "only")] }),
      });
      expect(lines[0]).toBe("Eleanor4Devs: linked · 1 session monitored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("zero monitored (all retired) → 'linked · 0 sessions monitored'", async () => {
    const dir = freshTempDir();
    try {
      const { lines, log } = captureLog();
      await runStatus({
        statePath: join(dir, "state.json"),
        log,
        backendUrl: "https://api.test",
        credentialsPath: writeCred(dir),
        fetch: makeFetch({ sessions: [row("disabled", "x"), row("expired", "y")] }),
      });
      expect(lines[0]).toBe("Eleanor4Devs: linked · 0 sessions monitored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("table renders all five states", async () => {
    const dir = freshTempDir();
    try {
      const sessions = [
        row("active", "s-active"),
        row("paused", "s-paused"),
        row("disabled", "s-disabled"),
        row("archived", "s-archived"),
        row("expired", "s-expired"),
      ];
      const { lines, log } = captureLog();
      await runStatus({
        statePath: join(dir, "state.json"),
        log,
        backendUrl: "https://api.test",
        credentialsPath: writeCred(dir),
        fetch: makeFetch({ sessions }),
      });
      const table = lines.slice(1).join("\n");
      for (const s of ["active", "paused", "disabled", "archived", "expired"]) {
        expect(table).toContain(s);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no credential → 'not linked' + auth hint, NO fetch", async () => {
    const dir = freshTempDir();
    try {
      let fetched = false;
      const fetchSpy = (async () => {
        fetched = true;
        return new Response("{}");
      }) as typeof globalThis.fetch;
      const { lines, log } = captureLog();
      const code = await runStatus({
        statePath: join(dir, "state.json"),
        log,
        backendUrl: "https://api.test",
        credentialsPath: join(dir, "missing.json"),
        fetch: fetchSpy,
      });
      expect(code).toBe(0);
      expect(lines[0]).toBe("Eleanor4Devs: not linked");
      expect(lines.join("\n")).toContain("eleanor4devs auth");
      expect(fetched).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stale/revoked credential (refresh 401) → 'not linked' + hint", async () => {
    const dir = freshTempDir();
    try {
      const { lines, log } = captureLog();
      await runStatus({
        statePath: join(dir, "state.json"),
        log,
        backendUrl: "https://api.test",
        credentialsPath: writeCred(dir),
        fetch: makeFetch({ refreshStatus: 401 }),
      });
      expect(lines[0]).toBe("Eleanor4Devs: not linked");
      expect(lines.join("\n")).toContain("eleanor4devs auth");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backend unreachable → 'linked' + couldn't-load note, exit 0, never throws", async () => {
    const dir = freshTempDir();
    try {
      const { lines, log } = captureLog();
      const code = await runStatus({
        statePath: join(dir, "state.json"),
        log,
        backendUrl: "https://api.test",
        credentialsPath: writeCred(dir),
        fetch: makeFetch({ boom: true }),
      });
      expect(code).toBe(0);
      expect(lines[0]).toBe("Eleanor4Devs: linked");
      expect(lines.join("\n").toLowerCase()).toContain("couldn't load");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runStatus — current session line (/e4d-status)", () => {
  it("opted-in session → 'This session: monitored'", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      setSessionReporting("sess-1", true, { statePath });
      const { lines, log } = captureLog();
      await runStatus({
        statePath,
        log,
        backendUrl: "https://api.test",
        credentialsPath: writeCred(dir),
        fetch: makeFetch({ sessions: [row("active", "x")] }),
        sessionId: "sess-1",
      });
      const last = lines[lines.length - 1]!;
      expect(last).toContain("This session: monitored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("not-opted-in session → 'This session: not monitored' + /e4d hint", async () => {
    const dir = freshTempDir();
    try {
      const { lines, log } = captureLog();
      await runStatus({
        statePath: join(dir, "state.json"), // no record for sess-2
        log,
        backendUrl: "https://api.test",
        credentialsPath: writeCred(dir),
        fetch: makeFetch({ sessions: [] }),
        sessionId: "sess-2",
      });
      const last = lines[lines.length - 1]!;
      expect(last).toContain("This session: not monitored");
      expect(last).toContain("/e4d");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no sessionId → no current-session line at all", async () => {
    const dir = freshTempDir();
    try {
      const { lines, log } = captureLog();
      await runStatus({
        statePath: join(dir, "state.json"),
        log,
        backendUrl: "https://api.test",
        credentialsPath: writeCred(dir),
        fetch: makeFetch({ sessions: [row("active", "x")] }),
      });
      expect(lines.join("\n")).not.toContain("This session:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unsubstituted ${CLAUDE_SESSION_ID} → graceful 'unavailable' line, no crash", async () => {
    const dir = freshTempDir();
    try {
      const { lines, log } = captureLog();
      const code = await runStatus({
        statePath: join(dir, "state.json"),
        log,
        backendUrl: "https://api.test",
        credentialsPath: writeCred(dir),
        fetch: makeFetch({ sessions: [] }),
        sessionId: "${CLAUDE_SESSION_ID}",
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("reporting state unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("status flow issues ONLY GET /sessions + POST /auth/refresh — no state-mutating POST", async () => {
    const dir = freshTempDir();
    try {
      const calls: Array<{ url: string; method: string }> = [];
      const recordingFetch = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
        if (url.endsWith("/auth/refresh")) {
          return new Response(JSON.stringify({ access_token: "at-x" }), { status: 200 });
        }
        return new Response(JSON.stringify({ sessions: [row("active", "x")] }), { status: 200 });
      }) as typeof globalThis.fetch;
      const statePath = join(dir, "state.json");
      setSessionReporting("s", true, { statePath });
      await runStatus({
        statePath,
        log: () => {},
        backendUrl: "https://api.test",
        credentialsPath: writeCred(dir),
        fetch: recordingFetch,
        sessionId: "s",
      });
      // The ONLY mutating call allowed is POST /auth/refresh (mints an
      // access token; it does not change session/thread state). NO POST to
      // any /hooks/* or /sessions/*/disable|archive endpoint.
      const forbidden = calls.filter(
        (c) =>
          /\/hooks\/(opt-in|disable|after_create)/.test(c.url) ||
          /\/sessions\/.*\/(disable|archive)/.test(c.url),
      );
      expect(forbidden).toEqual([]);
      // The sessions listing must be a GET.
      const sessionsCalls = calls.filter((c) => /\/sessions\?/.test(c.url));
      expect(sessionsCalls.every((c) => c.method === "GET")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
