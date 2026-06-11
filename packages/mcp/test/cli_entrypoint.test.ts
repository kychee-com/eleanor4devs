/**
 * Entrypoint detection must be symlink-robust (Phase 29 discovery —
 * same class of bug as packages/cli, see that package's
 * cli_entrypoint.test.ts).
 *
 * The pre-fix mcp comparison was `pathToFileURL(process.argv[1]).href
 * === import.meta.url` — lexical AND unresolved (no `resolve()`), so a
 * bin invoked through a symlinked layout (npm workspaces, `npm link`)
 * silently never dispatched `main()`: exit 0, no output.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { entrypointHrefMatches } from "../src/cli.js";

function fixture(): { realFile: string; linkedFile: string } {
  const root = mkdtempSync(join(tmpdir(), "e4d-mcp-entrypoint-"));
  const realPkg = join(root, "packages", "mcp", "dist");
  mkdirSync(realPkg, { recursive: true });
  const realFile = join(realPkg, "cli.js");
  writeFileSync(realFile, "// entrypoint fixture\n", "utf-8");
  const linkDirParent = join(root, "node_modules", "@eleanor4devs");
  mkdirSync(linkDirParent, { recursive: true });
  const linkDir = join(linkDirParent, "mcp");
  symlinkSync(join(root, "packages", "mcp", "dist"), linkDir, "junction");
  return { realFile, linkedFile: join(linkDir, "cli.js") };
}

describe("entrypointHrefMatches (mcp) — symlink-robust entrypoint detection", () => {
  it("matches when argv1 is the real path itself", () => {
    const { realFile } = fixture();
    expect(entrypointHrefMatches(realFile, pathToFileURL(realFile).href)).toBe(
      true,
    );
  });

  it("matches when argv1 reaches the module THROUGH a symlink/junction", () => {
    const { realFile, linkedFile } = fixture();
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
});
