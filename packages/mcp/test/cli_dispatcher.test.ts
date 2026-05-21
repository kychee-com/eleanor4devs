/**
 * F-006 regression test — the MCP binary at `dist/cli.js` must dispatch
 * its argv: `--version`, `--help`, `--dry-run`, and unknown-flag cases
 * each have observable behavior (non-silent exit). Before the fix the
 * file exported helpers but had no top-level execution block, so every
 * `node dist/cli.js …` invocation exited 0 silently.
 *
 * Tests spawn `node dist/cli.js` directly via execFileSync. The build
 * must be up-to-date — vitest runs `pretest` if present, otherwise the
 * test sets up the build at the suite level.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § MCP.
 * Plan: Phase 15 F-006.
 */
import { describe, expect, it, beforeAll } from "vitest";
import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, "..");
const DIST_CLI = join(PACKAGE_DIR, "dist", "cli.js");

/** Run `node dist/cli.js <args>` with optional stdin. */
function runCli(
  args: readonly string[],
  stdin?: string,
): SpawnSyncReturns<string> {
  return spawnSync("node", [DIST_CLI, ...args], {
    encoding: "utf-8",
    input: stdin,
    timeout: 15_000,
  });
}

describe("F-006 regression — MCP binary top-level dispatcher", () => {
  beforeAll(() => {
    // Ensure dist/cli.js exists. If the build hasn't run yet, build it.
    if (!existsSync(DIST_CLI)) {
      execFileSync("npm", ["run", "build"], {
        cwd: PACKAGE_DIR,
        stdio: "inherit",
        shell: true,
      });
    }
  });

  it("--version prints a semver string and exits 0", () => {
    const res = runCli(["--version"]);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);
  });

  it("--help prints the flag list and exits 0", () => {
    const res = runCli(["--help"]);
    expect(res.status).toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("--version");
    expect(combined).toContain("--dry-run");
    expect(combined).toContain("--verify");
    expect(combined).toContain("--help");
  });

  it("--dry-run with a valid payload returns ok:true on stdout", () => {
    const res = runCli(
      ["--dry-run"],
      JSON.stringify({ verb: "report", payload: { event: "progress" } }) + "\n",
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"ok":true');
  });

  it("--dry-run with an unknown verb returns unknown_verb on stdout", () => {
    const res = runCli(
      ["--dry-run"],
      JSON.stringify({ verb: "unknown_thing", payload: {} }) + "\n",
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("unknown_verb");
  });

  it("--dry-run with a forbidden arg returns forbidden_arg on stdout", () => {
    const res = runCli(
      ["--dry-run"],
      JSON.stringify({
        verb: "report",
        payload: { event: "progress", path: "/etc/passwd" },
      }) + "\n",
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("forbidden_arg");
  });

  it("--bogus-flag prints an error and exits non-zero", () => {
    const res = runCli(["--bogus-flag"]);
    expect(res.status).not.toBe(0);
    const combined = (res.stdout + res.stderr).toLowerCase();
    expect(combined).toContain("unknown");
  });
});
