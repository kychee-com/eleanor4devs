/**
 * Install hygiene tests ([[DD-64]], Phase 23 Group A).
 *
 * Spec invariants enforced here:
 *
 *   1. `eleanor4devs install` NEVER writes `CLAUDE.md` or `AGENTS.md`.
 *      On Kychee-style setups, those paths are symlinks into a git repo
 *      that the user manages by hand — silently editing through the
 *      symlink would corrupt their version-controlled config. We pin
 *      the invariant with a grep meta-test rather than a runtime check.
 *
 *   2. `settings.json` writes are symlink-aware: when the target is a
 *      symlink, the install reports the resolved real path so the user
 *      knows where bytes actually landed.
 */
import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

import { install } from "../src/commands/install.js";
import { ALWAYS_APPLY } from "../src/commands/install_skills.js";

const SRC_ROOT = join(__dirname, "..", "src");

function listTsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...listTsSources(full));
    } else if (s.isFile() && entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function freshTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "e4d-install-hygiene-"));
  mkdirSync(join(dir, "src-skills"), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// (1) Invariant: install NEVER references CLAUDE.md / AGENTS.md anywhere.
// ---------------------------------------------------------------------------

describe("install hygiene — no CLAUDE.md / AGENTS.md write paths anywhere in CLI source", () => {
  it("no install/CLI source references the strings 'CLAUDE.md' or 'AGENTS.md'", () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of listTsSources(SRC_ROOT)) {
      const src = readFileSync(file, "utf-8");
      src.split("\n").forEach((text, i) => {
        if (/\bCLAUDE\.md\b/.test(text) || /\bAGENTS\.md\b/.test(text)) {
          offenders.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
        .join("\n");
      throw new Error(
        `[[DD-64]] install hygiene VIOLATED — CLI source references CLAUDE.md / AGENTS.md:\n${detail}\n\n` +
          `On Kychee-style setups those files are symlinks into a git repo. The installer must NEVER ` +
          `write them. If a future install task legitimately needs to touch them, update this test ` +
          `with rationale.`,
      );
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (2) settings.json symlink-awareness — install reports the resolved path.
// ---------------------------------------------------------------------------

// Symlink creation requires admin on Windows; skip the symlink test there
// to avoid environment-specific failures. The grep test above covers the
// most important hygiene rule (CLAUDE.md/AGENTS.md) cross-platform.
const canCreateSymlink = platform() !== "win32";

describe.skipIf(!canCreateSymlink)(
  "install hygiene — settings.json symlink-awareness",
  () => {
    it("when settings.json is a symlink, install writes through to the real file", async () => {
      const dir = freshTempDir();
      try {
        // The "real" file lives in a sibling directory.
        const realDir = join(dir, "real-config");
        mkdirSync(realDir, { recursive: true });
        const realSettings = join(realDir, "settings.json");
        writeFileSync(realSettings, JSON.stringify({ existing: true }), "utf-8");

        // The path install touches is a symlink into realDir.
        const symlinkedSettings = join(dir, "settings.json");
        symlinkSync(realSettings, symlinkedSettings);

        await install({
          mcpConfigPath: join(dir, "mcp_servers.json"),
          settingsPath: symlinkedSettings,
          skillsSourceDir: join(dir, "src-skills"),
          skillsTargetDir: join(dir, "dst-skills"),
          commandsDir: join(dir, "commands"),
          statePath: join(dir, "state.json"),
          review: ALWAYS_APPLY,
        });
        // The write reached the REAL file (Node's writeFileSync follows
        // symlinks). Group F adds an optional `notify` callback that
        // surfaces the resolved path to the user — for Group A we just
        // pin the write-through behavior.
        const realContent = JSON.parse(readFileSync(realSettings, "utf-8"));
        expect(realContent.hooks).toBeDefined();
        // Sanity: the resolved real path is the realSettings path.
        const resolved = realpathSync(symlinkedSettings);
        expect(resolved).toBe(realpathSync(realSettings));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
