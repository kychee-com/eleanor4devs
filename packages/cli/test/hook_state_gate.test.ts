/**
 * Tests for `runHook` state-gate (Phase 19, Group D).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control line 406: "When state is OFF, hook subcommands make NO
 *   network call and exit successfully."
 *
 * The gate runs BEFORE any other work in runHook: no fetch, no stdout
 * write, no audit-log append. We parameterize the test over all four
 * hook names so the early-return invariant holds for every one
 * (especially after_create, whose default-on-failure semantics are
 * FATAL — but a state-OFF early-return must return ok=true, not
 * fatal=true).
 */
import { describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runHook } from "../src/commands/hook.js";
import { ELEANOR_HOOK_NAMES } from "../src/commands/hook_templates.js";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-hook-gate-"));
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

interface CapturedPost {
  url: string;
  init: RequestInit | undefined;
}

function makeFakeFetch(captured: CapturedPost[]): typeof globalThis.fetch {
  return (async (input: unknown, init?: RequestInit) => {
    captured.push({ url: String(input), init });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
}

describe("runHook — state-gate (Phase 19, Group D)", () => {
  it("with state ON, performs the POST", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      writeState(statePath, {
        enabled: true,
        toggled_at: "2026-05-28T15:42:00.000Z",
      });
      const captured: CapturedPost[] = [];
      const result = await runHook({
        hookName: "after_create",
        backendUrl: "https://api.example.test",
        stdinJson: "{}",
        fetch: makeFakeFetch(captured),
        statePath,
      });
      expect(result.ok).toBe(true);
      expect(captured).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with state OFF, returns ok=true and NEVER calls fetch", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      writeState(statePath, {
        enabled: false,
        toggled_at: "2026-05-28T15:00:00.000Z",
      });
      const captured: CapturedPost[] = [];
      const result = await runHook({
        hookName: "after_create",
        backendUrl: "https://api.example.test",
        stdinJson: "{}",
        fetch: makeFakeFetch(captured),
        statePath,
      });
      expect(result.ok).toBe(true);
      expect(result.fatal).toBe(false);
      expect(captured).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with MISSING state file, returns ok=true and NEVER calls fetch (fail-closed)", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      expect(existsSync(statePath)).toBe(false);
      const captured: CapturedPost[] = [];
      const result = await runHook({
        hookName: "after_create",
        backendUrl: "https://api.example.test",
        stdinJson: "{}",
        fetch: makeFakeFetch(captured),
        statePath,
      });
      expect(result.ok).toBe(true);
      expect(result.fatal).toBe(false);
      expect(captured).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with CORRUPT state file, returns ok=true and NEVER calls fetch (fail-closed)", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      writeState(statePath, "not json at all");
      const captured: CapturedPost[] = [];
      const result = await runHook({
        hookName: "after_create",
        backendUrl: "https://api.example.test",
        stdinJson: "{}",
        fetch: makeFakeFetch(captured),
        statePath,
      });
      expect(result.ok).toBe(true);
      expect(result.fatal).toBe(false);
      expect(captured).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(ELEANOR_HOOK_NAMES)(
    "OFF early-return holds for hook '%s' (parameterized)",
    async (hookName) => {
      const dir = freshTempDir();
      try {
        const statePath = join(dir, "state.json");
        writeState(statePath, {
          enabled: false,
          toggled_at: "2026-05-28T15:00:00.000Z",
        });
        const captured: CapturedPost[] = [];
        const result = await runHook({
          hookName,
          backendUrl: "https://api.example.test",
          stdinJson: "{}",
          fetch: makeFakeFetch(captured),
          statePath,
        });
        // ok=true so the CLI returns 0 even for after_create (whose
        // failure-mode is normally FATAL — but a state-OFF early
        // return is NOT a failure).
        expect(result.ok).toBe(true);
        expect(result.fatal).toBe(false);
        expect(captured).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("runHook — side effects under OFF (Phase 19, Group D, audit pass)", () => {
  it("does not mutate audit.log when state is OFF", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const auditPath = join(dir, "audit.log");
      writeState(statePath, {
        enabled: false,
        toggled_at: "2026-05-28T15:00:00.000Z",
      });
      // Seed an existing audit log so we can assert byte-equality.
      writeFileSync(auditPath, "seed-line\n", "utf-8");
      const before = readFileSync(auditPath, "utf-8");
      const beforeStat = statSync(auditPath);

      await runHook({
        hookName: "after_create",
        backendUrl: "https://api.example.test",
        stdinJson: "{}",
        fetch: makeFakeFetch([]),
        statePath,
      });

      const after = readFileSync(auditPath, "utf-8");
      const afterStat = statSync(auditPath);
      expect(after).toBe(before);
      expect(afterStat.size).toBe(beforeStat.size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not write to stdout when state is OFF", async () => {
    const dir = freshTempDir();
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const statePath = join(dir, "state.json");
      writeState(statePath, {
        enabled: false,
        toggled_at: "2026-05-28T15:00:00.000Z",
      });
      await runHook({
        hookName: "after_create",
        backendUrl: "https://api.example.test",
        stdinJson: "{}",
        fetch: makeFakeFetch([]),
        statePath,
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
