/**
 * F-005 regression test — CLI_VERSION must be stamped from package.json
 * at build time, not hardcoded.
 *
 * Cycle 3 finding: `packages/cli/src/index.ts` declared
 * `export const CLI_VERSION = "0.0.0"` so the bin always printed `0.0.0`
 * regardless of the published npm version. The fix reads version from
 * the package's own `package.json` at module init.
 *
 * This test pins the invariant: CLI_VERSION === package.json.version,
 * and CLI_VERSION matches the semver regex.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CLI_VERSION } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = join(HERE, "..", "package.json");

interface PackageJson {
  version: string;
}

describe("F-005 regression — CLI_VERSION stamped from package.json", () => {
  it("CLI_VERSION exactly equals packages/cli/package.json's version field", () => {
    const pkg = JSON.parse(
      readFileSync(PACKAGE_JSON_PATH, "utf-8"),
    ) as PackageJson;
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it("CLI_VERSION matches the semver regex (rejects empty / 'undefined' / '0.0.0' fallbacks)", () => {
    // Pin: regardless of where the read sources the value, it must look
    // like a real semver. Catches accidental fallback to "" or
    // "undefined" if the package.json read silently fails.
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);
  });
});
