/**
 * Phase 27 — AC-97: "Every Core Pack skill is markdown-only (no `.js`,
 * `.py`, or executable shell files)."
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § F-9 Skills.
 * Plan: docs/plans/eleanor4devs-plan.md Phase 27 (skills-pack
 * markdown-only pin).
 *
 * Two layers:
 *   1. The VENDORED pack sources (packages/cli/skills/**) contain only
 *      `.md` files — nothing executable can ship in the npm tarball's
 *      skills payload. (The sibling core_skills.test.ts FILTERS to .md
 *      before asserting, so a stray evil.js would pass it — this test
 *      walks every entry unfiltered.)
 *   2. The installer (`installSkills`) writes only `.md` files into the
 *      user's skills dir even when a non-markdown file is present in
 *      the source directory.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installSkills } from "../src/commands/install_skills.js";

const PACKS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

describe("AC-97 — vendored skill packs are markdown-only", () => {
  it("every file under packages/cli/skills/ (all packs, recursive) is .md", () => {
    const files = walkFiles(PACKS_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const nonMarkdown = files.filter((f) => !f.endsWith(".md"));
    expect(nonMarkdown).toEqual([]);
  });

  it("core pack directory entries are plain .md files (no subdirs, no other types)", () => {
    const entries = readdirSync(join(PACKS_ROOT, "eleanor4devs"), {
      withFileTypes: true,
    });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.isFile(), `${entry.name} must be a regular file`).toBe(true);
      expect(entry.name.endsWith(".md"), `${entry.name} must be .md`).toBe(true);
    }
  });

  it("how-to pack directory entries are plain .md files", () => {
    const entries = readdirSync(join(PACKS_ROOT, "how-to"), {
      withFileTypes: true,
    });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.isFile(), `${entry.name} must be a regular file`).toBe(true);
      expect(entry.name.endsWith(".md"), `${entry.name} must be .md`).toBe(true);
    }
  });
});

describe("AC-97 — installer never writes non-markdown files", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("a hostile source dir with .js/.sh files installs only the .md skills", async () => {
    const source = tempDir("e4d-md-src-");
    const target = tempDir("e4d-md-dst-");
    writeFileSync(join(source, "good-skill.md"), "---\nname: good-skill\n---\nbody");
    writeFileSync(join(source, "evil.js"), "console.log('pwned')");
    writeFileSync(join(source, "run.sh"), "#!/bin/sh\necho pwned");
    mkdirSync(join(source, "nested"));
    writeFileSync(join(source, "nested", "deep.py"), "print('pwned')");

    const result = await installSkills({ sourceDir: source, targetDir: target });

    expect(result.installed).toEqual(["good-skill"]);
    const written = readdirSync(target);
    expect(written).toEqual(["good-skill.md"]);
  });
});
