/**
 * TR-006 (Phase 17) live-network regression — `npx -y @eleanor4devs/cli@latest
 * auth --test-mode <code>` against a test-mode-enabled backend must (a)
 * complete the auth handshake non-interactively, (b) persist a refresh
 * token to a temp `~/.eleanor4devs/auth.json`, and (c) the resulting
 * token must be non-empty.
 *
 * Skip via ELEANOR4DEVS_SKIP_LIVE_NPM=1 for offline runs.
 *
 * Doubly gated: this test also requires `ELEANOR4DEVS_TEST_MODE_BASE_URL`
 * to be set to a backend that has `ELEANOR_TEST_MODE=1` enabled. The
 * production backend (`api.eleanor4devs.com`) must NEVER have that env
 * var set, so the test only runs when an explicit alternate base URL is
 * provided. Without it, the test stays SKIP — which is the expected
 * state for CI runs against production.
 *
 * RED until v0.0.6 is published with the `--test-mode` flag landed AND
 * a test-mode-enabled backend is reachable. GREEN once both align.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § System Test
 * Scope step 3. Plan: Phase 17 TR-006 close-out.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NPX_TIMEOUT_MS = 120_000;

const SKIP_LIVE = process.env.ELEANOR4DEVS_SKIP_LIVE_NPM === "1";
const TEST_MODE_BASE_URL = process.env.ELEANOR4DEVS_TEST_MODE_BASE_URL;

interface RegistryPackage {
  "dist-tags"?: { latest?: string };
}

interface IssueResponse {
  code: string;
  poll_token: string;
  expires_at: number;
}

interface CredentialsFile {
  refresh_token?: string;
}

describe.skipIf(SKIP_LIVE || !TEST_MODE_BASE_URL)(
  "TR-006 regression — CLI --test-mode completes auth against a test-mode backend",
  () => {
    it(
      "`npx -y @eleanor4devs/cli@latest auth --test-mode <code>` persists a refresh token",
      async () => {
        // (a) Resolve the registry's latest CLI version (must include the
        //     --test-mode flag, which lands in v0.0.6+).
        const registry = await fetch(
          "https://registry.npmjs.org/@eleanor4devs/cli",
        );
        expect(registry.status).toBe(200);
        const meta = (await registry.json()) as RegistryPackage;
        const latest = meta["dist-tags"]?.latest;
        expect(latest).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);

        // (b) Issue a test-mode auth code from the deployed backend.
        const issueRes = await fetch(
          `${TEST_MODE_BASE_URL}/test/auth/issue`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        expect(
          issueRes.status,
          `Expected 200 from ${TEST_MODE_BASE_URL}/test/auth/issue — is ELEANOR_TEST_MODE=1 set on that backend?`,
        ).toBe(200);
        const issued = (await issueRes.json()) as IssueResponse;
        expect(issued.code).toBeTruthy();

        // (c) Shell `npx -y @eleanor4devs/cli@latest auth --test-mode <code>`
        //     in a temp HOME so the persisted refresh token doesn't clobber
        //     the developer's real CLI session.
        const fakeHome = mkdtempSync(join(tmpdir(), "e4d-tm-home-"));
        try {
          execFileSync(
            "npx",
            [
              "-y",
              `@eleanor4devs/cli@${latest}`,
              "auth",
              "--test-mode",
              issued.code,
            ],
            {
              encoding: "utf-8",
              timeout: NPX_TIMEOUT_MS,
              shell: true,
              stdio: ["ignore", "pipe", "pipe"],
              env: {
                ...process.env,
                ELEANOR4DEVS_API_BASE: TEST_MODE_BASE_URL,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
              },
            },
          );

          // (d) Read ~/.eleanor4devs/auth.json from the temp HOME and
          //     assert a real refresh token landed.
          const authPath = join(fakeHome, ".eleanor4devs", "auth.json");
          expect(
            existsSync(authPath),
            `Expected ${authPath} to exist after auth --test-mode`,
          ).toBe(true);
          const parsed = JSON.parse(
            readFileSync(authPath, "utf-8"),
          ) as CredentialsFile;
          expect(parsed.refresh_token).toBeTruthy();
          expect(typeof parsed.refresh_token).toBe("string");
          // Test-mode refresh tokens are prefixed for audit-distinguishability.
          expect(parsed.refresh_token!.startsWith("test-mode-")).toBe(true);
        } finally {
          rmSync(fakeHome, { recursive: true, force: true });
        }
      },
      NPX_TIMEOUT_MS + 10_000,
    );
  },
);
