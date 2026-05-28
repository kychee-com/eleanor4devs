/**
 * Tests for `packages/cli/src/state.ts` — the reporting-state read/write
 * module that backs the Local Reporting Control kill switch.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control (acceptance lines 403-407). The reader is FAIL-CLOSED per
 *   [[DD-42]]: missing / unparseable / wrong-shape state file → OFF.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 19, Group A.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import {
  readReportingState,
  writeReportingState,
  DEFAULT_STATE_PATH,
} from "../src/state.js";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-state-"));
}

describe("readReportingState — fail-closed defaults", () => {
  it("returns {enabled: false, toggledAt: null} when the state file is missing", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      expect(existsSync(path)).toBe(false);
      expect(readReportingState({ statePath: path })).toEqual({
        enabled: false,
        toggledAt: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the OFF default when the file contains non-JSON garbage", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(path, "not json", "utf-8");
      expect(readReportingState({ statePath: path })).toEqual({
        enabled: false,
        toggledAt: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the OFF default when the JSON root is an array (not an object)", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(path, "[1,2,3]", "utf-8");
      expect(readReportingState({ statePath: path })).toEqual({
        enabled: false,
        toggledAt: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the OFF default when 'enabled' is the wrong type (string instead of boolean)", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(
        path,
        JSON.stringify({ enabled: "yes", toggled_at: null }),
        "utf-8",
      );
      expect(readReportingState({ statePath: path })).toEqual({
        enabled: false,
        toggledAt: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the OFF default when 'toggled_at' is the wrong type (number instead of string|null)", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(
        path,
        JSON.stringify({ enabled: true, toggled_at: 12345 }),
        "utf-8",
      );
      expect(readReportingState({ statePath: path })).toEqual({
        enabled: false,
        toggledAt: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the correct {enabled, toggledAt} when the file is well-formed", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeFileSync(
        path,
        JSON.stringify({
          enabled: true,
          toggled_at: "2026-05-28T15:42:00Z",
        }),
        "utf-8",
      );
      expect(readReportingState({ statePath: path })).toEqual({
        enabled: true,
        toggledAt: "2026-05-28T15:42:00Z",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeReportingState — atomic write + round-trip", () => {
  it("round-trips a state struct via writeReportingState → readReportingState", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeReportingState(
        { enabled: true, toggledAt: "2026-05-28T15:42:00Z" },
        { statePath: path },
      );
      expect(readReportingState({ statePath: path })).toEqual({
        enabled: true,
        toggledAt: "2026-05-28T15:42:00Z",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-creates the parent directory when it doesn't exist", () => {
    const dir = freshTempDir();
    try {
      const path = join(dir, "nested", "deep", "state.json");
      expect(existsSync(join(dir, "nested"))).toBe(false);
      writeReportingState(
        { enabled: false, toggledAt: "2026-05-28T15:42:00Z" },
        { statePath: path },
      );
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes atomically — never leaves the destination partially written", () => {
    // The atomicity contract is: the writer must write to a `.tmp`
    // sibling and then `rename` it into place. This means: at no point
    // does the destination filename exist with partial contents — it's
    // either absent or contains the full new JSON.
    //
    // We assert the invariant by verifying that after a successful
    // write, there is NO leftover `.tmp` file in the directory (the
    // rename consumed it), AND the destination contains the full JSON.
    const dir = freshTempDir();
    try {
      const path = join(dir, "state.json");
      writeReportingState(
        { enabled: true, toggledAt: "2026-05-28T15:42:00Z" },
        { statePath: path },
      );
      const siblings = readdirSync(dir);
      // No `.tmp` leftover means the rename succeeded.
      expect(siblings.filter((f) => f.endsWith(".tmp"))).toEqual([]);
      // Destination contains complete, parseable JSON (not partial).
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      expect(parsed).toEqual({
        enabled: true,
        toggled_at: "2026-05-28T15:42:00Z",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DEFAULT_STATE_PATH", () => {
  it("resolves to ~/.eleanor4devs/state.json on this machine", () => {
    expect(DEFAULT_STATE_PATH).toBe(
      join(homedir(), ".eleanor4devs", "state.json"),
    );
  });
});
