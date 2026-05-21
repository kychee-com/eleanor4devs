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

/**
 * F-007 regression pin (Cycle 4): the production `--verify` closure MUST
 * compute the local tarball's SHA512 (base64) and compare against
 * `meta.dist.integrity`. The previous SHA256-against-`dist.shasum`
 * comparison can never succeed (npm's `shasum` is SHA1 hex), so
 * `--verify` always reported `shasum_mismatch`.
 *
 * This source-level pin prevents a future refactor from silently
 * regressing to SHA1/SHA256 for the integrity check by reading the
 * `cli.ts` source directly. We deliberately don't go through the
 * compiled `dist/cli.js` so this test works in a clean checkout
 * before the build runs.
 */
describe("MCP --verify integrity check uses SHA512 (F-007 regression pin)", () => {
  const cliSource = readFileSync(join(SRC_DIR, "cli.ts"), "utf-8");

  it("production runVerify wires sha512: createHash('sha512')", () => {
    // Match the sha512 dep wiring with surrounding context to make sure
    // we're pinning the production injection site, not a stray reference.
    expect(cliSource).toMatch(
      /sha512:\s*\(buf:\s*Buffer\)\s*=>\s*[\r\n\s]*createHash\(["']sha512["']\)\.update\(buf\)\.digest\(["']base64["']\)/,
    );
  });

  it("production runVerify does NOT call createHash('sha256') or createHash('sha1')", () => {
    // Pin negative: no broken-algorithm closures in cli.ts. Comments
    // (covered by `//`) are NOT executable; the regex is intentionally
    // tight on the call site.
    expect(cliSource).not.toMatch(/createHash\(["']sha256["']\)/);
    expect(cliSource).not.toMatch(/createHash\(["']sha1["']\)/);
  });

  it("verifyAgainstRegistry reads dist.integrity, not dist.shasum, for the checksum comparison", () => {
    // The verifier must read `meta.dist.integrity`. We also pin that
    // `dist.shasum` is NEVER consulted in any equality/comparison
    // expression in cli.ts — its only legitimate appearances are in
    // (a) the `RegistryDist` type definition documenting that the
    // registry returns it but we ignore it, and (b) doc comments
    // explaining the F-007 fix. Strip line-comments before scanning
    // so the type definition and explanatory comments don't trigger.
    expect(cliSource).toMatch(/meta\.dist\.integrity/);
    const stripped = cliSource
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, "")) // strip line-comments
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, ""); // strip block-comments
    expect(stripped).not.toMatch(/meta\.dist\.shasum/);
    // Pin the actual comparison-site equality operators against shasum.
    expect(stripped).not.toMatch(/[!=]==\s*meta\.dist\.shasum/);
    expect(stripped).not.toMatch(/meta\.dist\.shasum\s*[!=]==/);
  });

  it("VerifyResult error union includes integrity_mismatch + no_integrity (not shasum_mismatch)", () => {
    // Error code rename guards the rename — if anyone reintroduces
    // `shasum_mismatch` (which was a category error), this fails.
    expect(cliSource).toMatch(/integrity_mismatch/);
    expect(cliSource).toMatch(/no_integrity/);
    // `shasum_mismatch` is the OLD error code — it must not survive the
    // F-007 fix. Permit a free-floating comment about it (the rename
    // story), but disallow it as a string literal in the error union.
    expect(cliSource).not.toMatch(/["']shasum_mismatch["']/);
  });
});
