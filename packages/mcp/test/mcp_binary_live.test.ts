/**
 * F-006 live-network regression — `npx -y @eleanor4devs/mcp@latest`
 * with each supported flag must produce the expected output. Pins the
 * end-to-end spec smoke from a fresh-user context (no repo access).
 *
 * Skip via ELEANOR4DEVS_SKIP_LIVE_NPM=1 for offline / CI-without-network.
 *
 * RED until v0.0.4 (or any version that includes the F-006 dispatcher
 * fix) is published. GREEN after the dispatcher reaches the registry.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § MCP smoke check.
 * Plan: Phase 15 F-006.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

const REGISTRY_URL = "https://registry.npmjs.org/@eleanor4devs/mcp";
const NPX_TIMEOUT_MS = 90_000;

const SKIP_LIVE = process.env.ELEANOR4DEVS_SKIP_LIVE_NPM === "1";

interface RegistryPackage {
  "dist-tags"?: { latest?: string };
}

async function latestVersion(): Promise<string> {
  const res = await fetch(REGISTRY_URL);
  expect(res.status).toBe(200);
  const meta = (await res.json()) as RegistryPackage;
  const latest = meta["dist-tags"]?.latest;
  expect(latest, "Expected dist-tags.latest on @eleanor4devs/mcp").toBeTruthy();
  return latest as string;
}

function runMcp(args: readonly string[], stdin?: string): { stdout: string; status: number | null } {
  const res = spawnSync(
    "npx",
    ["-y", `@eleanor4devs/mcp@latest`, ...args],
    {
      encoding: "utf-8",
      input: stdin,
      timeout: NPX_TIMEOUT_MS,
      shell: true,
    },
  );
  return { stdout: res.stdout ?? "", status: res.status };
}

describe.skipIf(SKIP_LIVE)(
  "F-006 regression — MCP binary dispatch via npx",
  () => {
    it(
      "`npx -y @eleanor4devs/mcp@latest --version` prints the registry's latest version",
      async () => {
        const latest = await latestVersion();
        expect(latest).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);
        const { stdout, status } = runMcp(["--version"]);
        expect(status).toBe(0);
        expect(stdout.trim()).toBe(latest);
      },
      NPX_TIMEOUT_MS + 5_000,
    );

    it(
      "`npx -y @eleanor4devs/mcp@latest --help` lists the supported flags",
      async () => {
        const { stdout, status } = runMcp(["--help"]);
        expect(status).toBe(0);
        expect(stdout).toContain("--version");
        expect(stdout).toContain("--dry-run");
        expect(stdout).toContain("--verify");
        expect(stdout).toContain("--help");
      },
      NPX_TIMEOUT_MS + 5_000,
    );

    it(
      "`npx -y @eleanor4devs/mcp@latest --dry-run` accepts a valid report payload",
      async () => {
        const { stdout, status } = runMcp(
          ["--dry-run"],
          JSON.stringify({
            verb: "report",
            payload: { event: "progress" },
          }) + "\n",
        );
        expect(status).toBe(0);
        expect(stdout).toContain('"ok":true');
      },
      NPX_TIMEOUT_MS + 5_000,
    );

    it(
      "`npx -y @eleanor4devs/mcp@latest --dry-run` rejects an unknown verb",
      async () => {
        const { stdout, status } = runMcp(
          ["--dry-run"],
          JSON.stringify({ verb: "foo", payload: {} }) + "\n",
        );
        expect(status).toBe(0);
        expect(stdout).toContain("unknown_verb");
      },
      NPX_TIMEOUT_MS + 5_000,
    );
  },
);
