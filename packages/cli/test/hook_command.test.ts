/**
 * Tests for the `eleanor4devs hook <event>` CLI subcommand (Phase 8).
 *
 * The hook subcommand is the thin command that Claude Code's
 * settings.json entries shell out to. It accepts a logical hook name
 * (`after_create | before_run | after_run | before_remove`), reads
 * Claude's hook context payload from stdin (a JSON object), and POSTs
 * it to the eleanor4devs backend's hook intake.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Provider Boxes
 *   (hook lifecycle — surfacing hook events to the backend).
 * Plan: docs/plans/eleanor4devs-plan.md Phase 8 — Claude Code hook
 *   templates + hook lifecycle enforcement.
 *
 * Failure semantics (mirrors `backend/src/eleanor4devs/hook_lifecycle.py`):
 *   - after_create  → exits non-zero on POST failure (FATAL to dispatch)
 *   - before_run / after_run / before_remove → exit 0 on POST failure
 *     (TOLERATED, logged but never aborts the agent)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  runHook,
  parseHookArgs,
  type HookCallResult,
} from "../src/commands/hook.js";

/**
 * Phase 19 (Group D) added a state-gate at the top of `runHook`. The
 * existing POST-path tests below pre-date Phase 19 and assume reporting
 * is ON. We seed a temp state.json with `enabled: true` for the test
 * suite's lifetime so the legacy tests continue to exercise the POST
 * code path (they cover stdin parsing, failure semantics, Windows
 * portability — orthogonal to the state-gate, which is covered by
 * `hook_state_gate.test.ts`).
 */
let SEEDED_STATE_PATH: string;
let SEEDED_STATE_DIR: string;
beforeAll(() => {
  SEEDED_STATE_DIR = mkdtempSync(join(tmpdir(), "e4d-hook-cmd-state-"));
  SEEDED_STATE_PATH = join(SEEDED_STATE_DIR, "state.json");
  mkdirSync(dirname(SEEDED_STATE_PATH), { recursive: true });
  writeFileSync(
    SEEDED_STATE_PATH,
    JSON.stringify({
      enabled: true,
      toggled_at: "2026-05-28T15:42:00.000Z",
    }),
    "utf-8",
  );
});
afterAll(() => {
  rmSync(SEEDED_STATE_DIR, { recursive: true, force: true });
});

interface CapturedPost {
  url: string;
  init: RequestInit | undefined;
}

function makeFakeFetch(
  status: number,
  captured: CapturedPost[],
): typeof globalThis.fetch {
  return (async (input: unknown, init?: RequestInit) => {
    captured.push({ url: String(input), init });
    return new Response("{}", { status });
  }) as typeof globalThis.fetch;
}

function makeBoomFetch(): typeof globalThis.fetch {
  return (async () => {
    throw new Error("network down");
  }) as typeof globalThis.fetch;
}

describe("parseHookArgs", () => {
  it("accepts a logical hook name as the first positional", () => {
    const parsed = parseHookArgs(["after_create"]);
    expect(parsed.hookName).toBe("after_create");
  });

  it("rejects an unknown hook name (must be one of the canonical 4)", () => {
    expect(() => parseHookArgs(["totally-not-a-hook"])).toThrow(
      /unknown hook/,
    );
  });

  it("accepts an optional --backend <url> override", () => {
    const parsed = parseHookArgs([
      "after_create",
      "--backend",
      "https://example.test",
    ]);
    expect(parsed.backendUrl).toBe("https://example.test");
  });

  it("throws if --backend is given with no value", () => {
    expect(() => parseHookArgs(["after_create", "--backend"])).toThrow(
      /--backend requires/,
    );
  });
});

describe("runHook — POST to backend", () => {
  it("POSTs the hook event to `<backend>/hooks/<hook_name>` with the stdin JSON payload", async () => {
    const captured: CapturedPost[] = [];
    const result: HookCallResult = await runHook({
      hookName: "after_create",
      backendUrl: "https://api.example.test",
      stdinJson: '{"session_id": "s1", "cwd": "/x"}',
      fetch: makeFakeFetch(200, captured),
      statePath: SEEDED_STATE_PATH,
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(
      "https://api.example.test/hooks/after_create",
    );
    expect(captured[0]!.init?.method).toBe("POST");
    const body = JSON.parse(String(captured[0]!.init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      hook: "after_create",
      payload: { session_id: "s1", cwd: "/x" },
    });
  });

  it("works when stdin is empty (treats payload as `{}`)", async () => {
    const captured: CapturedPost[] = [];
    const result = await runHook({
      hookName: "after_run",
      backendUrl: "https://api.example.test",
      stdinJson: "",
      fetch: makeFakeFetch(200, captured),
      statePath: SEEDED_STATE_PATH,
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(captured[0]!.init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ hook: "after_run", payload: {} });
  });

  it("returns ok=false when stdin contains invalid JSON, but still POSTs a structured error envelope", async () => {
    const captured: CapturedPost[] = [];
    const result = await runHook({
      hookName: "before_run",
      backendUrl: "https://api.example.test",
      stdinJson: "not-json{",
      fetch: makeFakeFetch(200, captured),
      statePath: SEEDED_STATE_PATH,
    });
    // Tolerated hook: we still report the failure to the backend, but
    // do not raise — the goal is that the agent run continues.
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/invalid_stdin_json/);
    // We still POSTed so the failure shows up in the backend audit log.
    expect(captured).toHaveLength(1);
    const body = JSON.parse(String(captured[0]!.init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      hook: "before_run",
      error: expect.any(String),
    });
  });
});

describe("runHook — failure semantics mirror hook_lifecycle.py", () => {
  it("after_create POST failure → result.fatal = true (caller should exit non-zero)", async () => {
    const result = await runHook({
      hookName: "after_create",
      backendUrl: "https://api.example.test",
      stdinJson: "{}",
      fetch: makeBoomFetch(),
      statePath: SEEDED_STATE_PATH,
    });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
  });

  it("after_run POST failure → result.fatal = false (caller exits 0 — logged-and-ignored)", async () => {
    const result = await runHook({
      hookName: "after_run",
      backendUrl: "https://api.example.test",
      stdinJson: "{}",
      fetch: makeBoomFetch(),
      statePath: SEEDED_STATE_PATH,
    });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(false);
  });

  it("before_run + before_remove POST failures → fatal = false", async () => {
    for (const name of ["before_run", "before_remove"] as const) {
      const result = await runHook({
        hookName: name,
        backendUrl: "https://api.example.test",
        stdinJson: "{}",
        fetch: makeBoomFetch(),
        statePath: SEEDED_STATE_PATH,
      });
      expect(result.fatal).toBe(false);
    }
  });

  it("non-2xx backend response is treated as a hook failure", async () => {
    const captured: CapturedPost[] = [];
    const result = await runHook({
      hookName: "after_create",
      backendUrl: "https://api.example.test",
      stdinJson: "{}",
      fetch: makeFakeFetch(500, captured),
      statePath: SEEDED_STATE_PATH,
    });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.reason).toMatch(/http_500/);
  });
});

describe("runHook — Windows portability", () => {
  it("handles CRLF-terminated stdin payloads (Windows pipe quirk) — parses cleanly", async () => {
    const captured: CapturedPost[] = [];
    const result = await runHook({
      hookName: "after_create",
      backendUrl: "https://api.example.test",
      stdinJson: '{"session_id": "s1"}\r\n',
      fetch: makeFakeFetch(200, captured),
      statePath: SEEDED_STATE_PATH,
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(captured[0]!.init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect((body.payload as Record<string, unknown>).session_id).toBe("s1");
  });

  it("handles UTF-8 BOM prefix on stdin (Windows console pipes occasionally inject one)", async () => {
    const captured: CapturedPost[] = [];
    const result = await runHook({
      hookName: "after_create",
      backendUrl: "https://api.example.test",
      stdinJson: '﻿{"session_id": "s1"}',
      fetch: makeFakeFetch(200, captured),
      statePath: SEEDED_STATE_PATH,
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(captured[0]!.init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect((body.payload as Record<string, unknown>).session_id).toBe("s1");
  });
});
