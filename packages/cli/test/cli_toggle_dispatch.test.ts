/**
 * Tests for the cli.ts dispatcher's `on / off / toggle` cases (Phase 19,
 * Group B). Also asserts the help text lists all three verbs.
 *
 * We test via child-process spawns of the built CLI so HOME/USERPROFILE
 * can be overridden per-invocation — the module-level STATE_PATH /
 * DEFAULT_AUDIT_LOG_PATH constants are captured at import time, so an
 * in-process re-import wouldn't pick up env changes.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_JS = join(HERE, "..", "dist", "cli.js");

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "e4d-cli-disp-"));
}

function runCli(
  args: string[],
  home: string,
): { code: number | null; stdout: string; stderr: string } {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  const res = spawnSync(process.execPath, [CLI_JS, ...args], {
    env,
    encoding: "utf-8",
  });
  return {
    code: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("cli dispatcher — on/off/toggle (requires built dist/cli.js)", () => {
  // The tests need the compiled CLI. Skip cleanly if it isn't built.
  beforeAll(() => {
    if (!existsSync(CLI_JS)) {
      // eslint-disable-next-line no-console
      console.warn(
        `dist/cli.js not built — skipping cli_toggle_dispatch tests. Run \`npm run build --workspace @eleanor4devs/cli\` first.`,
      );
    }
  });

  it.skipIf(!existsSync(CLI_JS))(
    "main(['on']) returns 0 and writes state.json with enabled=true",
    () => {
      const home = isolatedHome();
      try {
        const res = runCli(["on"], home);
        expect(res.code).toBe(0);
        expect(res.stdout.trim()).toBe("Eleanor4Devs is now ON.");
        const statePath = join(home, ".eleanor4devs", "state.json");
        expect(existsSync(statePath)).toBe(true);
        const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
        expect(parsed.enabled).toBe(true);
        expect(typeof parsed.toggled_at).toBe("string");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!existsSync(CLI_JS))(
    "main(['off']) returns 0 and writes state.json with enabled=false",
    () => {
      const home = isolatedHome();
      try {
        const res = runCli(["off"], home);
        expect(res.code).toBe(0);
        expect(res.stdout.trim()).toBe("Eleanor4Devs is now OFF.");
        const statePath = join(home, ".eleanor4devs", "state.json");
        const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
        expect(parsed.enabled).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!existsSync(CLI_JS))(
    "main(['toggle']) flips relative to current state.json",
    () => {
      const home = isolatedHome();
      try {
        // Start at OFF (explicit) so the flip is deterministic.
        runCli(["off"], home);
        const r1 = runCli(["toggle"], home);
        expect(r1.code).toBe(0);
        expect(r1.stdout.trim()).toBe("Eleanor4Devs is now ON.");

        const r2 = runCli(["toggle"], home);
        expect(r2.code).toBe(0);
        expect(r2.stdout.trim()).toBe("Eleanor4Devs is now OFF.");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!existsSync(CLI_JS))(
    "--help output lists on / off / toggle verbs",
    () => {
      const home = isolatedHome();
      try {
        const res = runCli(["--help"], home);
        expect(res.code).toBe(0);
        expect(res.stdout).toMatch(/eleanor4devs on /);
        expect(res.stdout).toMatch(/eleanor4devs off /);
        expect(res.stdout).toMatch(/eleanor4devs toggle/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!existsSync(CLI_JS))(
    "main(['status']) returns 0 and first line matches one of the three documented patterns",
    () => {
      const home = isolatedHome();
      try {
        const res = runCli(["status"], home);
        expect(res.code).toBe(0);
        const firstLine = res.stdout.split(/\r?\n/)[0] ?? "";
        const patterns = [
          /^Eleanor4Devs reporting: ON \(since .+\)$/,
          /^Eleanor4Devs reporting: OFF \(since .+\)$/,
          /^Eleanor4Devs reporting: OFF \(no toggle recorded\)$/,
        ];
        expect(patterns.some((p) => p.test(firstLine))).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
