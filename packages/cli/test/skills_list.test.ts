/**
 * Tests for `eleanor4devs skills list`.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI. Lists
 * installed Eleanor skills (under `~/.claude/skills/eleanor4devs/`).
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 7 — CLI commands.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listSkills } from "../src/commands/skills_list.js";

describe("listSkills", () => {
  it("returns an empty list when the target dir doesn't exist (no install yet)", () => {
    const dir = mkdtempSync(join(tmpdir(), "e4d-list-"));
    const target = join(dir, "missing");
    try {
      expect(listSkills({ targetDir: target })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists installed skills by name (without the .md suffix)", () => {
    const dir = mkdtempSync(join(tmpdir(), "e4d-list-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "eleanor4devs-pause-thread.md"), "x");
      writeFileSync(join(dir, "eleanor4devs-wake-thread.md"), "x");
      // Non-md files are ignored.
      writeFileSync(join(dir, "README.txt"), "ignore me");
      const result = listSkills({ targetDir: dir });
      expect(result.sort()).toEqual([
        "eleanor4devs-pause-thread",
        "eleanor4devs-wake-thread",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
