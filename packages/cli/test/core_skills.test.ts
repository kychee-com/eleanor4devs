/**
 * Tests for the Core Skills Pack shipped with the eleanor4devs CLI.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Core Skills
 * Pack — 7 namespaced markdown files installed under
 * ~/.claude/skills/eleanor4devs/ by `eleanor4devs install`. The CLI
 * package vendors the source-of-truth markdown under
 * packages/cli/skills/eleanor4devs/; this test asserts the files
 * exist, are named per the spec, and carry valid frontmatter.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 7 — Core Skills Pack.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "eleanor4devs",
);

const EXPECTED_SKILLS = [
  "eleanor4devs-transfer-control",
  "eleanor4devs-pause-thread",
  "eleanor4devs-wake-thread",
  "eleanor4devs-adopt-session",
  "eleanor4devs-check-focus",
  "eleanor4devs-dispatch-thread",
  "eleanor4devs-summarize-for-voice-review",
] as const;

describe("Core Skills Pack — file presence", () => {
  it("ships exactly the 7 spec-named skill markdown files", () => {
    const filenames = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
    expect(filenames.sort()).toEqual(
      EXPECTED_SKILLS.map((s) => `${s}.md`).sort(),
    );
  });
});

describe("Core Skills Pack — frontmatter validity", () => {
  for (const skill of EXPECTED_SKILLS) {
    it(`${skill}.md has valid YAML frontmatter with name + description`, () => {
      const path = join(SKILLS_DIR, `${skill}.md`);
      const content = readFileSync(path, "utf-8");
      // Frontmatter is delimited by lines of exactly '---'.
      expect(content.startsWith("---\n")).toBe(true);
      const closingIdx = content.indexOf("\n---\n", 4);
      expect(closingIdx).toBeGreaterThan(0);
      const frontmatter = content.slice(4, closingIdx);
      // Quick-and-dirty YAML parse for `name:` and `description:`.
      const nameMatch = frontmatter.match(/^name:\s*(\S.*)$/m);
      const descMatch = frontmatter.match(/^description:\s*(\S.*)$/m);
      expect(nameMatch?.[1]).toBe(skill);
      expect(descMatch?.[1]).toBeTruthy();
      // Body must be substantive (>= 50 chars after the frontmatter).
      const body = content.slice(closingIdx + 5).trim();
      expect(body.length).toBeGreaterThanOrEqual(50);
    });
  }
});
