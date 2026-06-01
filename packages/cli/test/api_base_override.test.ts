/**
 * Phase 24 / F-008 guardrail — the CLI's backend base URL MUST be an
 * OVERRIDE driven by `process.env.ELEANOR4DEVS_API_BASE`, with the
 * production host (`https://api.eleanor4devs.com`) as the FALLBACK default
 * only. This is what lets the Red Team point the whole CLI at the isolated
 * test-mode service (`test-api.eleanor4devs.com`) via the env var, while
 * everyday users still reach prod.
 *
 * Regression intent: if anyone ever short-circuits the env var (e.g. hardcodes
 * `backendUrl: DEFAULT_API_BASE` without the `process.env.ELEANOR4DEVS_API_BASE ??`
 * prefix, or replaces it with a string literal), the override silently stops
 * working and the Red Team's ELEANOR4DEVS_API_BASE is ignored. This test reads
 * the source of `cli.ts` and pins the env-first / prod-fallback contract
 * structurally, so the break is caught at `npm test` rather than in a failed
 * Red Team cycle.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § System Test Scope
 *   (Red Team sets ELEANOR_TEST_MODE on a side environment). Plan: Phase 24
 *   Group A T5.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf-8");

describe("ELEANOR4DEVS_API_BASE override contract (F-008)", () => {
  it("DEFAULT_API_BASE is the production host", () => {
    expect(CLI_SRC).toMatch(
      /const\s+DEFAULT_API_BASE\s*=\s*["']https:\/\/api\.eleanor4devs\.com["']/,
    );
  });

  it("every DEFAULT_API_BASE use is guarded by process.env.ELEANOR4DEVS_API_BASE ??", () => {
    // Find each reference to DEFAULT_API_BASE that is a *value* (i.e. not the
    // declaration line). Every such reference must be immediately preceded
    // (ignoring whitespace/newlines) by `process.env.ELEANOR4DEVS_API_BASE ??`
    // — the env-first resolution. A bare `DEFAULT_API_BASE` value would mean a
    // surface that ignores the override.
    const lines = CLI_SRC.split("\n");
    const declLine = lines.findIndex((l) =>
      /const\s+DEFAULT_API_BASE\s*=/.test(l),
    );
    expect(declLine).toBeGreaterThanOrEqual(0);

    // Collapse whitespace so a multi-line `process.env.ELEANOR4DEVS_API_BASE ??\n  DEFAULT_API_BASE`
    // is matched the same as a single-line one.
    const collapsed = CLI_SRC.replace(/\s+/g, " ");
    const valueUses = collapsed.match(/DEFAULT_API_BASE/g) ?? [];
    // 1 declaration + N guarded uses. Each guarded use appears as the
    // RHS of `process.env.ELEANOR4DEVS_API_BASE ?? DEFAULT_API_BASE`.
    const guarded =
      collapsed.match(
        /process\.env\.ELEANOR4DEVS_API_BASE\s*\?\?\s*DEFAULT_API_BASE/g,
      ) ?? [];
    // declaration is the only non-guarded occurrence.
    expect(valueUses.length - 1).toBe(guarded.length);
    expect(guarded.length).toBeGreaterThan(0);
  });

  it("does not hardcode the prod URL as a bare backend value anywhere outside the DEFAULT_API_BASE declaration", () => {
    // Any literal "https://api.eleanor4devs.com" in cli.ts must be ONLY the
    // DEFAULT_API_BASE declaration — never inlined as a backendUrl/apiBase
    // value (which would bypass the env override).
    const literalCount = (
      CLI_SRC.match(/https:\/\/api\.eleanor4devs\.com/g) ?? []
    ).length;
    expect(literalCount).toBe(1);
  });
});
