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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NPM_FINAL_STEP,
  renderUninstallOutcome,
  runUninstall,
  uninstallExitCode,
  type UninstallOptions,
  type UninstallResult,
} from "../src/commands/uninstall.js";
import { buildHookEntries } from "../src/commands/hook_templates.js";
import { deregisterHooks } from "../src/commands/hook_registry.js";
import { runHook } from "../src/commands/hook.js";
import { listEnabledSessions } from "../src/state.js";

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

  // ~/.eleanor4devs — v2 state with one ENABLED + one DISABLED session (the
  // backend step must only report the enabled one), credential, audit log.
  writeFileSync(
    join(home, ".eleanor4devs", "state.json"),
    JSON.stringify(
      {
        version: 2,
        sessions: {
          "sess-1": { enabled: true, toggled_at: "2026-06-10T00:00:00.000Z" },
          "sess-2": { enabled: false, toggled_at: "2026-06-09T00:00:00.000Z" },
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

describe("uninstall — hook-safe ordering (AC-148)", () => {
  it("de-registers hooks before any artifact removal and deletes the state dir last", async () => {
    const h = harnessFor(fullFootprintHome());
    const steps: string[] = [];
    // Filesystem snapshot taken as each step STARTS — the ordering evidence
    // is what's on disk, not just the step-name sequence.
    const snapshots: Record<
      string,
      { e4dHooksPresent: boolean; stateFilePresent: boolean }
    > = {};
    const result = await runUninstall({
      ...h.opts,
      onStep: (s) => {
        steps.push(s);
        snapshots[s] = {
          e4dHooksPresent: readFileSync(h.opts.settingsPath, "utf-8").includes(
            "eleanor4devs hook ",
          ),
          stateFilePresent: existsSync(h.opts.statePath),
        };
      },
    });
    expect(result.outcome).toBe("completed");

    // The backend step runs FIRST — it needs state.json + auth.json intact.
    expect(steps[0]).toBe("backend-disable-revoke");

    const dereg = steps.indexOf("deregister-hooks");
    expect(dereg).toBeGreaterThanOrEqual(0);
    for (const s of [
      "remove-mcp-entry",
      "remove-commands",
      "remove-skills",
      "remove-state-dir",
    ]) {
      expect(dereg, `deregister-hooks must precede ${s}`).toBeLessThan(
        steps.indexOf(s),
      );
    }
    expect(steps[steps.length - 1]).toBe("remove-state-dir");

    // At the first removal step the e4d hooks are ALREADY gone…
    expect(snapshots["remove-mcp-entry"]?.e4dHooksPresent).toBe(false);
    // …and at the final step (pre-deletion) the state file is STILL present:
    // a concurrent session's hook in this window fail-closes against an
    // intact state file (AC-118), and no hook entry exists to spawn anything.
    expect(snapshots["remove-state-dir"]?.e4dHooksPresent).toBe(false);
    expect(snapshots["remove-state-dir"]?.stateFilePresent).toBe(true);
  });

  it("a lifecycle hook for a non-opted-in session during the sweep window no-ops cleanly (AC-118 holds)", async () => {
    const h = harnessFor(fullFootprintHome());
    // Construct the exact mid-sweep state: hooks just de-registered (step 2
    // done), state dir not yet deleted (step 6 pending).
    deregisterHooks(h.opts.settingsPath);
    const auditPath = join(h.opts.stateDir, "audit.log");
    const stateBefore = readFileSync(h.opts.statePath, "utf-8");
    const auditBefore = readFileSync(auditPath, "utf-8");

    const result = await runHook({
      hookName: "before_run",
      backendUrl: h.opts.backendUrl,
      stdinJson: JSON.stringify({ session_id: "never-opted-in" }),
      statePath: h.opts.statePath,
      settingsPath: h.opts.settingsPath,
      credentialsPath: h.opts.credentialsPath,
      auditLogPath: auditPath,
      now: () => new Date("2026-06-11T00:00:00.000Z"),
      fetch: (async () => {
        throw new Error("network must not be touched for a gated session");
      }) as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(true);
    // The gate mutated nothing: state byte-identical, no audit entry.
    expect(readFileSync(h.opts.statePath, "utf-8")).toBe(stateBefore);
    expect(readFileSync(auditPath, "utf-8")).toBe(auditBefore);
  });
});

describe("uninstall — backend best-effort (AC-149)", () => {
  interface RecordedCall {
    url: string;
    body: unknown;
    auth: string | undefined;
  }

  function recordingFetch(calls: RecordedCall[]): typeof globalThis.fetch {
    return (async (
      url: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        body:
          init?.body !== undefined && init?.body !== null
            ? (JSON.parse(String(init.body)) as unknown)
            : null,
        auth: headers["authorization"],
      });
      return new Response(JSON.stringify({ ok: true, access_token: "at-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  }

  it("linked machine: reports each ENABLED session disabled and revokes the credential", async () => {
    const calls: RecordedCall[] = [];
    const h = harnessFor(fullFootprintHome(), { fetch: recordingFetch(calls) });
    const result = await runUninstall(h.opts);

    expect(result.outcome).toBe("completed");

    // Exactly ONE disable — sess-1 (enabled). sess-2 (disabled) is not posted.
    const disables = calls.filter((c) => c.url.endsWith("/hooks/disable"));
    expect(disables).toHaveLength(1);
    expect(disables[0]?.body).toEqual({ session_id: "sess-1" });
    expect(disables[0]?.auth).toBe("Bearer at-1");

    // The credential is revoked server-side, then the sweep proceeds.
    const revokes = calls.filter((c) => c.url.endsWith("/auth/revoke"));
    expect(revokes).toHaveLength(1);
    expect(revokes[0]?.body).toEqual({ refresh_token: "rt-fixture" });

    expect(result.sessionsDisabled).toBe(1);
    expect(result.credentialRevoked).toBe(true);
    expect(result.stateRemoved).toBe(true);
  });

  it("unreachable backend: the local sweep still completes and the user is told the server-side part did not land", async () => {
    const h = harnessFor(fullFootprintHome(), {
      fetch: (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9");
      }) as typeof globalThis.fetch,
    });
    const result = await runUninstall(h.opts);

    expect(result.outcome).toBe("completed");
    expect(result.stateRemoved).toBe(true);
    expect(existsSync(h.opts.stateDir)).toBe(false);
    expect(result.sessionsDisabled).toBe(0);
    // Server-side revoke did NOT land — the field is honest about it…
    expect(result.credentialRevoked).toBe(false);
    // …and the user is told on stderr.
    expect(h.errs.join("\n")).toMatch(/could not reach|network|did not land/i);
  });

  it("unlinked machine (no auth.json): zero network calls, sweep completes", async () => {
    const home = fullFootprintHome();
    rmSync(join(home, ".eleanor4devs", "auth.json"), { force: true });
    let fetchCalls = 0;
    const h = harnessFor(home, {
      fetch: (async () => {
        fetchCalls += 1;
        throw new Error("must not be called");
      }) as typeof globalThis.fetch,
    });
    const result = await runUninstall(h.opts);

    expect(fetchCalls).toBe(0);
    expect(result.outcome).toBe("completed");
    expect(result.sessionsDisabled).toBe(0);
    expect(result.credentialRevoked).toBe(false);
    expect(result.stateRemoved).toBe(true);
  });
});

describe("uninstall — MCP-entry removal discipline (AC-147)", () => {
  it("foreign-only mcp_servers.json is NOT rewritten (byte-identical, no-op)", async () => {
    const home = fullFootprintHome();
    const mcpPath = join(home, ".claude", "mcp_servers.json");
    // Replace the fixture's mcp file with a foreign-only one.
    const foreignOnly =
      JSON.stringify({ mcpServers: { "other-mcp": FOREIGN_MCP_ENTRY } }, null, 2) +
      "\n";
    writeFileSync(mcpPath, foreignOnly, "utf-8");

    const h = harnessFor(home);
    const result = await runUninstall(h.opts);

    expect(result.mcpEntryRemoved).toBe(false);
    expect(readFileSync(mcpPath, "utf-8")).toBe(foreignOnly);
  });

  it("unrelated top-level keys in mcp_servers.json survive the entry removal", async () => {
    const home = fullFootprintHome();
    const mcpPath = join(home, ".claude", "mcp_servers.json");
    writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          $schema: "https://example.test/mcp.schema.json",
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

    const h = harnessFor(home);
    const result = await runUninstall(h.opts);

    expect(result.mcpEntryRemoved).toBe(true);
    const after = readJson(mcpPath) as Record<string, unknown>;
    expect(after["$schema"]).toBe("https://example.test/mcp.schema.json");
    expect((after["mcpServers"] as Record<string, unknown>)["other-mcp"]).toEqual(
      FOREIGN_MCP_ENTRY,
    );
  });

  it("writes THROUGH a symlinked mcp_servers.json instead of clobbering the link (DD-64)", async () => {
    const home = fullFootprintHome();
    const claude = join(home, ".claude");
    const mcpPath = join(claude, "mcp_servers.json");
    // Move the real file elsewhere and symlink it back (the dotfile-repo shape).
    const realPath = join(home, "dotfiles-mcp_servers.json");
    writeFileSync(realPath, readFileSync(mcpPath, "utf-8"), "utf-8");
    rmSync(mcpPath, { force: true });
    try {
      symlinkSync(realPath, mcpPath, "file");
    } catch {
      // File symlinks need privileges on some Windows setups — skip silently
      // (the junction-based settings.json variant is covered by hook_registry
      // tests; this pin runs wherever symlinks are permitted).
      return;
    }

    const h = harnessFor(home);
    const result = await runUninstall(h.opts);

    expect(result.mcpEntryRemoved).toBe(true);
    // The link is still a link, and the REAL file behind it was rewritten.
    expect(lstatSync(mcpPath).isSymbolicLink()).toBe(true);
    const real = readJson(realPath) as { mcpServers: Record<string, unknown> };
    expect(real.mcpServers["eleanor4devs"]).toBeUndefined();
    expect(real.mcpServers["other-mcp"]).toEqual(FOREIGN_MCP_ENTRY);
  });
});

describe("uninstall — skill-pack twin + junction tolerance (AC-147, AC-150)", () => {
  it("removes the legacy ~/.agent twin when present and lists both removals", async () => {
    const home = fullFootprintHome();
    const twin = join(home, ".agent", "skills", "eleanor4devs");
    mkdirSync(twin, { recursive: true });
    writeFileSync(join(twin, "eleanor4devs-adopt-session.md"), "# legacy\n", "utf-8");

    const h = harnessFor(home);
    const result = await runUninstall(h.opts);

    expect(existsSync(h.opts.skillsTargetDir)).toBe(false);
    expect(existsSync(twin)).toBe(false);
    expect(result.skillsRemoved).toEqual(
      expect.arrayContaining([h.opts.skillsTargetDir, twin]),
    );
  });

  it("tolerates the twin being a junction onto the same real dir (second removal no-ops)", async () => {
    const home = fullFootprintHome();
    const twinParent = join(home, ".agent", "skills");
    mkdirSync(twinParent, { recursive: true });
    const twin = join(twinParent, "eleanor4devs");
    // Junction: the twin IS the core-pack dir.
    symlinkSync(join(home, ".claude", "skills", "eleanor4devs"), twin, "junction");

    const h = harnessFor(home);
    const result = await runUninstall(h.opts);

    expect(result.outcome).toBe("completed");
    expect(existsSync(h.opts.skillsTargetDir)).toBe(false);
    expect(existsSync(twin)).toBe(false);
    // The foreign skill next to the core pack is untouched either way.
    expect(
      readFileSync(
        join(home, ".claude", "skills", "foreign-skill", "SKILL.md"),
        "utf-8",
      ),
    ).toBe(FOREIGN_SKILL_BODY);
  });
});

describe("uninstall — confirmation gate (AC-151)", () => {
  it("interactive decline: zero mutations (no network either), 'aborted', outcome declined", async () => {
    const home = fullFootprintHome();
    const settingsBefore = readFileSync(
      join(home, ".claude", "settings.json"),
      "utf-8",
    );
    let fetchCalls = 0;
    let summarySeen = "";
    const h = harnessFor(home, {
      yes: false,
      isTTY: true,
      confirm: async (summary) => {
        summarySeen = summary;
        return false;
      },
      fetch: (async () => {
        fetchCalls += 1;
        throw new Error("network must not be touched on decline");
      }) as typeof globalThis.fetch,
    });
    const result = await runUninstall(h.opts);

    expect(result.outcome).toBe("declined");
    // The gate precedes the backend step — declining costs zero mutations
    // AND zero network.
    expect(fetchCalls).toBe(0);
    expect(readFileSync(h.opts.settingsPath, "utf-8")).toBe(settingsBefore);
    expect(existsSync(join(h.opts.commandsDir, "e4d.md"))).toBe(true);
    expect(existsSync(h.opts.skillsTargetDir)).toBe(true);
    expect(existsSync(h.opts.stateDir)).toBe(true);
    expect(h.logs.join("\n")).toMatch(/aborted — nothing removed/i);
    // The summary lists what WOULD be removed.
    expect(summarySeen).toMatch(/e4d\.md/);
    expect(summarySeen).toMatch(/lifecycle hook/i);
    expect(summarySeen).toContain(h.opts.stateDir);
  });

  it("interactive accept: the sweep proceeds", async () => {
    const h = harnessFor(fullFootprintHome(), {
      yes: false,
      isTTY: true,
      confirm: async () => true,
    });
    const result = await runUninstall(h.opts);
    expect(result.outcome).toBe("completed");
    expect(result.stateRemoved).toBe(true);
    expect(existsSync(h.opts.stateDir)).toBe(false);
  });

  it("non-TTY without --yes: refuses with guidance, zero mutations, outcome refused", async () => {
    const home = fullFootprintHome();
    const settingsBefore = readFileSync(
      join(home, ".claude", "settings.json"),
      "utf-8",
    );
    const h = harnessFor(home, { yes: false, isTTY: false });
    const result = await runUninstall(h.opts);

    expect(result.outcome).toBe("refused");
    expect(readFileSync(h.opts.settingsPath, "utf-8")).toBe(settingsBefore);
    expect(existsSync(h.opts.stateDir)).toBe(true);
    expect([...h.logs, ...h.errs].join("\n")).toMatch(/--yes/);
  });

  it("--yes never consults the confirm hook", async () => {
    let confirmCalls = 0;
    const h = harnessFor(fullFootprintHome(), {
      yes: true,
      isTTY: true,
      confirm: async () => {
        confirmCalls += 1;
        return false;
      },
    });
    const result = await runUninstall(h.opts);
    expect(confirmCalls).toBe(0);
    expect(result.outcome).toBe("completed");
  });
});

describe("uninstall — outcome rendering + exit codes (AC-152)", () => {
  function completedResult(): UninstallResult {
    return {
      outcome: "completed",
      sessionsDisabled: 1,
      credentialRevoked: true,
      hooksDeregistered: true,
      mcpEntryRemoved: true,
      commandsRemoved: ["e4d.md", "e4d-status.md"],
      skillsRemoved: ["C:/fake/skills/eleanor4devs"],
      stateRemoved: true,
    };
  }

  it("a completed sweep renders per-artifact lines and ENDS with the npm final step", () => {
    const lines: string[] = [];
    renderUninstallOutcome(completedResult(), (t) => lines.push(t));
    const text = lines.join("\n");
    expect(text).toMatch(/lifecycle hook/i);
    expect(text).toMatch(/MCP entry/);
    expect(text).toMatch(/e4d\.md, e4d-status\.md/);
    expect(text).toMatch(/skill pack/i);
    expect(text).toMatch(/1 session\(s\) reported disabled/);
    expect(text).toMatch(/credential revoked/i);
    expect(lines[lines.length - 1]).toContain(NPM_FINAL_STEP);
  });

  it("a nothing-to-remove run still names the npm final step", () => {
    const lines: string[] = [];
    renderUninstallOutcome(
      { ...completedResult(), outcome: "nothing-to-remove", sessionsDisabled: 0, credentialRevoked: false, hooksDeregistered: false, mcpEntryRemoved: false, commandsRemoved: [], skillsRemoved: [], stateRemoved: false },
      (t) => lines.push(t),
    );
    expect(lines.join("\n")).toContain(NPM_FINAL_STEP);
  });

  it("declined and refused runs render NO npm line (artifacts remain — removing the package would orphan the hooks)", () => {
    for (const outcome of ["declined", "refused"] as const) {
      const lines: string[] = [];
      renderUninstallOutcome(
        { ...completedResult(), outcome, sessionsDisabled: 0, credentialRevoked: false, hooksDeregistered: false, mcpEntryRemoved: false, commandsRemoved: [], skillsRemoved: [], stateRemoved: false },
        (t) => lines.push(t),
      );
      expect(lines.join("\n")).not.toContain(NPM_FINAL_STEP);
    }
  });

  it("exit codes: completed / nothing-to-remove / declined → 0, refused → 1", () => {
    expect(uninstallExitCode("completed")).toBe(0);
    expect(uninstallExitCode("nothing-to-remove")).toBe(0);
    expect(uninstallExitCode("declined")).toBe(0);
    expect(uninstallExitCode("refused")).toBe(1);
  });
});

describe("listEnabledSessions — the backend step's session source", () => {
  it("returns only enabled session ids, sorted", () => {
    const home = emptyHome();
    const statePath = join(home, ".eleanor4devs", "state.json");
    mkdirSync(join(home, ".eleanor4devs"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        sessions: {
          c: { enabled: true, toggled_at: null },
          a: { enabled: true, toggled_at: null },
          b: { enabled: false, toggled_at: null },
        },
      }) + "\n",
      "utf-8",
    );
    expect(listEnabledSessions({ statePath })).toEqual(["a", "c"]);
  });

  it("fail-closed: absent or corrupt file yields []", () => {
    const home = emptyHome();
    const statePath = join(home, ".eleanor4devs", "state.json");
    expect(listEnabledSessions({ statePath })).toEqual([]);
    mkdirSync(join(home, ".eleanor4devs"), { recursive: true });
    writeFileSync(statePath, "{not json", "utf-8");
    expect(listEnabledSessions({ statePath })).toEqual([]);
  });
});
