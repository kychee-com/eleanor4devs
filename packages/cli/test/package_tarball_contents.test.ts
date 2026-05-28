/**
 * Pin: the published @eleanor4devs/cli tarball MUST include both the
 * `dist/` (compiled code) AND `skills/` (Core + How-To skill packs)
 * directories. The CLI's `install-skills --core` reads from
 * `<package_root>/skills/eleanor4devs/` at runtime; if that dir is
 * excluded from the npm publish, the command fails on every fresh
 * install with `ENOENT`.
 *
 * Caught 2026-05-25: a `files: ["dist"]` in package.json silently
 * stripped the skills/ tree from the published tarball — present since
 * the initial public package commit, never noticed because no test
 * inspected the actual tarball contents.
 *
 * This test uses `npm pack --dry-run --json` so it runs without
 * actually writing a .tgz to disk and is safe to run in CI on every
 * push.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const PACKAGE_DIR = join(__dirname, "..");

interface NpmPackFile {
  path: string;
}

interface NpmPackEntry {
  files: NpmPackFile[];
}

function listTarballFiles(): string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: PACKAGE_DIR,
    encoding: "utf-8",
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `npm pack --dry-run --json exited ${result.status}: ${result.stderr}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as NpmPackEntry[];
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(
      `expected npm pack --json to return a 1-element array, got ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }
  return parsed[0].files.map((f) => f.path.replace(/\\/g, "/"));
}

describe("@eleanor4devs/cli tarball contents", () => {
  const files = listTarballFiles();

  it("ships the dist/ directory (compiled JS + d.ts)", () => {
    expect(files.some((f) => f === "dist/cli.js")).toBe(true);
    expect(files.some((f) => f === "dist/index.js")).toBe(true);
  });

  it("ships skills/eleanor4devs/ (Core Skills Pack — 7 markdown files)", () => {
    const coreSkills = files.filter((f) =>
      f.startsWith("skills/eleanor4devs/"),
    );
    expect(coreSkills.length).toBeGreaterThanOrEqual(7);
    // Every Core Pack file must be a .md (per Phase 7 line 421).
    for (const f of coreSkills) {
      expect(f.endsWith(".md")).toBe(true);
    }
    // Spot-check known Core Pack members (these are referenced in the
    // spec as required Core Skills).
    expect(files).toContain("skills/eleanor4devs/eleanor4devs-dispatch-thread.md");
    expect(files).toContain("skills/eleanor4devs/eleanor4devs-pause-thread.md");
  });

  it("ships skills/how-to/ (How-To Skills Pack)", () => {
    expect(files).toContain("skills/how-to/eleanor4devs-howto.md");
  });
});
