/**
 * Tests for `eleanor4devs auth` — the one-time-code linking flow.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Auth. The
 * CLI starts an auth session via the backend, displays a short
 * one-time code to the user, instructs them to forward that code to
 * the bot, polls until linked, and persists the long-lived refresh
 * token to disk.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 7 — CLI auth.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { authFlow, AuthTimeoutError } from "../src/commands/auth.js";

function fakeOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("authFlow — happy path", () => {
  it("displays the one-time code from the backend and persists the refresh token on link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e4d-auth-"));
    const credentialsPath = join(dir, "auth.json");
    const displayed: string[] = [];
    let pollCount = 0;
    const fakeFetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/auth/cli/start")) {
        return fakeOk({ code: "ABCD-1234", poll_token: "pt-xyz" });
      }
      if (url.includes("/auth/cli/poll")) {
        pollCount += 1;
        if (pollCount >= 2) {
          return fakeOk({ linked: true, refresh_token: "rt-final" });
        }
        return fakeOk({ linked: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await authFlow({
        apiBase: "https://api.eleanor4devs.com",
        fetch: fakeFetch,
        display: (text) => displayed.push(text),
        credentialsPath,
        pollIntervalMs: 0, // immediate re-poll for the test
        maxPolls: 10,
      });

      expect(result.refreshToken).toBe("rt-final");
      // The displayed text must include the one-time code so the user
      // can copy it into Telegram.
      expect(displayed.some((line) => line.includes("ABCD-1234"))).toBe(true);
      // The refresh token must be persisted to disk so subsequent CLI
      // invocations don't re-prompt.
      expect(existsSync(credentialsPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(credentialsPath, "utf-8"));
      expect(parsed).toMatchObject({ refresh_token: "rt-final" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("authFlow — timeout", () => {
  it("throws AuthTimeoutError after maxPolls if backend never reports linked=true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e4d-auth-timeout-"));
    const credentialsPath = join(dir, "auth.json");
    const fakeFetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/auth/cli/start")) {
        return fakeOk({ code: "ZZZZ-9999", poll_token: "pt-never" });
      }
      // Always "not linked yet".
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
        }),
      ).rejects.toThrow(AuthTimeoutError);
      // Credentials file must NOT have been written on timeout.
      expect(existsSync(credentialsPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
