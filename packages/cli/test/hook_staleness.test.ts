/**
 * Tests for `runHook` staleness wiring (Phase 26, Group C — [[DD-70]]).
 *
 * Spec v0.15.0 § Local Reporting Control:
 *   - When a lifecycle hook fires for an opted-in session, its `last_seen_at`
 *     is refreshed (DEBOUNCED — at most ~1/hour/session).
 *   - A record with no hook activity for the staleness window (default 72h) is
 *     pruned on the next `eleanor4devs` invocation; if that was the last
 *     enabled record, the four hooks de-register (machine → zero e4d hooks).
 *   - A NOT-opted-in session is fully inert: no settings mutation, no state
 *     mutation, no network call (the Phase 23 gate, carried forward).
 *   - Every staleness operation is best-effort: a prune / de-register / refresh
 *     failure NEVER changes the hook's exit 0.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 26, Group C.
 *
 * Order (load-bearing): PRUNE first, THEN refresh. A >window-dormant session
 * firing a hook must be PRUNED (DD-70 bounds auto-reactivation at the window —
 * recovery needs a fresh `/e4d` on), not resurrected by a refresh-first stamp.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHook } from "../src/commands/hook.js";
import { readSessionReporting } from "../src/state.js";
import { registerHooks } from "../src/commands/hook_registry.js";
import {
  ELEANOR_HOOK_EVENT_MAP,
  isEleanorHookEntry,
  type ClaudeHookEntry,
} from "../src/commands/hook_templates.js";

const SID_A = "11111111-1111-1111-1111-111111111111";
const SID_B = "22222222-2222-2222-2222-222222222222";
const BACKEND = "https://api.eleanor4devs.com";
const ALL_EVENTS = Object.values(ELEANOR_HOOK_EVENT_MAP);

const BASE = Date.parse("2026-06-01T00:00:00.000Z");
function at(offsetHours: number): Date {
  return new Date(BASE + offsetHours * 3600_000);
}
function iso(offsetHours: number): string {
  return at(offsetHours).toISOString();
}

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-hook-staleness-"));
}

interface OnDiskRecord {
  enabled: boolean;
  toggled_at: string | null;
  last_seen_at?: string | null;
}

function writeV2(path: string, sessions: Record<string, OnDiskRecord>): void {
  writeFileSync(
    path,
    JSON.stringify({ version: 2, sessions }, null, 2) + "\n",
    "utf-8",
  );
}

function readRaw(path: string): Record<string, OnDiskRecord> {
  return (
    JSON.parse(readFileSync(path, "utf-8")) as {
      sessions: Record<string, OnDiskRecord>;
    }
  ).sessions;
}

interface Settings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  [k: string]: unknown;
}

function totalEleanorEntries(settingsPath: string): number {
  if (!existsSync(settingsPath)) return 0;
  const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as Settings;
  return ALL_EVENTS.reduce(
    (n, ev) => n + (s.hooks?.[ev] ?? []).filter((e) => isEleanorHookEntry(e)).length,
    0,
  );
}

/** Empty-route fetch — throws if any network call is attempted. */
function strictFetch(): typeof globalThis.fetch {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    throw new Error(`unexpected network call: ${url}`);
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// refreshLastSeen wiring — opted-in hooks stamp last_seen_at, debounced.
// ---------------------------------------------------------------------------

describe("runHook — refreshes last_seen_at for opted-in sessions", () => {
  it("an opted-in hook event past the debounce stamps last_seen_at", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      // Opted in at hour 0, no credential — the staleness block runs before
      // the credential read, so a refresh happens regardless of linking.
      writeV2(statePath, { [SID_A]: { enabled: true, toggled_at: iso(0) } });
      const result = await runHook({
        hookName: "before_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        credentialsPath: join(dir, "auth.json"),
        auditLogPath: join(dir, "audit.log"),
        now: () => at(2), // 2h later, beyond the 1h debounce
        fetch: strictFetch(),
      });
      expect(result.ok).toBe(true);
      expect(readRaw(statePath)[SID_A].last_seen_at).toBe(iso(2));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second hook within the debounce interval does not rewrite state.json", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      writeV2(statePath, { [SID_A]: { enabled: true, toggled_at: iso(0) } });
      const common = {
        hookName: "after_run" as const,
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        credentialsPath: join(dir, "auth.json"),
        auditLogPath: join(dir, "audit.log"),
        fetch: strictFetch(),
      };
      await runHook({ ...common, now: () => at(2) }); // writes last_seen=at(2)
      const afterFirst = readFileSync(statePath, "utf-8");
      await runHook({ ...common, now: () => at(2.5) }); // within 1h → no write
      expect(readFileSync(statePath, "utf-8")).toBe(afterFirst);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Staleness prune + de-register on the last enabled session.
// ---------------------------------------------------------------------------

describe("runHook — prunes stale records + de-registers when the set empties", () => {
  it("a hook after >window dormancy on the LAST enabled session prunes it AND de-registers", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const settingsPath = join(dir, ".claude", "settings.json");
      // Opted in at hour 0, dormant ever since (100h ago at the hook time).
      writeV2(statePath, { [SID_A]: { enabled: true, toggled_at: iso(0) } });
      registerHooks(settingsPath);
      expect(totalEleanorEntries(settingsPath)).toBe(4);

      const result = await runHook({
        hookName: "before_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        settingsPath,
        credentialsPath: join(dir, "auth.json"),
        auditLogPath: join(dir, "audit.log"),
        now: () => at(100), // 100h after the toggle → past the 72h window
        fetch: strictFetch(),
      });

      expect(result.ok).toBe(true);
      // The stale last enabled record was pruned → reads as not-enabled.
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(false);
      // ...and the now-orphaned hooks were de-registered.
      expect(totalEleanorEntries(settingsPath)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the hooks when another enabled session survives the prune", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const settingsPath = join(dir, ".claude", "settings.json");
      writeV2(statePath, {
        [SID_A]: { enabled: true, toggled_at: iso(0) }, // 100h dormant → stale
        [SID_B]: { enabled: true, toggled_at: iso(99) }, // 1h dormant → fresh
      });
      registerHooks(settingsPath);

      const result = await runHook({
        hookName: "before_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        settingsPath,
        credentialsPath: join(dir, "auth.json"),
        auditLogPath: join(dir, "audit.log"),
        now: () => at(100),
        fetch: strictFetch(),
      });

      expect(result.ok).toBe(true);
      expect(readSessionReporting(SID_A, { statePath }).enabled).toBe(false);
      expect(readSessionReporting(SID_B, { statePath }).enabled).toBe(true);
      // SID_B keeps the machine opted in → hooks stay registered.
      expect(totalEleanorEntries(settingsPath)).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 23 gate regression — a NOT-opted-in session is fully inert.
// ---------------------------------------------------------------------------

describe("runHook — not-opted-in session performs zero mutation (Phase 23 gate)", () => {
  it("makes no network call, no state mutation, and no settings mutation", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const settingsPath = join(dir, ".claude", "settings.json");
      // SID_A is NOT opted in; hooks happen to be registered (by some other
      // opted-in session on the machine).
      writeV2(statePath, { [SID_B]: { enabled: true, toggled_at: iso(99) } });
      registerHooks(settingsPath);
      const stateBefore = readFileSync(statePath, "utf-8");
      const settingsBefore = readFileSync(settingsPath, "utf-8");

      const result = await runHook({
        hookName: "before_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }), // not opted in
        statePath,
        settingsPath,
        credentialsPath: join(dir, "auth.json"),
        auditLogPath: join(dir, "audit.log"),
        now: () => at(100),
        fetch: strictFetch(),
      });

      expect(result.ok).toBe(true);
      // Gate returned before the staleness block: nothing touched.
      expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
      expect(readFileSync(settingsPath, "utf-8")).toBe(settingsBefore);
      expect(existsSync(join(dir, "audit.log"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Non-fatal invariant — a staleness write failure never changes exit 0.
// ---------------------------------------------------------------------------

describe("runHook — staleness failures are non-fatal", () => {
  it("a failed prune/refresh write (blocked .tmp) leaves the hook ok and exit 0", async () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      // Stale enabled record → the prune WILL attempt a rewrite.
      writeV2(statePath, { [SID_A]: { enabled: true, toggled_at: iso(0) } });
      // Block the atomic write: a DIRECTORY where the temp file must be created
      // makes writeFileSync(`${path}.tmp`, …) throw EISDIR deterministically.
      mkdirSync(`${statePath}.tmp`, { recursive: true });

      const result = await runHook({
        hookName: "before_run",
        backendUrl: BACKEND,
        stdinJson: JSON.stringify({ session_id: SID_A }),
        statePath,
        credentialsPath: join(dir, "auth.json"),
        auditLogPath: join(dir, "audit.log"),
        now: () => at(100),
        fetch: strictFetch(),
      });

      // The blocked write threw inside the staleness block, but it was caught:
      // the hook still resolves ok and (in cli.ts) exits 0.
      expect(result.ok).toBe(true);
      expect(result.fatal).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
