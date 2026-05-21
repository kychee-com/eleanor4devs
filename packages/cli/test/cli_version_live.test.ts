/**
 * F-005 live-network regression — `npx -y @eleanor4devs/cli@latest --version`
 * must print the exact same semver that the npm registry reports as
 * dist-tags.latest. Pins the spec smoke check from a fresh-user context.
 *
 * Skip via ELEANOR4DEVS_SKIP_LIVE_NPM=1 for offline / CI-without-network.
 *
 * RED until v0.0.4 (or any version >= 0.0.4) is published with the
 * F-005 fix landed. GREEN after — and stays GREEN as long as future
 * publishes correctly stamp the version from package.json.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Shipping Surfaces
 * (CLI smoke). Plan: Phase 15 F-005.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

const REGISTRY_URL = "https://registry.npmjs.org/@eleanor4devs/cli";
const NPX_TIMEOUT_MS = 90_000; // npx -y fetch can be slow on a cold cache

const SKIP_LIVE = process.env.ELEANOR4DEVS_SKIP_LIVE_NPM === "1";

interface RegistryPackage {
  "dist-tags"?: { latest?: string };
}

describe.skipIf(SKIP_LIVE)(
  "F-005 regression — CLI --version matches published semver",
  () => {
    it(
      "`npx -y @eleanor4devs/cli@latest --version` prints exactly the registry's latest version",
      async () => {
        // (a) Resolve the registry's latest version.
        const res = await fetch(REGISTRY_URL);
        expect(res.status).toBe(200);
        const meta = (await res.json()) as RegistryPackage;
        const latest = meta["dist-tags"]?.latest;
        expect(latest, "Expected dist-tags.latest on @eleanor4devs/cli").toBeTruthy();
        expect(latest).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);

        // (b) Run the published binary via npx from outside the repo
        //     (cwd is the package dir, but `npx -y <name>@<ver>` fetches
        //     from the registry, never the local repo).
        const stdout = execFileSync(
          "npx",
          ["-y", `@eleanor4devs/cli@${latest}`, "--version"],
          {
            encoding: "utf-8",
            timeout: NPX_TIMEOUT_MS,
            shell: true,
            stdio: ["ignore", "pipe", "ignore"],
          },
        );

        // (c) Assert the printed semver matches the registry's latest.
        const printed = stdout.trim();
        expect(printed).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);
        expect(printed).toBe(latest);
      },
      NPX_TIMEOUT_MS + 5_000,
    );
  },
);
