/**
 * Dispatch test for `eleanor4devs logout` (Phase 22 Group C).
 *
 * Pins that `main(["logout"])` returns 0 on BOTH a linked and an
 * unlinked starting state, and never touches the real HOME credential
 * (the credentials path is redirected via ELEANOR4DEVS_CREDENTIALS_PATH).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { main } from "../src/cli.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e4d-logout-dispatch-"));
  // Redirect credential path off the real HOME, and point the backend at
  // an unreachable address so no real network call (or real revoke) fires.
  process.env.ELEANOR4DEVS_CREDENTIALS_PATH = join(dir, "auth.json");
  process.env.ELEANOR4DEVS_API_BASE = "http://127.0.0.1:1";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.ELEANOR4DEVS_CREDENTIALS_PATH;
  delete process.env.ELEANOR4DEVS_API_BASE;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("main(['logout'])", () => {
  it("returns 0 when not signed in (no credential file)", async () => {
    const code = await main(["logout"]);
    expect(code).toBe(0);
  });

  it("returns 0 when linked and clears the local credential (revoke unreachable)", async () => {
    const credPath = join(dir, "auth.json");
    mkdirSync(dirname(credPath), { recursive: true });
    writeFileSync(credPath, JSON.stringify({ refresh_token: "rt-xyz" }), "utf-8");

    const code = await main(["logout"]);

    expect(code).toBe(0);
    expect(existsSync(credPath)).toBe(false);
  });
});
