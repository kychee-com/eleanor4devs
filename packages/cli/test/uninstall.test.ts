/**
 * `eleanor4devs uninstall` — sweep-core tests (Phase 29, [[DD-74]]).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI —
 *   AC-147 (full artifact sweep, foreign artifacts preserved) and
 *   AC-150 (idempotent; absent artifacts never error).
 *
 * Fixture = the full footprint `install` + the first `/e4d` opt-in leave
 * behind, PLUS one foreign artifact of every kind so preservation is
 * asserted, not assumed.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runUninstall,
  type UninstallOptions,
  type UninstallResult,
} from "../src/commands/uninstall.js";
import { buildHookEntries } from "../src/commands/hook_templates.js";

const FOREIGN_HOOK_ENTRY = {
  matcher: "",
  hooks: [{ type: "command" as const, command: "other-agent hook ping" }],
};

const FOREIGN_MCP_ENTRY = {
  command: "other-mcp-server",
  args: ["--serve"],
};

const FOREIGN_COMMAND_BODY = "---\ndescription: a foreign slash command\n---\nDo the foreign thing.\n";
const FOREIGN_SKILL_BODY = "# Foreign skill\n";

interface Harness {
  home: string;
  opts: UninstallOptions;
  logs: string[];
  errs: string[];
}

function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), "e4d-uninstall-"));
}

/** Build the canonical full footprint + one foreign artifact of each kind. */
function fullFootprintHome(): string {
  const home = emptyHome();
  const claude = join(home, ".claude");
  mkdirSync(join(claude, "commands"), { recursive: true });
  mkdirSync(join(claude, "skills", "eleanor4devs"), { recursive: true });
  mkdirSync(join(claude, "skills", "foreign-skill"), { recursive: true });
  mkdirSync(join(home, ".eleanor4devs"), { recursive: true });

  // settings.json — the four canonical e4d hooks + one foreign hook + a
  // foreign top-level key.
  const hooks = buildHookEntries();
  hooks["SessionStart"] = [...(hooks["SessionStart"] ?? []), FOREIGN_HOOK_ENTRY];
  writeFileSync(
    join(claude, "settings.json"),
    JSON.stringify({ theme: "dark", hooks }, null, 2) + "\n",
    "utf-8",
  );

  // mcp_servers.json — e4d entry + foreign entry.
  writeFileSync(
    join(claude, "mcp_servers.json"),
    JSON.stringify(
      {
        mcpServers: {
          eleanor4devs: { command: "npx", args: ["-y", "@eleanor4devs/mcp"] },
          "other-mcp": FOREIGN_MCP_ENTRY,
        },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );

  // Slash commands — both e4d files + a foreign one.
  writeFileSync(join(claude, "commands", "e4d.md"), "e4d body\n", "utf-8");
  writeFileSync(join(claude, "commands", "e4d-status.md"), "e4d-status body\n", "utf-8");
  writeFileSync(join(claude, "commands", "foreign.md"), FOREIGN_COMMAND_BODY, "utf-8");

  // Skills — one core-pack file + a foreign skill dir.
  writeFileSync(
    join(claude, "skills", "eleanor4devs", "eleanor4devs-adopt-session.md"),
    "# adopt session\n",
    "utf-8",
  );
  writeFileSync(join(claude, "skills", "foreign-skill", "SKILL.md"), FOREIGN_SKILL_BODY, "utf-8");

  // ~/.eleanor4devs — v2 state with one enabled session, credential, audit log.
  writeFileSync(
    join(home, ".eleanor4devs", "state.json"),
    JSON.stringify(
      {
        version: 2,
        sessions: {
          "sess-1": { enabled: true, toggled_at: "2026-06-10T00:00:00.000Z" },
        },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  writeFileSync(
    join(home, ".eleanor4devs", "auth.json"),
    JSON.stringify({ refresh_token: "rt-fixture" }) + "\n",
    "utf-8",
  );
  writeFileSync(join(home, ".eleanor4devs", "audit.log"), "{}\n", "utf-8");
  return home;
}

function okFetch(): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ ok: true, access_token: "at" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

function harnessFor(home: string, over: Partial<UninstallOptions> = {}): Harness {
  const logs: string[] = [];
  const errs: string[] = [];
  const opts: UninstallOptions = {
    mcpConfigPath: join(home, ".claude", "mcp_servers.json"),
    settingsPath: join(home, ".claude", "settings.json"),
    skillsTargetDir: join(home, ".claude", "skills", "eleanor4devs"),
    agentSkillsTwinDir: join(home, ".agent", "skills", "eleanor4devs"),
    commandsDir: join(home, ".claude", "commands"),
    stateDir: join(home, ".eleanor4devs"),
    statePath: join(home, ".eleanor4devs", "state.json"),
    credentialsPath: join(home, ".eleanor4devs", "auth.json"),
    backendUrl: "https://api.example.test",
    yes: true,
    log: (t) => logs.push(t),
    errorLog: (t) => errs.push(t),
    fetch: okFetch(),
    ...over,
  };
  return { home, opts, logs, errs };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("uninstall — full-footprint sweep (AC-147)", () => {
  it("removes every eleanor4devs artifact and preserves every foreign one", async () => {
    const h = harnessFor(fullFootprintHome());
    const result: UninstallResult = await runUninstall(h.opts);

    expect(result.outcome).toBe("completed");

    // Hooks: the four e4d entries are gone; the foreign SessionStart entry
    // and the foreign top-level key survive; emptied event keys are deleted.
    const settings = readJson(h.opts.settingsPath) as {
      theme?: string;
      hooks?: Record<string, unknown[]>;
    };
    expect(settings.theme).toBe("dark");
    expect(settings.hooks).toBeDefined();
    expect(Object.keys(settings.hooks ?? {})).toEqual(["SessionStart"]);
    expect(settings.hooks?.["SessionStart"]).toEqual([FOREIGN_HOOK_ENTRY]);
    expect(result.hooksDeregistered).toBe(true);

    // MCP: e4d entry gone, foreign entry value-identical.
    const mcp = readJson(h.opts.mcpConfigPath) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers["eleanor4devs"]).toBeUndefined();
    expect(mcp.mcpServers["other-mcp"]).toEqual(FOREIGN_MCP_ENTRY);
    expect(result.mcpEntryRemoved).toBe(true);

    // Slash commands: e4d files gone, foreign file byte-identical.
    expect(existsSync(join(h.opts.commandsDir, "e4d.md"))).toBe(false);
    expect(existsSync(join(h.opts.commandsDir, "e4d-status.md"))).toBe(false);
    expect(readFileSync(join(h.opts.commandsDir, "foreign.md"), "utf-8")).toBe(
      FOREIGN_COMMAND_BODY,
    );
    expect([...result.commandsRemoved].sort()).toEqual(["e4d-status.md", "e4d.md"]);

    // Skills: core pack dir gone, foreign skill intact.
    expect(existsSync(h.opts.skillsTargetDir)).toBe(false);
    expect(
      readFileSync(
        join(h.home, ".claude", "skills", "foreign-skill", "SKILL.md"),
        "utf-8",
      ),
    ).toBe(FOREIGN_SKILL_BODY);
    expect(result.skillsRemoved).toContain(h.opts.skillsTargetDir);

    // State dir: gone entirely (state.json, auth.json, audit.log).
    expect(existsSync(h.opts.stateDir)).toBe(false);
    expect(result.stateRemoved).toBe(true);
  });
});

describe("uninstall — idempotency (AC-150)", () => {
  it("an immediate second run reports nothing to remove and never errors", async () => {
    const home = fullFootprintHome();
    await runUninstall(harnessFor(home).opts);

    const h2 = harnessFor(home);
    const second = await runUninstall(h2.opts);

    expect(second.outcome).toBe("nothing-to-remove");
    expect(second.hooksDeregistered).toBe(false);
    expect(second.mcpEntryRemoved).toBe(false);
    expect(second.commandsRemoved).toEqual([]);
    expect(second.skillsRemoved).toEqual([]);
    expect(second.stateRemoved).toBe(false);
    expect(h2.logs.join("\n")).toMatch(/nothing to remove/i);
  });

  it("a machine where eleanor4devs was never installed reports nothing to remove", async () => {
    const h = harnessFor(emptyHome());
    const result = await runUninstall(h.opts);

    expect(result.outcome).toBe("nothing-to-remove");
    expect(h.logs.join("\n")).toMatch(/nothing to remove/i);
    expect(h.errs).toEqual([]);
  });
});
