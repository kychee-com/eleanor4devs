/**
 * Meta-test pinning the critical properties of the OIDC publish workflow.
 *
 * Why this lives in `packages/cli/test/`: vitest is already wired here and
 * the cli package is the closest in concept to the "release pipeline."
 * This test does NOT exercise any cli code — it asserts that the YAML at
 * `.github/workflows/publish-all.yml` retains the security/correctness
 * invariants required by DD-27 (OIDC Trusted Publisher publish).
 *
 * A regression in any of these invariants would silently break publishing:
 *   - Missing `id-token: write` → OIDC token never minted → npm 401.
 *   - Missing `--provenance` → attestation gap → npm shows the package
 *     as unverified.
 *   - `npm install` instead of `npm ci` → non-reproducible lockfile state.
 *   - Branch restriction missing → a force-push to a non-main branch
 *     could trigger publish.
 *   - Wrong Node version → npm < 11.5.1 can't do the OIDC exchange.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  ".github",
  "workflows",
  "publish-all.yml",
);

const workflow = readFileSync(WORKFLOW_PATH, "utf-8");

describe("publish-all.yml (DD-27 OIDC Trusted Publisher invariants)", () => {
  it("declares `id-token: write` so GitHub mints the OIDC token", () => {
    // Without this permission the OIDC token isn't issued; `npm publish`
    // then falls back to a stored auth token that doesn't exist → 401.
    expect(workflow).toMatch(/id-token:\s*write/);
  });

  it("declares `contents: write` so the version bump commit + tag can be pushed", () => {
    expect(workflow).toMatch(/contents:\s*write/);
  });

  it("restricts execution to the main branch", () => {
    // workflow_dispatch lets a user pick any branch in the UI; the
    // if-on-job pins the actual publish run to main.
    expect(workflow).toMatch(/if:\s*github\.ref\s*==\s*'refs\/heads\/main'/);
  });

  it("uses Node 24 so npm 11.5.1+ is available for the OIDC exchange", () => {
    // npm 10.x signs provenance but can't exchange the OIDC token for
    // an npm publish credential. Node 24 ships npm 11.x.
    expect(workflow).toMatch(/node-version:\s*'24'/);
  });

  it("uses `npm ci`, not `npm install`, for lockfile-deterministic deps", () => {
    expect(workflow).toMatch(/npm ci/);
    // Negative: a stray `npm install` (without --package-lock-only) would
    // bypass the lockfile and break reproducibility.
    const stray = workflow.match(/^\s*run:\s*npm install\s*$/m);
    expect(stray).toBeNull();
  });

  it("publishes with --provenance so attestation is explicit", () => {
    // OIDC publishes generate provenance implicitly but the flag makes
    // the intent explicit and fails loudly if OIDC isn't actually wired.
    expect(workflow).toMatch(/npm publish[^\n]*--provenance/);
  });

  it("publishes with --access public for the scoped @eleanor4devs/* names", () => {
    expect(workflow).toMatch(/npm publish[^\n]*--access public/);
  });

  it("publishes all 4 @eleanor4devs/* packages", () => {
    // Lockstep across the dep order: provider-contract → sdk → mcp → cli.
    // The publish loop iterates over these names.
    for (const pkg of ["provider-contract", "sdk", "mcp", "cli"]) {
      expect(workflow).toContain(pkg);
    }
  });

  it("includes a tarball smoke step that runs BEFORE the publish step", () => {
    // Smoke catches stray .ts source files / broken imports BEFORE
    // an immutable npm publish. The smoke step name must appear above
    // the publish step name in the workflow source.
    const smokeIdx = workflow.indexOf("Tarball smoke test");
    const publishIdx = workflow.indexOf("Publish to npm");
    expect(smokeIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(-1);
    expect(smokeIdx).toBeLessThan(publishIdx);
  });

  it("commits version bump AFTER the publish step (so partial-fail leaves no trace)", () => {
    // If publish fails mid-way through the 4 packages, the version bump
    // commit never lands on main. Re-running the workflow then starts
    // from the previous version, not a half-bumped one.
    const publishIdx = workflow.indexOf("Publish to npm");
    const commitIdx = workflow.indexOf("Commit lockstep version bump");
    expect(commitIdx).toBeGreaterThan(publishIdx);
  });

  it("does NOT reference NPM_TOKEN (Trusted Publisher means no stored token)", () => {
    // The whole point of DD-27 vs DD-26's predecessor (the deleted
    // release-npm.yml from Phase 7 Task 4) is that we no longer use a
    // stored NPM_TOKEN secret. Any reappearance of NPM_TOKEN in the
    // workflow indicates a regression back to the token-auth path.
    expect(workflow).not.toMatch(/secrets\.NPM_TOKEN/);
    expect(workflow).not.toMatch(/NODE_AUTH_TOKEN/);
  });
});
