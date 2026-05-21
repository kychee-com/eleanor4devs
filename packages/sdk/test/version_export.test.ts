/**
 * F-006 SDK sub-fix regression — `VERSION` must be a named export of
 * `@eleanor4devs/sdk`, stamped from package.json at module init. This
 * is the symbol the spec smoke check tests:
 *   node -e "import('@eleanor4devs/sdk').then(m => console.log(m.VERSION))"
 *
 * Plan: Phase 15 F-006 SDK sub-fix.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = join(HERE, "..", "package.json");

interface PackageJson {
  version: string;
}

describe("F-006 SDK — VERSION export", () => {
  it("VERSION exactly equals packages/sdk/package.json's version field", () => {
    const pkg = JSON.parse(
      readFileSync(PACKAGE_JSON_PATH, "utf-8"),
    ) as PackageJson;
    expect(VERSION).toBe(pkg.version);
  });

  it("VERSION matches the semver regex", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);
  });
});
