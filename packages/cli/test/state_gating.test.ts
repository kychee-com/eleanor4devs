/**
 * Meta-test (Phase 19, Group D, task 3): every CLI command source file
 * that imports / uses `fetch` MUST also import `readReportingState` —
 * EXCEPT `auth.ts`, which is opt-in by direct user action and unrelated
 * to passive reporting.
 *
 * Why this exists: the Local Reporting Control kill switch only works
 * if every code path that would otherwise POST to the backend consults
 * the state file first. A future contributor who adds a new outbound
 * POST without wiring in the state-gate would silently bypass the
 * privacy invariant. This grep-shaped test prevents that drift.
 *
 * Maintenance: if a new file is genuinely opt-in (like auth.ts is
 * today), add it to ALLOWLISTED_NON_GATED_FILES with a comment
 * explaining why. The default expectation is: a new fetch user gates
 * by readReportingState.
 *
 * Spec cross-reference: docs/products/eleanor4devs/eleanor4devs-spec.md
 *   § Security (line 435).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, "..", "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Files that use `fetch` but are EXEMPT from the state-gate requirement.
 * Each must have a written-down reason.
 */
const ALLOWLISTED_NON_GATED_FILES: ReadonlyMap<string, string> = new Map([
  [
    "commands/auth.ts",
    "auth flow is opt-in by direct user action (`eleanor4devs auth`); unrelated to passive reporting per Phase 19 Group D task 3.",
  ],
]);

describe("Local Reporting Control state-gate coverage (Phase 19, Group D, task 3)", () => {
  it("every src file that calls fetch() also imports readReportingState", () => {
    const tsFiles = listTsFiles(SRC_DIR);
    const offenders: string[] = [];
    for (const filePath of tsFiles) {
      const text = readFileSync(filePath, "utf-8");
      // Look for actual fetch CALLS, not the type name. Match patterns:
      //   - `fetch(`            — direct call or `fetchFn(`-via-alias
      //   - `globalThis.fetch`  — the canonical reference
      const callsFetch =
        /\bfetch\s*\(/.test(text) || /globalThis\.fetch/.test(text);
      if (!callsFetch) continue;

      const relPath = relative(SRC_DIR, filePath).replace(/\\/g, "/");
      if (ALLOWLISTED_NON_GATED_FILES.has(relPath)) continue;

      const importsState = /readReportingState/.test(text);
      if (!importsState) {
        offenders.push(relPath);
      }
    }
    expect(
      offenders,
      `These CLI source files call fetch() but do not import readReportingState. Either add a readReportingState gate or add the file to ALLOWLISTED_NON_GATED_FILES with a reason:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
