/**
 * Source-level architectural enforcement of the DISABLE-ONLY invariant
 * ([[DD-60]], Phase 23 Group A).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Auth & Reporting
 *   Pipeline, line 148 ("Disable-only remote control — privacy invariant").
 *
 * The invariant: reporting can only ever be ENABLED locally by the user
 * via `/e4d`. No other CLI code path may flip a session's record from
 * disabled (or unset) to enabled. The new `hook.ts` cache-the-disabled-
 * response logic is the first ever case where a BACKEND response mutates
 * local opt-in state — that's safe in one direction (toward OFF) but
 * sets a precedent that future refactors must NOT extend toward ON.
 *
 * Architectural enforcement (not just reviewer discipline). Two guards:
 *
 *   1. **No literal `true` enable-writes anywhere.** The CLI's actual opt-in
 *      path (`toggle.ts`) uses a runtime-computed boolean (`newValue = !current.enabled`),
 *      so the literal text `setSessionReporting(<x>, true, …)` should NEVER
 *      appear anywhere in the source. If it does, someone added a hardcoded
 *      "force ON" path — fail loudly.
 *
 *   2. **Allowlist of files that may call `setSessionReporting` at all.**
 *      Limits the API surface to the 2 known callers (the state module
 *      that exports it, and the toggle command that uses it for opt-in/out,
 *      and the hook command for the disable-cache local half). Any new
 *      caller must be added to the allowlist deliberately.
 *
 * If a future task legitimately needs to grow the allowlist or add a
 * literal-true enable, this test must be updated EXPLICITLY (with rationale
 * in the commit and a corresponding spec change). The discomfort of editing
 * this test is the point — it forces a deliberate decision.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(__dirname, "..", "src");

/** Walk all `.ts` files under SRC_ROOT recursively. */
function listTsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...listTsSources(full));
    } else if (s.isFile() && entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Files that may legitimately call `setSessionReporting`. Anything else
 * needs to be added here deliberately, with a commit message + spec
 * justification for why.
 */
const ALLOWLIST: ReadonlyArray<string> = [
  // The state module itself defines + exports the function.
  join("src", "state.ts"),
  // toggle.ts is the user's explicit /e4d opt-in/opt-out path.
  join("src", "commands", "toggle.ts"),
  // hook.ts caches the disabled-response from the backend (disable-only
  // direction — flips ON → OFF locally on a {registered:false, reason:"disabled"}).
  join("src", "commands", "hook.ts"),
];

function isAllowlisted(file: string): boolean {
  return ALLOWLIST.some((suffix) => file.endsWith(suffix));
}

describe("disable-only invariant — source-level architectural guard", () => {
  it("setSessionReporting(*, true, *) literal call sites are forbidden everywhere", () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of listTsSources(SRC_ROOT)) {
      const src = readFileSync(file, "utf-8");
      src.split("\n").forEach((text, i) => {
        // The literal `true` as the second argument is the bypass we
        // forbid. toggle.ts passes a runtime `newValue` instead.
        if (/setSessionReporting\s*\([^,]+,\s*true[\s,)]/.test(text)) {
          offenders.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
        .join("\n");
      throw new Error(
        `[[DD-60]] disable-only invariant VIOLATED — literal opt-IN-true write site(s) found:\n${detail}\n\n` +
          `The opt-IN path in toggle.ts passes a runtime-computed value, not the literal "true". ` +
          `A literal "true" is a hardcoded bypass — refactor or update this test.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it("only allowlisted files may call setSessionReporting at all", () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of listTsSources(SRC_ROOT)) {
      if (isAllowlisted(file)) continue;
      const src = readFileSync(file, "utf-8");
      src.split("\n").forEach((text, i) => {
        if (/\bsetSessionReporting\s*\(/.test(text)) {
          offenders.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
        .join("\n");
      throw new Error(
        `[[DD-60]] disable-only invariant VIOLATED — unauthorized caller(s) of setSessionReporting:\n${detail}\n\n` +
          `Allowlisted files: ${ALLOWLIST.join(", ")}\n` +
          `If this caller is legitimate, add it to ALLOWLIST in this test with rationale.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it("hook.ts only ever flips to false (disable-direction) — never to true", () => {
    const file = readFileSync(
      join(SRC_ROOT, "commands", "hook.ts"),
      "utf-8",
    );
    // Sanity: hook.ts does write (the disabled-cache local half).
    expect(file).toMatch(/setSessionReporting/);
    // But it never enables.
    expect(file).not.toMatch(/setSessionReporting\s*\([^,]+,\s*true/);
  });
});
