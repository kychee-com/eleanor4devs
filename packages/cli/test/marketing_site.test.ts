/**
 * F-002 regression test — eleanor4devs.com serves install / privacy / FAQ
 * pages with the required spec content.
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

describe.skipIf(SKIP_LIVE)("F-002 regression — marketing site content", () => {
  it("landing page has Start on Telegram CTA pointing at the bot", async () => {
    const html = await fetchBody("/");
    expect(html).toMatch(/href="https:\/\/t\.me\/eleanor4devs_bot"/);
    expect(html).toMatch(/Start on Telegram/i);
    // No more "Under construction" — the placeholder line is gone.
    expect(html).not.toMatch(/Under construction/i);
  });

  it("install page has copy-paste command + Node 20+ note", async () => {
    const html = await fetchBody("/install/");
    expect(html).toMatch(/npm install -g @eleanor4devs\/cli/);
    expect(html).toMatch(/eleanor4devs install/);
    expect(html).toMatch(/Node 20/);
  });

  it("install page does NOT carry the stale mid-bootstrap notice (P3-3)", async () => {
    // Cycle 3 P3-3 polish: the "Heads up — packages mid-bootstrap" notice
    // was true during the F-001 bootstrap window but became misleading
    // once v0.0.3 went live. Negative assertion ensures any future
    // stale-copy revert breaks CI.
    const html = await fetchBody("/install/");
    expect(html).not.toMatch(/mid-bootstrap/i);
    expect(html).not.toMatch(/packages aren['’]t live/i);
  });

  it("privacy page covers no-new-vector principle + logout (F-009)", async () => {
    const html = await fetchBody("/privacy/");
    expect(html).toMatch(/no-new-vector/i);
    expect(html).toMatch(/eleanor4devs logout/);
    expect(html).not.toMatch(/auth revoke/);
  });

  it("FAQ page contains the required tap-to-call security entry", async () => {
    const html = await fetchBody("/faq/");
    // Per spec acceptance criterion: must state (a) 30-second TTL,
    // (b) single-use rule, (c) rejected-attempt security alert.
    expect(html, "Expected 30-second TTL").toMatch(
      /30[- ]?(second|s)\s*TTL/i,
    );
    expect(html, "Expected single-use rule").toMatch(/single[- ]?use/i);
    expect(html, "Expected rejected-attempt security alert").toMatch(
      /(security|real-time)\s*alert/i,
    );
  });

  it("FAQ page covers the provider matrix", async () => {
    const html = await fetchBody("/faq/");
    expect(html).toMatch(/Claude Code/i);
    expect(html).toMatch(/Codex/i);
    expect(html).toMatch(/provider/i);
  });

  it("FAQ page explains how to sign out (logout) of Eleanor (F-009)", async () => {
    const html = await fetchBody("/faq/");
    expect(html).toMatch(/eleanor4devs logout/);
    expect(html).not.toMatch(/auth revoke/);
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

