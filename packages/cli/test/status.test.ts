/**
 * Tests for `eleanor4devs status` first line (Phase 19, Group E).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control line 409 — "`eleanor4devs status` shows current state +
 *   last-toggle timestamp on the first output line".
 *
 * Phase 19 owns line 1 only. Lines 2+ (thread counts, focus cap, etc.)
 * are reserved for later phases per the plan.
 */
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runStatus } from "../src/commands/status.js";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-status-"));
}

function writeState(
  statePath: string,
  body: string | { enabled: boolean; toggled_at: string | null },
): void {
  mkdirSync(dirname(statePath), { recursive: true });
  if (typeof body === "string") {
    writeFileSync(statePath, body, "utf-8");
  } else {
    writeFileSync(statePath, JSON.stringify(body), "utf-8");
  }
}

function captureLog(): {
  lines: string[];
  log: (text: string) => void;
} {
  const lines: string[] = [];
  return { lines, log: (text: string) => lines.push(text) };
}

describe("runStatus — first line shows reporting state", () => {
  it("state ON + toggled_at present → 'Eleanor4Devs reporting: ON (since <ts>)'", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      writeState(statePath, {
        enabled: true,
        toggled_at: "2026-05-28T15:42:00Z",
      });
      const { lines, log } = captureLog();
      const code = await runStatus({ statePath, log });
      expect(code).toBe(0);
      expect(lines[0]).toBe(
        "Eleanor4Devs reporting: ON (since 2026-05-28T15:42:00Z)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("state OFF + toggled_at present → 'Eleanor4Devs reporting: OFF (since <ts>)'", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      writeState(statePath, {
        enabled: false,
        toggled_at: "2026-05-28T15:42:00Z",
      });
      const { lines, log } = captureLog();
      const code = await runStatus({ statePath, log });
      expect(code).toBe(0);
      expect(lines[0]).toBe(
        "Eleanor4Devs reporting: OFF (since 2026-05-28T15:42:00Z)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing state file → 'Eleanor4Devs reporting: OFF (no toggle recorded)'", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const { lines, log } = captureLog();
      const code = await runStatus({ statePath, log });
      expect(code).toBe(0);
      expect(lines[0]).toBe(
        "Eleanor4Devs reporting: OFF (no toggle recorded)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corrupt state file → same as missing (fail-closed)", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      writeState(statePath, "not json at all");
      const { lines, log } = captureLog();
      const code = await runStatus({ statePath, log });
      expect(code).toBe(0);
      expect(lines[0]).toBe(
        "Eleanor4Devs reporting: OFF (no toggle recorded)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

function writeCred(dir: string): string {
  const p = join(dir, "auth.json");
  writeFileSync(p, JSON.stringify({ refresh_token: "rt-x" }), "utf-8");
  return p;
}

describe("runStatus — recent-sessions table (Phase 21)", () => {
  it("linked → reporting line, then the sessions table", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      writeState(statePath, { enabled: true, toggled_at: "2026-05-28T15:42:00Z" });
      const credPath = writeCred(dir);
      const sessions = [
        {
          thread_id: "t1",
          display_name: "auth pipeline",
          state: "active",
          repo: "eleanor4devs",
          last_event_at: new Date().toISOString(),
        },
      ];
      const { lines, log } = captureLog();
      const code = await runStatus({
        statePath,
        log,
        backendUrl: "https://api.test",
        credentialsPath: credPath,
        fetch: makeFetch({ sessions }),
      });
      expect(code).toBe(0);
      expect(lines[0]).toContain("reporting: ON");
      const rest = lines.slice(1).join("\n");
      expect(rest).toContain("SESSION");
      expect(rest).toContain("auth pipeline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unlinked → reporting line + 'run eleanor4devs auth' hint, no fetch", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      writeState(statePath, { enabled: true, toggled_at: "2026-05-28T15:42:00Z" });
      let fetched = false;
      const fetchSpy = (async () => {
        fetched = true;
        return new Response("{}");
      }) as typeof globalThis.fetch;
      const { lines, log } = captureLog();
      const code = await runStatus({
        statePath,
        log,
        backendUrl: "https://api.test",
        credentialsPath: join(dir, "missing.json"),
        fetch: fetchSpy,
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("eleanor4devs auth");
      expect(fetched).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backend error → reporting line + couldn't-load note, never throws, exit 0", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      writeState(statePath, { enabled: false, toggled_at: "2026-05-28T15:42:00Z" });
      const credPath = writeCred(dir);
      const { lines, log } = captureLog();
      const code = await runStatus({
        statePath,
        log,
        backendUrl: "https://api.test",
        credentialsPath: credPath,
        fetch: makeFetch({ boom: true }),
      });
      expect(code).toBe(0);
      expect(lines.join("\n").toLowerCase()).toContain("couldn't load");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
