/**
 * Tests for `eleanor4devs hook <event>` (Phase 20 contract).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md
 *   § Claude Local Box — Auth & Reporting Pipeline.
 * Plan: Phase 20 Group C (DD-44 non-fatal, DD-47 refresh→access, DD-48
 *   visible feedback).
 *
 * The hook reads ~/.eleanor4devs/auth.json, exchanges the refresh_token
 * for an access_token via POST /auth/refresh, then POSTs the event to
 * /hooks/<event> with `Authorization: Bearer`. All hooks are best-effort
 * (never fatal); SessionStart surfaces a visible userMessage.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  parseHookArgs,
  runHook,
  type HookCallResult,
  type RunHookOptions,
} from "../src/commands/hook.js";

let DIR: string;
let STATE_PATH: string;
let CRED_PATH: string;

beforeAll(() => {
  DIR = mkdtempSync(join(tmpdir(), "e4d-hook-cmd-"));
  STATE_PATH = join(DIR, "state.json");
  CRED_PATH = join(DIR, "auth.json");
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(
    STATE_PATH,
    JSON.stringify({ enabled: true, toggled_at: "2026-05-29T00:00:00.000Z" }),
    "utf-8",
  );
  writeFileSync(CRED_PATH, JSON.stringify({ refresh_token: "rt-test" }), "utf-8");
});
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

interface FetchOpts {
  refreshStatus?: number;
  hookStatus?: number;
  hookBody?: Record<string, unknown>;
  boom?: "refresh" | "hooks";
}

function makeFetch(o: FetchOpts, captured: Captured[]): typeof globalThis.fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    captured.push({ url, init });
    if (url.endsWith("/auth/refresh")) {
      if (o.boom === "refresh") throw new Error("network down");
      const status = o.refreshStatus ?? 200;
      if (status !== 200) return new Response("{}", { status });
      return new Response(JSON.stringify({ access_token: "at-xyz" }), {
        status: 200,
      });
    }
    if (o.boom === "hooks") throw new Error("network down");
    return new Response(
      JSON.stringify(o.hookBody ?? { registered: true, thread_id: "t1" }),
      { status: o.hookStatus ?? 200 },
    );
  }) as typeof globalThis.fetch;
}

function baseOpts(over: Partial<RunHookOptions> = {}): RunHookOptions {
  return {
    hookName: "after_create",
    backendUrl: "https://api.example.test",
    stdinJson: "{}",
    statePath: STATE_PATH,
    credentialsPath: CRED_PATH,
    auditLogPath: join(DIR, "audit.log"),
    ...over,
  };
}

function hookPost(captured: Captured[]): Captured | undefined {
  return captured.find((c) => c.url.includes("/hooks/"));
}

describe("parseHookArgs", () => {
  it("accepts a logical hook name as the first positional", () => {
    expect(parseHookArgs(["after_create"]).hookName).toBe("after_create");
  });
  it("rejects an unknown hook name", () => {
    expect(() => parseHookArgs(["nope"])).toThrow(/unknown hook/);
  });
  it("accepts an optional --backend <url>", () => {
    expect(parseHookArgs(["after_create", "--backend", "https://x.test"]).backendUrl).toBe(
      "https://x.test",
    );
  });
  it("throws if --backend has no value", () => {
    expect(() => parseHookArgs(["after_create", "--backend"])).toThrow(/--backend requires/);
  });
});

describe("runHook — authenticated POST (Phase 20)", () => {
  it("exchanges refresh→access then POSTs /hooks/<event> with a Bearer header", async () => {
    const captured: Captured[] = [];
    const result: HookCallResult = await runHook(
      baseOpts({
        stdinJson: '{"session_id":"s1","cwd":"/x"}',
        fetch: makeFetch({}, captured),
      }),
    );
    expect(result.ok).toBe(true);
    // first call refreshes, second posts the hook
    expect(captured[0]!.url).toBe("https://api.example.test/auth/refresh");
    const post = hookPost(captured)!;
    expect(post.url).toBe("https://api.example.test/hooks/after_create");
    expect(post.init?.method).toBe("POST");
    const headers = post.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer at-xyz");
    const body = JSON.parse(String(post.init?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({ hook: "after_create", payload: { session_id: "s1", cwd: "/x" } });
  });

  it("empty stdin → payload {}", async () => {
    const captured: Captured[] = [];
    await runHook(baseOpts({ hookName: "after_run", stdinJson: "", fetch: makeFetch({}, captured) }));
    const body = JSON.parse(String(hookPost(captured)!.init?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({ hook: "after_run", payload: {} });
  });

  it("handles CRLF + BOM stdin (Windows pipe quirks)", async () => {
    for (const stdin of ['{"session_id":"s1"}\r\n', '﻿{"session_id":"s1"}']) {
      const captured: Captured[] = [];
      await runHook(baseOpts({ stdinJson: stdin, fetch: makeFetch({}, captured) }));
      const body = JSON.parse(String(hookPost(captured)!.init?.body ?? "{}")) as Record<string, unknown>;
      expect((body.payload as Record<string, unknown>).session_id).toBe("s1");
    }
  });
});

describe("runHook — not linked (Phase 20 DD-47)", () => {
  it("ON but no credential → no network, guidance on SessionStart", async () => {
    const captured: Captured[] = [];
    const result = await runHook(
      baseOpts({ credentialsPath: join(DIR, "missing.json"), fetch: makeFetch({}, captured) }),
    );
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("not_linked");
    expect(captured).toHaveLength(0); // never even refreshes
    expect(result.userMessage).toMatch(/eleanor4devs auth/);
  });

  it("refresh 401 (revoked) → treated as not linked, no /hooks POST", async () => {
    const captured: Captured[] = [];
    const result = await runHook(baseOpts({ fetch: makeFetch({ refreshStatus: 401 }, captured) }));
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("not_linked");
    expect(hookPost(captured)).toBeUndefined();
  });

  it("non-SessionStart not-linked stays silent (no userMessage)", async () => {
    const result = await runHook(
      baseOpts({ hookName: "after_run", credentialsPath: join(DIR, "missing.json") }),
    );
    expect(result.userMessage).toBeUndefined();
  });
});

describe("runHook — best-effort / non-fatal (DD-44)", () => {
  it("after_create POST failure is NON-fatal (was fatal pre-Phase-20)", async () => {
    const result = await runHook(baseOpts({ fetch: makeFetch({ boom: "hooks" }, []) }));
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(false);
    expect(result.userMessage).toMatch(/not registered/);
  });

  it("non-2xx from /hooks is a non-fatal failure", async () => {
    const result = await runHook(baseOpts({ fetch: makeFetch({ hookStatus: 500 }, []) }));
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(false);
    expect(result.reason).toMatch(/http_500/);
  });

  it("every hook is non-fatal on failure", async () => {
    for (const name of ["after_create", "before_run", "after_run", "before_remove"] as const) {
      const result = await runHook(baseOpts({ hookName: name, fetch: makeFetch({ boom: "hooks" }, []) }));
      expect(result.fatal).toBe(false);
    }
  });

  it("invalid stdin still POSTs an error envelope, non-fatal", async () => {
    const captured: Captured[] = [];
    const result = await runHook(
      baseOpts({ hookName: "before_run", stdinJson: "not-json{", fetch: makeFetch({}, captured) }),
    );
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(false);
    expect(result.reason).toMatch(/invalid_stdin_json/);
    const body = JSON.parse(String(hookPost(captured)!.init?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({ hook: "before_run", error: expect.any(String) });
  });
});

describe("runHook — visible feedback (DD-48)", () => {
  it("SessionStart registered → ✓ message", async () => {
    const result = await runHook(baseOpts({ fetch: makeFetch({}, []) }));
    expect(result.userMessage).toBe("✓ Eleanor: session registered");
  });

  it("SessionStart registered:false → ⚠ message with reason", async () => {
    const result = await runHook(
      baseOpts({ fetch: makeFetch({ hookBody: { registered: false, reason: "not_monitored" } }, []) }),
    );
    expect(result.userMessage).toBe("⚠ Eleanor: session not registered (not_monitored)");
  });

  it("non-SessionStart success is silent (no userMessage)", async () => {
    const result = await runHook(baseOpts({ hookName: "after_run", fetch: makeFetch({}, []) }));
    expect(result.userMessage).toBeUndefined();
  });
});
