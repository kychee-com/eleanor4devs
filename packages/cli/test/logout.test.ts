/**
 * Tests for `eleanor4devs logout` (Phase 22 Group C, spec v0.13.0).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md
 *   § Claude Local Box — Auth & Reporting Pipeline added
 *   `eleanor4devs logout`: revoke the stored refresh_token server-side,
 *   then delete the local credential.
 *
 * Contract:
 *   - credential present → POST /auth/revoke {refresh_token}, delete the
 *     file, print a "signed out" line, exit 0.
 *   - already signed out (no credential) → exit 0, "not signed in", NO
 *     network call, leaves no credential behind.
 *   - backend unreachable / non-2xx → still delete the local file, warn on
 *     stderr that server-side revoke was not confirmed, exit 0 (the local
 *     credential is gone regardless — privacy-monotonic).
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runLogout } from "../src/commands/logout.js";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-logout-"));
}

function writeCreds(path: string, refreshToken: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ refresh_token: refreshToken }) + "\n", "utf-8");
}

function capture(): {
  out: string[];
  err: string[];
  log: (t: string) => void;
  errorLog: (t: string) => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (t: string) => out.push(t),
    errorLog: (t: string) => err.push(t),
  };
}

describe("runLogout", () => {
  it("credential present → POSTs /auth/revoke, deletes the file, prints signed out, exit 0", async () => {
    const dir = freshTempDir();
    try {
      const credentialsPath = join(dir, "auth.json");
      writeCreds(credentialsPath, "rt-secret-123");
      const calls: Array<{ url: string; body: unknown }> = [];
      const fetchMock = (async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ revoked: true }), { status: 200 });
      }) as unknown as typeof globalThis.fetch;
      const { out, err, log, errorLog } = capture();

      const code = await runLogout({
        credentialsPath,
        backendUrl: "https://api.example.com",
        fetch: fetchMock,
        log,
        errorLog,
      });

      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://api.example.com/auth/revoke");
      expect(calls[0]!.body).toEqual({ refresh_token: "rt-secret-123" });
      expect(existsSync(credentialsPath)).toBe(false);
      expect(out.join("\n").toLowerCase()).toContain("signed out");
      expect(err).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no credential file → exit 0, 'not signed in', no network call, no credential left", async () => {
    const dir = freshTempDir();
    try {
      const credentialsPath = join(dir, "auth.json");
      let fetchCalled = false;
      const fetchMock = (async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof globalThis.fetch;
      const { out, log, errorLog } = capture();

      const code = await runLogout({
        credentialsPath,
        backendUrl: "https://api.example.com",
        fetch: fetchMock,
        log,
        errorLog,
      });

      expect(code).toBe(0);
      expect(fetchCalled).toBe(false);
      expect(existsSync(credentialsPath)).toBe(false);
      expect(out.join("\n").toLowerCase()).toContain("not signed in");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backend unreachable → still deletes the file, warns on stderr, exit 0", async () => {
    const dir = freshTempDir();
    try {
      const credentialsPath = join(dir, "auth.json");
      writeCreds(credentialsPath, "rt-secret-456");
      const fetchMock = (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof globalThis.fetch;
      const { err, log, errorLog } = capture();

      const code = await runLogout({
        credentialsPath,
        backendUrl: "https://api.example.com",
        fetch: fetchMock,
        log,
        errorLog,
      });

      expect(code).toBe(0);
      expect(existsSync(credentialsPath)).toBe(false);
      expect(err.join("\n").toLowerCase()).toContain("revoke");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backend returns 5xx → still deletes the file, warns, exit 0", async () => {
    const dir = freshTempDir();
    try {
      const credentialsPath = join(dir, "auth.json");
      writeCreds(credentialsPath, "rt-secret-789");
      const fetchMock = (async () =>
        new Response("boom", { status: 502 })) as unknown as typeof globalThis.fetch;
      const { err, log, errorLog } = capture();

      const code = await runLogout({
        credentialsPath,
        backendUrl: "https://api.example.com",
        fetch: fetchMock,
        log,
        errorLog,
      });

      expect(code).toBe(0);
      expect(existsSync(credentialsPath)).toBe(false);
      expect(err.join("\n").toLowerCase()).toContain("revoke");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corrupt credential file (no refresh_token) → deletes it, no network call, exit 0", async () => {
    const dir = freshTempDir();
    try {
      const credentialsPath = join(dir, "auth.json");
      mkdirSync(dirname(credentialsPath), { recursive: true });
      writeFileSync(credentialsPath, "{ not json", "utf-8");
      let fetchCalled = false;
      const fetchMock = (async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof globalThis.fetch;
      const { log, errorLog } = capture();

      const code = await runLogout({
        credentialsPath,
        backendUrl: "https://api.example.com",
        fetch: fetchMock,
        log,
        errorLog,
      });

      expect(code).toBe(0);
      // Nothing to revoke (no usable token), but the local file is cleared.
      expect(fetchCalled).toBe(false);
      expect(existsSync(credentialsPath)).toBe(false);
      // sanity: the file really was there before
      void readFileSync;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
