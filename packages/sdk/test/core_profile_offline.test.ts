/**
 * Phase 27 — AC-102 / AC-145: the Core validation profile runs with no
 * network access.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § F-10 SDK
 * (AC-102) + § F-15 Logging & Observability (AC-145).
 *
 * The TypeScript stack's Core profile is `ELEANOR4DEVS_SKIP_LIVE_NPM=1
 * npm test`: every live-network regression test self-gates on that env
 * var and skips under it, so the remaining suite is offline-safe. This
 * meta-test pins the gating convention monorepo-wide: every `*live*`
 * test file in EVERY package must reference the gate — an ungated live
 * test would silently break the Core profile's no-network property.
 * (Grep-shaped pin, same pattern as the CLI's disable-only invariant.)
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const GATE = "ELEANOR4DEVS_SKIP_LIVE_NPM";

function liveTestFiles(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const testDir = join(PACKAGES_ROOT, pkg.name, "test");
    let entries: string[];
    try {
      entries = readdirSync(testDir);
    } catch {
      continue; // package without a test dir
    }
    for (const file of entries) {
      if (file.includes("live") && file.endsWith(".test.ts")) {
        out.push(join(testDir, file));
      }
    }
  }
  return out;
}

describe("AC-102/AC-145 — Core profile is offline-safe", () => {
  it("finds the live-test population (pin is exercised, not vacuous)", () => {
    expect(liveTestFiles().length).toBeGreaterThan(0);
  });

  it("every *live* test file in every package self-gates on the env flag", () => {
    const ungated = liveTestFiles().filter(
      (path) => !readFileSync(path, "utf-8").includes(GATE),
    );
    expect(ungated).toEqual([]);
  });
});
