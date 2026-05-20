/**
 * Tests for the SDK's AuthClient — short-lived scoped OAuth tokens.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Auth +
 * the plan task "OAuth-scoped backend tokens". The MCP server itself
 * MUST NOT do outbound HTTP (source-level credential isolation), so
 * the auth surface lives on the SDK — the canonical TypeScript
 * interface that the CLI uses to drive the auth flow on behalf of
 * the user during install/`auth` commands.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 7 — OAuth-scoped tokens.
 */
import { describe, expect, it } from "vitest";

import { AuthClient } from "../src/auth.js";

function fakeOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("AuthClient.getAccessToken", () => {
  it("POSTs to /auth/refresh and parses access_token + expires_in into a fresh access token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(input), init: init ?? {} });
      return fakeOk({
        access_token: "at-eyJ...",
        expires_in: 300,
        token_type: "Bearer",
      });
    }) as unknown as typeof globalThis.fetch;

    const auth = new AuthClient({
      apiBase: "https://api.eleanor4devs.com",
      refreshToken: "rt-abc",
      fetch: fakeFetch,
    });

    const token = await auth.getAccessToken();
    expect(token).toBe("at-eyJ...");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.eleanor4devs.com/auth/refresh");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      refresh_token: "rt-abc",
    });
  });

  it("caches the access token within its TTL and skips the second /auth/refresh round-trip", async () => {
    let refreshCalls = 0;
    const fakeFetch = (async () => {
      refreshCalls += 1;
      return fakeOk({ access_token: "at-1", expires_in: 300 });
    }) as unknown as typeof globalThis.fetch;

    const auth = new AuthClient({
      apiBase: "https://api.eleanor4devs.com",
      refreshToken: "rt-abc",
      fetch: fakeFetch,
    });

    const a = await auth.getAccessToken();
    const b = await auth.getAccessToken();
    const c = await auth.getAccessToken();
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(refreshCalls).toBe(1);
  });
});

describe("AuthClient.revoke", () => {
  it("POSTs to /auth/revoke with the refresh token and clears the cache", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(input), init: init ?? {} });
      if (String(input).endsWith("/auth/refresh")) {
        return fakeOk({ access_token: "at-revoke-cycle", expires_in: 300 });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;

    const auth = new AuthClient({
      apiBase: "https://api.eleanor4devs.com",
      refreshToken: "rt-abc",
      fetch: fakeFetch,
    });

    await auth.getAccessToken();
    await auth.revoke();

    const revokeCalls = calls.filter((c) =>
      c.url.endsWith("/auth/revoke"),
    );
    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0].init.method).toBe("POST");
    expect(JSON.parse(revokeCalls[0].init.body as string)).toEqual({
      refresh_token: "rt-abc",
    });

    // Post-revoke, a fresh getAccessToken triggers ANOTHER refresh
    // because the cache was cleared.
    await auth.getAccessToken();
    const refreshCalls = calls.filter((c) =>
      c.url.endsWith("/auth/refresh"),
    );
    expect(refreshCalls).toHaveLength(2);
  });
});

describe("AuthClient — scoped tokens", () => {
  it("includes the requested scope in the refresh request body when scope is configured", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(input), init: init ?? {} });
      return fakeOk({ access_token: "at-scoped", expires_in: 300 });
    }) as unknown as typeof globalThis.fetch;

    const auth = new AuthClient({
      apiBase: "https://api.eleanor4devs.com",
      refreshToken: "rt-abc",
      fetch: fakeFetch,
      scope: "report:write",
    });
    await auth.getAccessToken();
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      refresh_token: "rt-abc",
      scope: "report:write",
    });
  });
});
