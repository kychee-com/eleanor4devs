/**
 * Source-level credential-isolation lint for @eleanor4devs/mcp.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § MCP. The
 * MCP server is a single-verb report surface — it must not perform
 * arbitrary file reads, network egress, or shell exec. This test
 * scans the package's source files for those forbidden patterns and
 * fails the suite (and therefore CI) if any appear.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 7 — MCP credential
 * isolation (source-level CI lint).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

interface ForbiddenPattern {
  name: string;
  // Regex matched against the file contents. Word-boundaries on
  // either side so e.g. `fs.read` doesn't match a comment about
  // "read".
  pattern: RegExp;
  // Files allowed to contain the pattern (the audit log writer is
  // the only file allowed to use fs.* APIs, and it only ever
  // appends).
  allowedFiles?: readonly string[];
}

const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  // File reads — the MCP must never read user files.
  // Exception: `cli.ts` reads ITS OWN package's tarball during `--verify`
  // to checksum it against the npm registry's published shasum. That's
  // an opt-in supply-chain command, not a runtime path.
  {
    name: "fs.read / readFileSync / createReadStream",
    pattern: /\b(readFileSync|readFile|createReadStream)\b/,
    allowedFiles: ["cli.ts"],
  },
  // Network egress — the MCP talks to its parent process via stdio.
  // Outbound HTTP belongs to the backend, never the MCP.
  // Exception: `cli.ts` fetches the npm registry metadata during
  // `--verify` (single fixed destination, no user input).
  {
    name: "fetch / http.get / https.get / node-fetch",
    pattern: /\b(fetch\s*\(|https?\.get\s*\(|node-fetch)\b/,
    allowedFiles: ["cli.ts"],
  },
  // Shell exec — the MCP must never spawn child processes.
  {
    name: "child_process spawn/exec/execSync",
    pattern: /\b(child_process|spawn\s*\(|execSync|execFile|exec\s*\()\b/,
  },
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("MCP source-level credential isolation lint", () => {
  const sources = listTsFiles(SRC_DIR);

  it("finds source files to scan (sanity check)", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  for (const file of sources) {
    const relative = file.slice(SRC_DIR.length + 1).replace(/\\/g, "/");
    it(`${relative} contains no forbidden I/O patterns`, () => {
      const contents = readFileSync(file, "utf-8");
      for (const { name, pattern, allowedFiles } of FORBIDDEN_PATTERNS) {
        if (allowedFiles?.includes(relative)) continue;
        expect(contents, `${relative} uses forbidden pattern: ${name}`)
          .not.toMatch(pattern);
      }
    });
  }
});
