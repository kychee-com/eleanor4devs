/**
 * Entrypoint detection must be symlink-robust (Phase 29 discovery).
 *
 * `isCliEntrypoint()` decides whether cli.ts auto-dispatches `main()`.
 * The pre-fix comparison was lexical (`pathToFileURL(resolve(argv1))` vs
 * `import.meta.url`), which NEVER matches when the bin is invoked through
 * a symlinked layout — npm workspaces (`node_modules/@eleanor4devs/cli`
 * is a link to `packages/cli`), `npm link`, pnpm-style stores — because
 * node resolves `import.meta.url` through the link to the REAL file
 * while `resolve()` keeps the link path. Result: the CLI exits 0 having
 * printed NOTHING — the worst possible CLI failure mode.
 *
 * The fix realpaths BOTH sides: `entrypointHrefMatches(argv1, moduleUrl)`.
 * The junction fixture below reproduces the exact workspace shape.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { entrypointHrefMatches } from "../src/cli.js";

function fixture(): { realFile: string; linkedFile: string } {
  const root = mkdtempSync(join(tmpdir(), "e4d-entrypoint-"));
  const realPkg = join(root, "packages", "cli", "dist");
  mkdirSync(realPkg, { recursive: true });
  const realFile = join(realPkg, "cli.js");
  writeFileSync(realFile, "// entrypoint fixture\n", "utf-8");
  // The workspace shape: node_modules/@scope/cli -> packages/cli/dist
  // (junction works without admin on Windows; symlink on POSIX).
  const linkDirParent = join(root, "node_modules", "@eleanor4devs");
  mkdirSync(linkDirParent, { recursive: true });
  const linkDir = join(linkDirParent, "cli");
  symlinkSync(join(root, "packages", "cli", "dist"), linkDir, "junction");
  return { realFile, linkedFile: join(linkDir, "cli.js") };
}

describe("entrypointHrefMatches — symlink-robust entrypoint detection", () => {
  it("matches when argv1 is the real path itself", () => {
    const { realFile } = fixture();
    expect(
      entrypointHrefMatches(realFile, pathToFileURL(realFile).href),
    ).toBe(true);
  });

  it("matches when argv1 reaches the module THROUGH a symlink/junction (the npm-workspace bin shape)", () => {
    const { realFile, linkedFile } = fixture();
    // import.meta.url is the REAL path (node resolves through the link);
    // argv1 is the LINKED path (what the .bin shim passes).
    expect(
      entrypointHrefMatches(linkedFile, pathToFileURL(realFile).href),
    ).toBe(true);
  });

  it("does not match a different file", () => {
    const a = fixture();
    const b = fixture();
    expect(
      entrypointHrefMatches(a.realFile, pathToFileURL(b.realFile).href),
    ).toBe(false);
  });

  it("is false for an undefined argv1 (imported-as-module case)", () => {
    const { realFile } = fixture();
    expect(
      entrypointHrefMatches(undefined, pathToFileURL(realFile).href),
    ).toBe(false);
  });

  it("is false for an argv1 that does not exist on disk", () => {
    const { realFile } = fixture();
    expect(
      entrypointHrefMatches(
        join(tmpdir(), "e4d-entrypoint-nonexistent", "cli.js"),
        pathToFileURL(realFile).href,
      ),
    ).toBe(false);
  });
});
