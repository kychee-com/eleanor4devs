/**
 * Tests for `eleanor4devs install` Phase 19 side effects:
 *   - Writes `~/.claude/commands/e4d.md` (the slash-command file).
 *   - Initializes `~/.eleanor4devs/state.json` to OFF on first install.
 *   - Does NOT overwrite an existing state.json on re-install (preserves
 *     a toggled-ON state across re-runs).
 *   - InstallResult exposes `slashCommandWritten` and `stateInitialized`.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 19, Group C.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { install } from "../src/commands/install.js";
import { ALWAYS_APPLY } from "../src/commands/install_skills.js";
import { E4D_SLASH_COMMAND_BODY } from "../src/commands/install.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGED_SKILLS = join(HERE, "..", "skills", "eleanor4devs");

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "e4d-install19-"));
}

interface PathSet {
  mcpConfigPath: string;
  settingsPath: string;
  skillsTargetDir: string;
  commandsDir: string;
  statePath: string;
}

function paths(home: string): PathSet {
  return {
    mcpConfigPath: join(home, ".claude", "mcp_servers.json"),
    settingsPath: join(home, ".claude", "settings.json"),
    skillsTargetDir: join(home, ".claude", "skills", "eleanor4devs"),
    commandsDir: join(home, ".claude", "commands"),
    statePath: join(home, ".eleanor4devs", "state.json"),
  };
}

describe("install — slash-command file (Phase 19 Group C)", () => {
  it("writes ~/.claude/commands/e4d.md with the canonical body", async () => {
    const home = freshHome();
    try {
      const p = paths(home);
      await install({
        ...p,
        skillsSourceDir: PACKAGED_SKILLS,
        review: ALWAYS_APPLY,
      });
      const cmdPath = join(p.commandsDir, "e4d.md");
      expect(existsSync(cmdPath)).toBe(true);
      const body = readFileSync(cmdPath, "utf-8");
      expect(body).toBe(E4D_SLASH_COMMAND_BODY);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("overwrites a tampered e4d.md back to the canonical body", async () => {
    const home = freshHome();
    try {
      const p = paths(home);
      mkdirSync(p.commandsDir, { recursive: true });
      writeFileSync(join(p.commandsDir, "e4d.md"), "TAMPERED CONTENT", "utf-8");
      await install({
        ...p,
        skillsSourceDir: PACKAGED_SKILLS,
        review: ALWAYS_APPLY,
      });
      const body = readFileSync(join(p.commandsDir, "e4d.md"), "utf-8");
      expect(body).toBe(E4D_SLASH_COMMAND_BODY);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("auto-creates the commands dir if it doesn't exist", async () => {
    const home = freshHome();
    try {
      const p = paths(home);
      expect(existsSync(p.commandsDir)).toBe(false);
      await install({
        ...p,
        skillsSourceDir: PACKAGED_SKILLS,
        review: ALWAYS_APPLY,
      });
      expect(existsSync(p.commandsDir)).toBe(true);
      expect(existsSync(join(p.commandsDir, "e4d.md"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("install — state.json initialization (Phase 19 Group C)", () => {
  it("initializes state.json to {enabled: false, toggled_at: null} on a fresh install", async () => {
    const home = freshHome();
    try {
      const p = paths(home);
      await install({
        ...p,
        skillsSourceDir: PACKAGED_SKILLS,
        review: ALWAYS_APPLY,
      });
      expect(existsSync(p.statePath)).toBe(true);
      const parsed = JSON.parse(readFileSync(p.statePath, "utf-8"));
      expect(parsed).toEqual({ enabled: false, toggled_at: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves a pre-existing toggled-ON state.json on re-install (no overwrite)", async () => {
    const home = freshHome();
    try {
      const p = paths(home);
      mkdirSync(dirname(p.statePath), { recursive: true });
      const original = JSON.stringify(
        { enabled: true, toggled_at: "2026-05-28T15:42:00.000Z" },
        null,
        2,
      );
      writeFileSync(p.statePath, original, "utf-8");
      await install({
        ...p,
        skillsSourceDir: PACKAGED_SKILLS,
        review: ALWAYS_APPLY,
      });
      const after = readFileSync(p.statePath, "utf-8");
      expect(after).toBe(original);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves a corrupt state.json untouched (no silent reset)", async () => {
    const home = freshHome();
    try {
      const p = paths(home);
      mkdirSync(dirname(p.statePath), { recursive: true });
      writeFileSync(p.statePath, "not json at all", "utf-8");
      await install({
        ...p,
        skillsSourceDir: PACKAGED_SKILLS,
        review: ALWAYS_APPLY,
      });
      const after = readFileSync(p.statePath, "utf-8");
      expect(after).toBe("not json at all");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("install — InstallResult flags (Phase 19 Group C)", () => {
  it("returns slashCommandWritten: true on every install run", async () => {
    const home = freshHome();
    try {
      const p = paths(home);
      const r1 = await install({
        ...p,
        skillsSourceDir: PACKAGED_SKILLS,
        review: ALWAYS_APPLY,
      });
      expect(r1.slashCommandWritten).toBe(true);

      const r2 = await install({
        ...p,
        skillsSourceDir: PACKAGED_SKILLS,
        review: ALWAYS_APPLY,
      });
      expect(r2.slashCommandWritten).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns stateInitialized: true on fresh install, false on re-install", async () => {
    const home = freshHome();
    try {
      const p = paths(home);
      const r1 = await install({
        ...p,
        skillsSourceDir: PACKAGED_SKILLS,
        review: ALWAYS_APPLY,
      });
      expect(r1.stateInitialized).toBe(true);

      const r2 = await install({
        ...p,
        skillsSourceDir: PACKAGED_SKILLS,
        review: ALWAYS_APPLY,
      });
      expect(r2.stateInitialized).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
