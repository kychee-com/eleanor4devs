/**
 * Marketing-site live regression — eleanor4devs.com.
 *
 * CURRENT STATE (2026-06-11): the site is GATED behind a coming-soon page
 * pre-launch; the live suite below pins THAT state. The original F-002
 * content suite (install / privacy / FAQ invariants) is preserved in git
 * history and comes back when the site is un-gated.
 *
 * Live network test against the deployed Amplify app. Skip with
 * ELEANOR4DEVS_SKIP_LIVE_NPM=1 (same gate as the other live network
 * regression tests).
 *
 * Pinned spec invariants (per docs/products/eleanor4devs/eleanor4devs-spec.md
 * § Acceptance Criteria → Marketing Site + spec § Features → Marketing Site):
 *   - Landing page: "Start on Telegram" CTA pointing at the bot.
 *   - Install page: copy-paste `npm install -g @eleanor4devs/cli`
 *     command + Node 20+ requirement.
 *   - Privacy page: "no-new-vector" principle + revoke instructions.
 *   - FAQ page: tap-to-call security entry stating
 *     (a) 30-second TTL, (b) single-use rule, (c) rejected-attempt
 *     security alert; provider matrix; how to revoke access.
 *
 * Stays RED until the next Amplify deploy after this commit lands.
 *
 * F-009 guardrail (Phase 24): the sign-out verb is `eleanor4devs logout`
 * (the real CLI command that POSTs /auth/revoke then deletes the local
 * credential), NEVER `eleanor4devs auth revoke` (there is no `revoke`
 * subcommand — the argv dispatcher treats `auth revoke` as `auth` + an
 * ignored arg, starting a fresh link handshake and leaving the token LIVE).
 * The OFFLINE guardrail below reads the shipped README docs from disk and
 * forbids `auth revoke` outright — deterministic, no network, so a doc
 * regression is caught at `npm test` rather than by the Red Team.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MARKETING_ORIGIN = "https://eleanor4devs.com";

const SKIP_LIVE = process.env.ELEANOR4DEVS_SKIP_LIVE_NPM === "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_README = readFileSync(join(__dirname, "..", "README.md"), "utf-8");
const ROOT_README = readFileSync(
  join(__dirname, "..", "..", "..", "README.md"),
  "utf-8",
);

async function fetchBody(path: string): Promise<string> {
  const res = await fetch(`${MARKETING_ORIGIN}${path}`);
  expect(res.status, `GET ${path} expected 200, got ${res.status}`).toBe(200);
  return res.text();
}

/**
 * GATED (Barry, 2026-06-11): the public marketing site is deliberately
 * serving a coming-soon page pre-launch — the full F-002 content suite
 * (Telegram CTA, install instructions, privacy, FAQ security entry —
 * AC-137..AC-139) is withdrawn from the live site, NOT removed from the
 * product. The pages live in the private repo's git history; RESTORE by
 * reverting the private gating commit and the matching public-repo commit
 * that replaced the describe below (the original tests are in this file's
 * git history).
 */
describe.skipIf(SKIP_LIVE)("marketing site gated — coming-soon state", () => {
  it("landing serves the coming-soon page, noindexed, with no product CTA", async () => {
    const html = await fetchBody("/");
    expect(html).toMatch(/coming soon/i);
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow">/);
    expect(html).not.toMatch(/Start on Telegram/i);
    expect(html).not.toMatch(/t\.me\/eleanor4devs_bot/);
  });

  it("robots.txt disallows everything", async () => {
    const body = await fetchBody("/robots.txt");
    expect(body).toMatch(/User-agent:\s*\*/);
    expect(body).toMatch(/Disallow:\s*\//);
  });

  it("the former content pages no longer serve product documentation", async () => {
    for (const path of ["/install/", "/faq/", "/privacy/", "/security/"]) {
      const res = await fetch(`${MARKETING_ORIGIN}${path}`);
      const body = await res.text();
      // Either the path is gone (4xx) or a rewrite serves the coming-soon
      // shell — never the withdrawn product docs.
      if (res.status === 200) {
        expect(body, `${path} should serve coming-soon, not docs`).toMatch(
          /coming soon/i,
        );
      } else {
        expect(res.status, `${path} expected 4xx`).toBeGreaterThanOrEqual(400);
      }
      expect(body).not.toMatch(/npm install -g @eleanor4devs\/cli/);
      expect(body).not.toMatch(/tap-to-call/i);
      expect(body).not.toMatch(/no-new-vector/i);
    }
  });
});

describe("F-009 offline guardrail — README sign-out verb is `logout`, not `auth revoke`", () => {
  it("CLI README uses `eleanor4devs logout` and never `auth revoke`", () => {
    expect(CLI_README).toMatch(/eleanor4devs logout/);
    expect(CLI_README).not.toMatch(/auth revoke/);
  });

  it("root README uses `eleanor4devs logout` and never `auth revoke`", () => {
    expect(ROOT_README).toMatch(/eleanor4devs logout/);
    expect(ROOT_README).not.toMatch(/auth revoke/);
  });
});

