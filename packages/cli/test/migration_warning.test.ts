/**
 * Tests for the first-run migration UX warning (Phase 23 Group A, [[DD-53]]).
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maybePrintMigrationWarning } from "../src/migration_warning.js";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-migration-warning-"));
}

describe("maybePrintMigrationWarning", () => {
  it("prints the warning when a v1 file is present and no sentinel exists", () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const sentinelPath = join(dir, "migrated_v2");
      writeFileSync(
        statePath,
        JSON.stringify({ enabled: true, toggled_at: "2026-05-29T10:00:00Z" }),
        "utf-8",
      );
      const warnings: string[] = [];
      const printed = maybePrintMigrationWarning({
        statePath,
        sentinelPath,
        warn: (text) => warnings.push(text),
      });
      expect(printed).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("per-session reporting migration");
      expect(warnings[0]).toContain("/e4d");
      // Sentinel was created so we don't nag again.
      expect(existsSync(sentinelPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT print on the second invocation (sentinel suppresses)", () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const sentinelPath = join(dir, "migrated_v2");
      writeFileSync(
        statePath,
        JSON.stringify({ enabled: true, toggled_at: "2026-05-29T10:00:00Z" }),
        "utf-8",
      );
      const warnings: string[] = [];
      maybePrintMigrationWarning({
        statePath,
        sentinelPath,
        warn: (text) => warnings.push(text),
      });
      const printedSecond = maybePrintMigrationWarning({
        statePath,
        sentinelPath,
        warn: (text) => warnings.push(text),
      });
      expect(printedSecond).toBe(false);
      expect(warnings).toHaveLength(1); // still only one
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT print when the state file is already v2", () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const sentinelPath = join(dir, "migrated_v2");
      writeFileSync(
        statePath,
        JSON.stringify({ version: 2, sessions: {} }),
        "utf-8",
      );
      const warnings: string[] = [];
      const printed = maybePrintMigrationWarning({
        statePath,
        sentinelPath,
        warn: (text) => warnings.push(text),
      });
      expect(printed).toBe(false);
      expect(warnings).toEqual([]);
      // No sentinel created — we don't bother for non-migration paths.
      expect(existsSync(sentinelPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT print when no state file exists at all (fresh install)", () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      const sentinelPath = join(dir, "migrated_v2");
      const warnings: string[] = [];
      const printed = maybePrintMigrationWarning({
        statePath,
        sentinelPath,
        warn: (text) => warnings.push(text),
      });
      expect(printed).toBe(false);
      expect(warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a sentinel-write failure is silently swallowed (warning still prints)", () => {
    const dir = freshTempDir();
    try {
      const statePath = join(dir, "state.json");
      writeFileSync(
        statePath,
        JSON.stringify({ enabled: true, toggled_at: "2026-05-29T10:00:00Z" }),
        "utf-8",
      );
      // A sentinel path that points to a file in a non-writable location
      // (here: a path under a regular file rather than a dir). The
      // mkdirSync + writeFileSync will throw — the helper must swallow.
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "x", "utf-8");
      const sentinelPath = join(blocker, "migrated_v2"); // can't mkdir under a file
      const warnings: string[] = [];
      const printed = maybePrintMigrationWarning({
        statePath,
        sentinelPath,
        warn: (text) => warnings.push(text),
      });
      // Warning printed.
      expect(printed).toBe(true);
      expect(warnings).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
