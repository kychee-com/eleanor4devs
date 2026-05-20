/**
 * Tests for the `install-skills` CLI command.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI. Copies
 * the bundled Core Skills Pack into the user's `~/.claude/skills/
 * eleanor4devs/`. Per the spec's "Skill review before apply" item,
 * each skill is shown to a `SkillReview` callback (markdown diff
 * before install/update) and only applied when the reviewer accepts.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 7 — CLI install-skills
 * + Skill review before apply.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALWAYS_APPLY,
  installSkills,
  type SkillReview,
} from "../src/commands/install_skills.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGED_SKILLS = join(HERE, "..", "skills", "eleanor4devs");

function freshTargetDir(): string {
  return mkdtempSync(join(tmpdir(), "e4d-install-skills-"));
}

describe("installSkills — fresh install (no existing files)", () => {
  it("copies all 7 packaged skills into the target dir when reviewer accepts each", async () => {
    const target = freshTargetDir();
    try {
      const result = await installSkills({
        sourceDir: PACKAGED_SKILLS,
        targetDir: target,
        review: ALWAYS_APPLY,
      });
      expect(result.installed).toHaveLength(7);
      expect(result.skipped).toHaveLength(0);
      const filenames = readdirSync(target).sort();
      expect(filenames).toEqual(
        readdirSync(PACKAGED_SKILLS).filter((f) => f.endsWith(".md")).sort(),
      );
      // Spot-check one file's contents round-trip clean.
      const src = readFileSync(
        join(PACKAGED_SKILLS, "eleanor4devs-pause-thread.md"),
        "utf-8",
      );
      const tgt = readFileSync(
        join(target, "eleanor4devs-pause-thread.md"),
        "utf-8",
      );
      expect(tgt).toBe(src);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("installSkills — skill review before apply (Task 12)", () => {
  it("skips skills the reviewer rejects and applies the rest", async () => {
    const target = freshTargetDir();
    try {
      const reject: SkillReview = {
        async review(name) {
          return name !== "eleanor4devs-dispatch-thread";
        },
      };
      const result = await installSkills({
        sourceDir: PACKAGED_SKILLS,
        targetDir: target,
        review: reject,
      });
      expect(result.installed).toHaveLength(6);
      expect(result.skipped).toEqual(["eleanor4devs-dispatch-thread"]);
      // Rejected skill MUST NOT be on disk.
      expect(
        existsSync(join(target, "eleanor4devs-dispatch-thread.md")),
      ).toBe(false);
      // Accepted skills ARE on disk.
      expect(
        existsSync(join(target, "eleanor4devs-pause-thread.md")),
      ).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("passes the existing content to the reviewer when updating an existing skill", async () => {
    const target = freshTargetDir();
    try {
      // Pre-populate one skill with placeholder content so the
      // reviewer sees `existing !== null`.
      mkdirSync(target, { recursive: true });
      writeFileSync(
        join(target, "eleanor4devs-pause-thread.md"),
        "---\nname: eleanor4devs-pause-thread\ndescription: old\n---\nOld body\n",
        "utf-8",
      );

      const seen: Array<{ name: string; existingLen: number; incomingLen: number }> = [];
      const recorder: SkillReview = {
        async review(name, existing, incoming) {
          seen.push({
            name,
            existingLen: existing?.length ?? -1,
            incomingLen: incoming.length,
          });
          return true;
        },
      };
      await installSkills({
        sourceDir: PACKAGED_SKILLS,
        targetDir: target,
        review: recorder,
      });
      const pauseRow = seen.find((s) => s.name === "eleanor4devs-pause-thread");
      // existing is non-null (the placeholder we wrote) — length > 0.
      expect(pauseRow?.existingLen).toBeGreaterThan(0);
      // For skills that didn't pre-exist, existing is null (mapped to -1).
      const others = seen.filter((s) => s.name !== "eleanor4devs-pause-thread");
      expect(others.every((s) => s.existingLen === -1)).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("creates the target directory if it doesn't already exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e4d-install-skills-mkdir-"));
    const target = join(dir, "deeply", "nested", "skills-target");
    try {
      const result = await installSkills({
        sourceDir: PACKAGED_SKILLS,
        targetDir: target,
        review: ALWAYS_APPLY,
      });
      expect(result.installed.length).toBeGreaterThan(0);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
