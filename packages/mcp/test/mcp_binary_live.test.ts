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
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function runMcp(
  args: readonly string[],
  stdin?: string,
  env?: NodeJS.ProcessEnv,
): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(
    "npx",
    ["-y", `@eleanor4devs/mcp@latest`, ...args],
    {
      encoding: "utf-8",
      input: stdin,
      timeout: NPX_TIMEOUT_MS,
      shell: true,
      env: env ?? process.env,
    },
  );
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status,
  };
}

/**
 * Use `npm pack` to download the registry's own tarball for the latest
 * version, then return its absolute path. The path is the input to the
 * `--verify` flow (the binary reads it via ELEANOR4DEVS_VERIFY_TARBALL).
 */
function packLatest(): { path: string; version: string } {
  const dir = mkdtempSync(join(tmpdir(), "eleanor4devs-mcp-pack-"));
  const res = spawnSync(
    "npm",
    ["pack", "@eleanor4devs/mcp@latest", "--silent"],
    {
      cwd: dir,
      encoding: "utf-8",
      shell: true,
      timeout: NPX_TIMEOUT_MS,
    },
  );
  expect(res.status, `npm pack failed: ${res.stderr}`).toBe(0);
  const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  expect(tgz, `expected one .tgz in ${dir}`).toBeTruthy();
  const path = join(dir, tgz as string);
  // Tarball filename shape: `eleanor4devs-mcp-X.Y.Z.tgz`.
  const match = /eleanor4devs-mcp-(\d+\.\d+\.\d+(?:-[\w.-]+)?)\.tgz$/.exec(
    tgz as string,
  );
  expect(match, `unexpected tarball filename: ${tgz}`).toBeTruthy();
  return { path, version: (match as RegExpExecArray)[1]! };
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

    /**
     * F-007 acceptance check: `--verify` against the registry's OWN
     * tarball must return `{ok:true}`. We use `npm pack` to fetch the
     * exact bytes the registry has for the latest version, then run
     * `--verify` with ELEANOR4DEVS_VERIFY_TARBALL pointing at that file.
     *
     * Before F-007 was fixed (Cycle 4, v0.0.4 and earlier), this always
     * returned `{ok:false, error:"shasum_mismatch"}` due to a SHA256-vs-
     * SHA1 algorithm mismatch. From v0.0.5 onwards it must return ok.
     */
    it(
      "`npx -y @eleanor4devs/mcp@latest --verify` returns {ok:true} against the registry's own tarball",
      async () => {
        const { path: tarballPath, version } = packLatest();
        const { stdout, stderr, status } = runMcp(["--verify"], undefined, {
          ...process.env,
          ELEANOR4DEVS_VERIFY_TARBALL: tarballPath,
        });
        // Surface stderr for diagnosis if the assertion fails.
        const trimmed = stdout.trim();
        expect(
          status,
          `expected exit 0, stdout=${trimmed} stderr=${stderr}`,
        ).toBe(0);
        const parsed = JSON.parse(trimmed) as {
          ok: boolean;
          version: string;
          error?: string;
        };
        expect(parsed.ok, `error=${parsed.error}`).toBe(true);
        expect(parsed.version).toBe(version);
      },
      NPX_TIMEOUT_MS + 30_000,
    );
  },
);
