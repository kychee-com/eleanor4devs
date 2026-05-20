/**
 * F-003 regression test — voice.eleanor4devs.com serves a production-built
 * JS bundle with the correct Content-Type, not the source `/src/main.ts`.
 *
 * Live network test against the deployed Amplify app. Skip with
 * ELEANOR4DEVS_SKIP_LIVE_NPM=1 (same gate as npm_published.test.ts —
 * a single "skip all live network tests" knob).
 *
 * Pinned invariants:
 *   - Root HTML does NOT reference `/src/main.ts` (raw TS source).
 *   - Root HTML references a Vite-built asset under `/assets/`.
 *   - The referenced bundle responds with `Content-Type:
 *     (application|text)/javascript`.
 *
 * This stays RED until the Amplify build picks up the new `amplify.yml`
 * and serves `web/voice/dist/` instead of the source directory. Goes
 * GREEN once the next Amplify deploy after this commit lands.
 */
import { describe, expect, it } from "vitest";

const VOICE_ORIGIN = "https://voice.eleanor4devs.com";

const SKIP_LIVE = process.env.ELEANOR4DEVS_SKIP_LIVE_NPM === "1";

describe.skipIf(SKIP_LIVE)(
  "F-003 regression — voice client production bundle deploy",
  () => {
    it("root HTML does NOT reference /src/main.ts (raw TypeScript)", async () => {
      const res = await fetch(`${VOICE_ORIGIN}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(
        html.includes("/src/main.ts"),
        "Root HTML still references /src/main.ts. The Amplify build " +
          "is not producing/serving the Vite production bundle. Check " +
          "amplify.yml's `web/voice` build phase + Amplify build logs.",
      ).toBe(false);
    });

    it("root HTML references a built asset under /assets/", async () => {
      const res = await fetch(`${VOICE_ORIGIN}/`);
      const html = await res.text();
      // Vite hashes the asset filename (`/assets/main-<hash>.js` or
      // `/assets/index-<hash>.js`). Just assert the presence of an
      // /assets/ script reference + the .js extension.
      const match = html.match(
        /<script[^>]+src="(?<src>(?:\.\/)?assets\/[^"]+\.js)"/,
      );
      expect(
        match,
        "Expected <script src=\"./assets/<name>.js\"> reference in root HTML",
      ).not.toBeNull();
    });

    it("the referenced asset bundle responds with a JavaScript Content-Type", async () => {
      const res = await fetch(`${VOICE_ORIGIN}/`);
      const html = await res.text();
      const match = html.match(
        /<script[^>]+src="(?:\.\/)?(?<src>assets\/[^"]+\.js)"/,
      );
      expect(match).not.toBeNull();
      const bundlePath = match!.groups!.src;
      const bundleRes = await fetch(`${VOICE_ORIGIN}/${bundlePath}`, {
        method: "HEAD",
      });
      expect(bundleRes.status).toBe(200);
      const contentType = bundleRes.headers.get("content-type") ?? "";
      expect(
        /^(application|text)\/javascript/.test(contentType),
        `Expected application/javascript or text/javascript Content-Type ` +
          `for /${bundlePath}, got "${contentType}". Browsers refuse to ` +
          `execute non-JS modules — this is the original F-003 symptom.`,
      ).toBe(true);
    });
  },
);
