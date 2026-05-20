/**
 * F-001 regression test — verifies the 4 @eleanor4devs/* packages are
 * published on the npm registry with OIDC provenance attestations.
 *
 * Live network test. Hits https://registry.npmjs.org directly. Skip via
 * ELEANOR4DEVS_SKIP_LIVE_NPM=1 for offline local runs.
 *
 * This test STAYS RED until the F-001 bootstrap publishes land. Then it
 * goes GREEN and pins the publish-state so any future regression (e.g.
 * an unpublish or a yanked version with no successor) breaks CI.
 *
 * Pinned invariants (per DD-27 + spec § Shipping Surfaces):
 *   - Each package exists in the registry (HTTP 200).
 *   - Each package's `dist-tags.latest` is set.
 *   - Each latest version carries `dist.attestations` — proves the
 *     publish used OIDC Trusted Publisher (rather than a stored token).
 */
import { describe, expect, it } from "vitest";

const PACKAGES = ["provider-contract", "sdk", "mcp", "cli"] as const;
const REGISTRY_BASE = "https://registry.npmjs.org/@eleanor4devs";

const SKIP_LIVE = process.env.ELEANOR4DEVS_SKIP_LIVE_NPM === "1";

interface RegistryPackage {
  "dist-tags"?: { latest?: string };
  versions?: Record<
    string,
    {
      dist?: {
        shasum?: string;
        integrity?: string;
        attestations?: unknown;
      };
    }
  >;
}

describe.skipIf(SKIP_LIVE)(
  "F-001 regression — npm packages published with provenance",
  () => {
    for (const pkg of PACKAGES) {
      it(`@eleanor4devs/${pkg} exists on the npm registry`, async () => {
        const res = await fetch(`${REGISTRY_BASE}/${pkg}`);
        expect(
          res.status,
          `Expected 200 for @eleanor4devs/${pkg}, got ${res.status}. ` +
            `Has F-001 bootstrap publish landed? See .claude/commands/publish.md § Bootstrap.`,
        ).toBe(200);
      });

      it(`@eleanor4devs/${pkg} latest version has OIDC provenance attestation`, async () => {
        const res = await fetch(`${REGISTRY_BASE}/${pkg}`);
        expect(res.status).toBe(200);
        const meta = (await res.json()) as RegistryPackage;
        const latest = meta["dist-tags"]?.latest;
        expect(
          latest,
          `Expected dist-tags.latest on @eleanor4devs/${pkg}`,
        ).toBeTruthy();
        const dist = meta.versions?.[latest!]?.dist;
        expect(
          dist,
          `Expected dist record for @eleanor4devs/${pkg}@${latest}`,
        ).toBeTruthy();
        expect(
          dist!.attestations,
          `Expected provenance attestations on @eleanor4devs/${pkg}@${latest} ` +
            `(OIDC publish). If null, OIDC didn't kick in and the publish ` +
            `silently fell back to anonymous — investigate the workflow run.`,
        ).toBeTruthy();
      });
    }
  },
);
