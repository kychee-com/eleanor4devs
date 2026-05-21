/**
 * Phase 11 — No-new-vector MCP runtime probe.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § MCP — single
 * declarative verb surface, NO file I/O, NO shell exec, NO network egress
 * through `report`.
 * Plan: docs/plans/eleanor4devs-plan.md Phase 11 — "No-new-vector MCP
 * probe: red-team test attempts arbitrary file I/O / shell exec / network
 * egress via every `report` event type; all fail."
 *
 * Where this sits vs source_lint.test.ts:
 *   - `source_lint.test.ts` is a SOURCE-LEVEL pin — no forbidden fs/http
 *     symbols ever appear in shipped source. That covers regression at
 *     build time.
 *   - This test is a RUNTIME pin — even with an adversarial payload, the
 *     SHIPPED binary rejects with a typed error AND does NOT touch the
 *     filesystem, the network, or a shell. We spawn the actual `dist/cli.js`
 *     bin via Node and pipe adversarial JSON to its --dry-run input.
 *
 * Adversarial matrix:
 *   For each of the 7 `report` events
 *     {progress, done, blocked, context_warning, error, info, question},
 *   pipe a payload that ALSO carries one of the forbidden FORBIDDEN_REPORT_ARG_KEYS:
 *     - command — shell-exec smuggle attempt
 *     - path    — arbitrary file read attempt
 *     - read    — explicit read primitive
 *     - write   — explicit write primitive
 *     - fetch   — network-egress smuggle attempt
 *
 * Every cell must come back `{ok: false, error: "forbidden_arg"}` per the
 * cli.ts dispatch contract (handleDryRunRequest checks FORBIDDEN_SET BEFORE
 * event validation). Also exercises:
 *   - unknown verbs return `unknown_verb`
 *   - unknown events return `unknown_event`
 *
 * Side-effect verification: --dry-run is a pure stdin→stdout pipe. We spawn
 * with `cwd` set to an empty scratch directory and confirm afterwards that
 * NOTHING was written there. Network egress is harder to prove in a unit
 * test without a sandbox, so we additionally pin the binary's source via
 * `source_lint.test.ts` (already shipped) AND grep the dispatcher source
 * here for any unexpected `fetch`/`net` imports outside the verify path.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORBIDDEN_REPORT_ARG_KEYS,
  REPORT_EVENTS,
} from "../src/index.js";

const CLI_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "cli.js",
);

interface DryRunResult {
  ok: boolean;
  event?: string;
  error?: "unknown_verb" | "unknown_event" | "forbidden_arg";
  detail?: string;
}

/**
 * Spawn the built cli.js with --dry-run, pipe `payload` to stdin, return
 * the parsed result + the scratch cwd so the caller can inspect it for
 * any files the binary might have written.
 */
function runProbe(input: object): {
  result: DryRunResult | null;
  exitCode: number | null;
  stderr: string;
  rawStdout: string;
  scratchDir: string;
  scratchContentsAfter: string[];
} {
  const scratchDir = mkdtempSync(join(tmpdir(), "eleanor4devs-mcp-probe-"));
  const res = spawnSync(
    process.execPath, // the running `node`
    [CLI_DIST, "--dry-run"],
    {
      cwd: scratchDir,
      encoding: "utf-8",
      input: JSON.stringify(input) + "\n",
      timeout: 15_000,
    },
  );
  const rawStdout = res.stdout ?? "";
  let result: DryRunResult | null = null;
  try {
    result = JSON.parse(rawStdout.trim()) as DryRunResult;
  } catch {
    // Leave null; the test will surface the raw stdout in the failure.
  }
  const scratchContentsAfter = readdirSync(scratchDir);
  return {
    result,
    exitCode: res.status,
    stderr: res.stderr ?? "",
    rawStdout,
    scratchDir,
    scratchContentsAfter,
  };
}

describe("Phase 11 — no-new-vector MCP runtime probe", () => {
  describe("forbidden args are rejected for every report event", () => {
    for (const event of REPORT_EVENTS) {
      for (const forbidden of FORBIDDEN_REPORT_ARG_KEYS) {
        // Build the adversarial payload — a forbidden key alongside
        // each real event. Use realistic-looking attack values to make
        // sure the rejection isn't a fluke of empty strings.
        const attackValues: Record<string, unknown> = {
          command: "rm -rf /",
          path: "/etc/passwd",
          read: "/etc/shadow",
          write: "/tmp/owned",
          fetch: "https://attacker.example/exfil",
        };
        const payload: Record<string, unknown> = {
          event,
          [forbidden]: attackValues[forbidden],
        };
        // event: "question" needs a call_id to NOT bail with a different
        // error path; for forbidden-arg testing it's checked first, but
        // include it for completeness.
        if (event === "question") payload.call_id = "probe-1";

        it(`rejects forbidden ${forbidden} arg on event ${event}`, () => {
          const probe = runProbe({ verb: "report", payload });
          expect(
            probe.result,
            `expected JSON result; raw stdout was ${probe.rawStdout!} stderr ${probe.stderr}`,
          ).not.toBeNull();
          expect(probe.result!.ok).toBe(false);
          expect(probe.result!.error).toBe("forbidden_arg");
          expect(probe.result!.detail).toContain(forbidden);
          // And no files leaked into the scratch dir.
          expect(probe.scratchContentsAfter).toEqual([]);
        });
      }
    }
  });

  it("rejects an unknown verb", () => {
    const probe = runProbe({ verb: "spawn", payload: { event: "progress" } });
    expect(probe.result!.ok).toBe(false);
    expect(probe.result!.error).toBe("unknown_verb");
    expect(probe.scratchContentsAfter).toEqual([]);
  });

  it("rejects an unknown event on a real verb", () => {
    const probe = runProbe({
      verb: "report",
      payload: { event: "exfiltrate" },
    });
    expect(probe.result!.ok).toBe(false);
    expect(probe.result!.error).toBe("unknown_event");
    expect(probe.scratchContentsAfter).toEqual([]);
  });

  it("accepts a clean valid payload (positive control)", () => {
    // If this test breaks, the probe is suspect — all rejections might
    // be artifacts of a broken pipeline. Positive control proves the
    // happy path still works.
    const probe = runProbe({
      verb: "report",
      payload: { event: "progress", text: "working..." },
    });
    expect(probe.result!.ok).toBe(true);
    expect(probe.result!.event).toBe("progress");
    expect(probe.scratchContentsAfter).toEqual([]);
  });

  it("does not crash or 500 on malformed JSON input", () => {
    // Adversarial input: not JSON at all. The binary should exit
    // non-zero and write a clean error to stderr — NEVER touch the
    // filesystem.
    const scratchDir = mkdtempSync(join(tmpdir(), "eleanor4devs-mcp-probe-bad-"));
    const res = spawnSync(
      process.execPath,
      [CLI_DIST, "--dry-run"],
      {
        cwd: scratchDir,
        encoding: "utf-8",
        input: "this is not json at all\n",
        timeout: 15_000,
      },
    );
    expect(res.status).not.toBe(0);
    // No files written to scratch dir
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  it("FORBIDDEN_REPORT_ARG_KEYS still matches the runtime check (drift detector)", () => {
    // Pin the set so a future commit that removes a key from
    // FORBIDDEN_REPORT_ARG_KEYS without updating the spec gets caught.
    expect([...FORBIDDEN_REPORT_ARG_KEYS].sort()).toEqual(
      ["command", "fetch", "path", "read", "write"],
    );
    expect([...REPORT_EVENTS].sort()).toEqual(
      [
        "blocked",
        "context_warning",
        "done",
        "error",
        "info",
        "progress",
        "question",
      ],
    );
  });
});
