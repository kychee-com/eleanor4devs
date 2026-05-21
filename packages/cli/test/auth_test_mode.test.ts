/**
 * Tests for `eleanor4devs auth --test-mode <code>` — the TR-006 CLI
 * one-shot adversarial auth bypass (Phase 17, spec v0.8.0).
 *
 * Pairs with `backend/src/eleanor4devs/test_mode.py` — when invoked
 * with `--test-mode <code>`, the CLI POSTs to `/test/auth/issue`
 * (instead of `/auth/cli/start`) and then drives the existing
 * `/auth/cli/poll` loop. No interactive prompts, no Telegram redirect.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 17 TR-006.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authFlow,
  AuthTimeoutError,
  TestModeNotEnabledError,
  parseAuthArgs,
} from "../src/commands/auth.js";

function fakeOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeNotFound(): Response {
  return new Response(JSON.stringify({ detail: "Not Found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

describe("parseAuthArgs", () => {
  it("returns interactive mode when no flag is passed", () => {
    expect(parseAuthArgs([])).toEqual({ mode: "interactive" });
  });

  it("returns test-mode + the code when --test-mode <code> is passed", () => {
    expect(parseAuthArgs(["--test-mode", "ABC123"])).toEqual({
      mode: "test",
      code: "ABC123",
    });
  });

  it("throws when --test-mode is passed without a code", () => {
    expect(() => parseAuthArgs(["--test-mode"])).toThrowError(
      /requires a code argument/,
    );
  });
});

describe("authFlow — --test-mode happy path", () => {
  it("hits /test/auth/issue then polls /auth/cli/poll and persists the refresh token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e4d-auth-tm-"));
    const credentialsPath = join(dir, "auth.json");
    const fetched: string[] = [];
    let pollCount = 0;
    const fakeFetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      fetched.push(url);
      if (url.endsWith("/test/auth/issue")) {
        return fakeOk({
          code: "TM-ABC123",
          poll_token: "ptk-xyz",
          expires_at: Date.now() / 1000 + 60,
        });
      }
      if (url.includes("/auth/cli/poll")) {
        pollCount += 1;
        // First poll returns linked: true (no waiting needed — backend
        // mints credentials immediately for test-mode).
        return fakeOk({ linked: true, refresh_token: "test-mode-rt-final" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await authFlow({
        apiBase: "https://api.eleanor4devs.com",
        fetch: fakeFetch,
        display: () => {},
        credentialsPath,
        pollIntervalMs: 0,
        maxPolls: 5,
        testMode: { code: "ABC123" },
      });

      expect(result.refreshToken).toBe("test-mode-rt-final");
      // First call must be /test/auth/issue, NOT /auth/cli/start.
      expect(fetched[0]).toContain("/test/auth/issue");
      expect(fetched.some((u) => u.includes("/auth/cli/start"))).toBe(false);
      // Credentials persisted.
      expect(existsSync(credentialsPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(credentialsPath, "utf-8"));
      expect(parsed).toMatchObject({ refresh_token: "test-mode-rt-final" });
      // Exactly one poll completed (linked on first hit).
      expect(pollCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("authFlow — --test-mode against production (404)", () => {
  it("throws TestModeNotEnabledError and does not write credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e4d-auth-tm-404-"));
    const credentialsPath = join(dir, "auth.json");
    const fakeFetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/test/auth/issue")) {
        return fakeNotFound();
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    try {
      await expect(
        authFlow({
          apiBase: "https://api.eleanor4devs.com",
          fetch: fakeFetch,
          display: () => {},
          credentialsPath,
          pollIntervalMs: 0,
          maxPolls: 5,
          testMode: { code: "ABC123" },
        }),
      ).rejects.toThrow(TestModeNotEnabledError);
      // No credentials file written when the backend rejects test-mode.
      expect(existsSync(credentialsPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("authFlow — --test-mode timeout", () => {
  it("throws AuthTimeoutError if backend never reports linked=true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e4d-auth-tm-timeout-"));
    const credentialsPath = join(dir, "auth.json");
    const fakeFetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/test/auth/issue")) {
        return fakeOk({
          code: "TM-NEVER",
          poll_token: "ptk-never",
          expires_at: Date.now() / 1000 + 60,
        });
      }
      return fakeOk({ linked: false });
    }) as unknown as typeof globalThis.fetch;

    try {
      await expect(
        authFlow({
          apiBase: "https://api.eleanor4devs.com",
          fetch: fakeFetch,
          display: () => {},
          credentialsPath,
          pollIntervalMs: 0,
          maxPolls: 3,
          testMode: { code: "WHATEVER" },
        }),
      ).rejects.toThrow(AuthTimeoutError);
      expect(existsSync(credentialsPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
