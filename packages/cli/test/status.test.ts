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
