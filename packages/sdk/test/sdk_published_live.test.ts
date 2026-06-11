/**
 * F-006 SDK sub-fix live-network regression — fetch the published
 * `@eleanor4devs/sdk@latest` from npm and run the spec smoke check
 * against it from a fresh-user context.
 *
 * Spec smoke (from § npm package):
 *   node -e "import('@eleanor4devs/sdk').then(m => console.log(m.VERSION))"
 *
 * Skip via ELEANOR4DEVS_SKIP_LIVE_NPM=1 for offline runs.
 *
 * RED until v0.0.4 (or any version with the F-006 SDK fix) is published.
 * GREEN after — and stays GREEN as long as future publishes correctly
 * stamp VERSION from package.json.
 *
 * Plan: Phase 15 F-006 SDK sub-fix.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REGISTRY_URL = "https://registry.npmjs.org/@eleanor4devs/sdk";
const NPM_TIMEOUT_MS = 120_000;
const SKIP_LIVE = process.env.ELEANOR4DEVS_SKIP_LIVE_NPM === "1";

interface RegistryPackage {
  "dist-tags"?: { latest?: string };
}

describe.skipIf(SKIP_LIVE)(
  "F-006 SDK regression — published @eleanor4devs/sdk spec smoke",
  () => {
    let tempDir: string | undefined;

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "eleanor4devs-sdk-live-"));
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "live-smoke", version: "0.0.0", type: "module" }),
      );
    });

    afterAll(() => {
      if (tempDir !== undefined) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    });

    it(
      "spec smoke `import('@eleanor4devs/sdk').then(m => console.log(m.VERSION))` prints the registry's latest version",
      async () => {
        // (a) Resolve registry latest.
        const res = await fetch(REGISTRY_URL);
        expect(res.status).toBe(200);
        const meta = (await res.json()) as RegistryPackage;
        const latest = meta["dist-tags"]?.latest;
        expect(latest).toBeTruthy();
        expect(latest).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);

        // (b) Install the latest @eleanor4devs/sdk into the tempdir.
        //     `--min-release-age=0` pins DEFAULT-user semantics: a dev
        //     machine with a `min-release-age` quarantine in ~/.npmrc would
        //     ETARGET on a just-published exact version for the quarantine
        //     window. A real fresh user has no quarantine.
        execFileSync(
          "npm",
          [
            "install",
            `@eleanor4devs/sdk@${latest}`,
            "--no-audit",
            "--no-fund",
            "--min-release-age=0",
          ],
          {
            cwd: tempDir!,
            stdio: "inherit",
            shell: true,
            timeout: NPM_TIMEOUT_MS,
          },
        );

        // (c) Run the spec smoke check.
        // Quote the inline script so cmd.exe doesn't choke on the
        // parentheses (`shell: true` invokes cmd.exe on Windows, which
        // treats unquoted parens as grouping operators and exits 1).
        const smoke = spawnSync(
          "node",
          [
            "-e",
            `"import('@eleanor4devs/sdk').then(m => console.log(m.VERSION))"`,
          ],
          {
            cwd: tempDir!,
            encoding: "utf-8",
            timeout: NPM_TIMEOUT_MS,
            shell: true,
          },
        );
        expect(
          smoke.status,
          `smoke failed. stdout: ${smoke.stdout}\nstderr: ${smoke.stderr}`,
        ).toBe(0);

        // (d) Assert the printed VERSION matches the registry's latest.
        const printed = smoke.stdout.trim();
        expect(printed).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);
        expect(printed).toBe(latest);
      },
      NPM_TIMEOUT_MS + 10_000,
    );
  },
);
