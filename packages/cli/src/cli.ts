#!/usr/bin/env node
/**
 * `eleanor4devs` CLI binary.
 *
 * Minimal argv dispatcher — no commander/yargs dep. Commands:
 *   eleanor4devs --version
 *   eleanor4devs install                          (Task 8)
 *   eleanor4devs install-skills [--core|--how-to]
 *   eleanor4devs skills list
 *   eleanor4devs auth                             (Task 9)
 *   eleanor4devs toggle --session <id>            (Phase 23 — per-session)
 *   eleanor4devs status                           (Phase 19/21)
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

import { CLI_VERSION } from "./index.js";
import { install } from "./commands/install.js";
import {
  installSkills,
  ALWAYS_APPLY,
} from "./commands/install_skills.js";
import { listSkills } from "./commands/skills_list.js";
import { authFlow, parseAuthArgs, TestModeNotEnabledError } from "./commands/auth.js";
import { runLogout } from "./commands/logout.js";
import { parseHookArgs, readStdin, runHook } from "./commands/hook.js";
import { runToggle } from "./commands/toggle.js";
import { runStatus } from "./commands/status.js";
import { DEFAULT_AUDIT_LOG_PATH } from "./audit.js";
import { maybePrintMigrationWarning } from "./migration_warning.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// In dev tsc emits to dist/, so the bundled skills live one level up.
const PACKAGED_SKILLS = join(HERE, "..", "skills", "eleanor4devs");
const SKILLS_TARGET_DIR = join(
  homedir(),
  ".claude",
  "skills",
  "eleanor4devs",
);
const MCP_CONFIG_PATH = join(homedir(), ".claude", "mcp_servers.json");
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const COMMANDS_DIR = join(homedir(), ".claude", "commands");
const CREDENTIALS_PATH = join(homedir(), ".eleanor4devs", "auth.json");
/**
 * Reporting-state file path (Phase 19, [[DD-40]]). Same default as
 * `DEFAULT_STATE_PATH` in `src/state.ts`; kept here next to
 * CREDENTIALS_PATH so every CLI command resolves the same paths.
 */
export const STATE_PATH = join(homedir(), ".eleanor4devs", "state.json");
const DEFAULT_API_BASE = "https://api.eleanor4devs.com";

export async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  switch (first) {
    case undefined:
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "--version":
    case "-v":
      // eslint-disable-next-line no-console
      console.log(CLI_VERSION);
      return 0;
    case "install": {
      const result = await install({
        mcpConfigPath: MCP_CONFIG_PATH,
        settingsPath: SETTINGS_PATH,
        skillsSourceDir: PACKAGED_SKILLS,
        skillsTargetDir: SKILLS_TARGET_DIR,
        commandsDir: COMMANDS_DIR,
        statePath: STATE_PATH,
        review: ALWAYS_APPLY,
      });
      // eslint-disable-next-line no-console
      console.log(
        `installed: ${result.skillsInstalled.length} skill(s); mcp entry written; hook entries written; /e4d slash command ${result.slashCommandWritten ? "written" : "skipped"}; reporting state ${result.stateInitialized ? "initialized to OFF" : "preserved"}.`,
      );
      return 0;
    }
    case "hook": {
      let parsed;
      try {
        parsed = parseHookArgs(rest);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
      const stdinJson = await readStdin();
      const backendUrl =
        parsed.backendUrl ??
        process.env.ELEANOR4DEVS_API_BASE ??
        DEFAULT_API_BASE;
      const result = await runHook({
        hookName: parsed.hookName,
        backendUrl,
        stdinJson,
        statePath: STATE_PATH,
        credentialsPath: CREDENTIALS_PATH,
        auditLogPath: DEFAULT_AUDIT_LOG_PATH,
      });
      // DD-48: surface the visible line on SessionStart (whose stdout the
      // user sees in-session) — "✓ registered" / "⚠ not registered" / the
      // not-linked guidance. Goes to stdout, not stderr.
      if (result.userMessage) {
        // eslint-disable-next-line no-console
        console.log(result.userMessage);
      }
      // DD-44: local reporting hooks are best-effort — NEVER fail the
      // user's Claude Code session. Always exit 0. Failures are surfaced
      // via userMessage (SessionStart) + the local audit log.
      return 0;
    }
    case "install-skills": {
      if (rest.includes("--how-to")) {
        // The how-to pack is a documentation pointer, NOT a duplicate
        // copy of the global workflow skills. Print the pointer file
        // verbatim so the user sees the contents without needing a
        // separate `cat`.
        const howtoPath = join(HERE, "..", "skills", "how-to", "eleanor4devs-howto.md");
        try {
          const { readFileSync } = await import("node:fs");
          // eslint-disable-next-line no-console
          console.log(readFileSync(howtoPath, "utf-8"));
        } catch {
          // eslint-disable-next-line no-console
          console.log(
            "The how-to pack is a documentation pointer (not installed as files). See docs/products/eleanor4devs/eleanor4devs-spec.md § How-To Skills Pack.",
          );
        }
        return 0;
      }
      const result = await installSkills({
        sourceDir: PACKAGED_SKILLS,
        targetDir: SKILLS_TARGET_DIR,
        review: ALWAYS_APPLY,
      });
      // eslint-disable-next-line no-console
      console.log(`installed: ${result.installed.length} skill(s).`);
      return 0;
    }
    case "toggle": {
      // v0.14.0+: `toggle` requires `--session <id>` — there is no
      // machine-wide reporting state anymore. The `/e4d` slash command
      // body invokes us as `toggle --session ${CLAUDE_SESSION_ID}`.
      // (The pre-v0.14.0 `on`/`off`/global-toggle verbs are removed.)
      // Surface the first-run UX warning if the user is migrating from
      // a pre-v0.14.0 (v1) state file.
      maybePrintMigrationWarning({ statePath: STATE_PATH });
      const sessionIdx = rest.indexOf("--session");
      if (sessionIdx === -1 || rest[sessionIdx + 1] === undefined) {
        // eslint-disable-next-line no-console
        console.error(
          "eleanor4devs toggle: --session <id> is required. " +
            "Invoke via the `/e4d` slash command — never type this directly.",
        );
        return 1;
      }
      const sessionId = rest[sessionIdx + 1] as string;
      return runToggle({
        sessionId,
        statePath: STATE_PATH,
        auditLogPath: DEFAULT_AUDIT_LOG_PATH,
        credentialsPath: CREDENTIALS_PATH,
        backendUrl: process.env.ELEANOR4DEVS_API_BASE ?? DEFAULT_API_BASE,
        // eslint-disable-next-line no-console
        log: (text: string) => console.log(text),
      });
    }
    case "status": {
      maybePrintMigrationWarning({ statePath: STATE_PATH });
      // Optional `--session <id>` (passed by `/e4d-status` as
      // ${CLAUDE_SESSION_ID}) appends a read-only "this session monitored?"
      // line. Absent for a plain `eleanor4devs status`.
      const sIdx = rest.indexOf("--session");
      const sessionId =
        sIdx !== -1 && rest[sIdx + 1] !== undefined ? rest[sIdx + 1] : undefined;
      return runStatus({
        statePath: STATE_PATH,
        backendUrl: process.env.ELEANOR4DEVS_API_BASE ?? DEFAULT_API_BASE,
        credentialsPath: CREDENTIALS_PATH,
        ...(sessionId !== undefined ? { sessionId } : {}),
        // eslint-disable-next-line no-console
        log: (text: string) => console.log(text),
      });
    }
    case "auth": {
      // TR-006 (Phase 17): `--test-mode <code>` opts into the test-mode
      // bypass. parseAuthArgs throws on `--test-mode` with no code.
      let parsed;
      try {
        parsed = parseAuthArgs(rest);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
      try {
        const baseOpts = {
          apiBase: process.env.ELEANOR4DEVS_API_BASE ?? DEFAULT_API_BASE,
          display: (text: string) => {
            // eslint-disable-next-line no-console
            console.log(text);
          },
          credentialsPath: CREDENTIALS_PATH,
        };
        // Only include `testMode` when it's set — exactOptionalPropertyTypes
        // requires the key to be absent rather than `undefined`.
        const result =
          parsed.mode === "test"
            ? await authFlow({ ...baseOpts, testMode: { code: parsed.code } })
            : await authFlow(baseOpts);
        // eslint-disable-next-line no-console
        console.log(
          `Linked. Refresh token saved to ${CREDENTIALS_PATH}. (token length: ${result.refreshToken.length})`,
        );
        return 0;
      } catch (err) {
        if (err instanceof TestModeNotEnabledError) {
          // eslint-disable-next-line no-console
          console.error(err.message);
          return 1;
        }
        throw err;
      }
    }
    case "logout": {
      // Revoke the stored refresh_token server-side, then clear the local
      // credential. Idempotent + privacy-monotonic (see commands/logout.ts).
      // ELEANOR4DEVS_CREDENTIALS_PATH override mirrors ELEANOR4DEVS_API_BASE
      // — present for testability; production uses the real HOME path.
      return runLogout({
        credentialsPath:
          process.env.ELEANOR4DEVS_CREDENTIALS_PATH ?? CREDENTIALS_PATH,
        backendUrl: process.env.ELEANOR4DEVS_API_BASE ?? DEFAULT_API_BASE,
        // eslint-disable-next-line no-console
        log: (text: string) => console.log(text),
        // eslint-disable-next-line no-console
        errorLog: (text: string) => console.error(text),
      });
    }
    case "skills": {
      if (rest[0] === "list") {
        const skills = listSkills({ targetDir: SKILLS_TARGET_DIR });
        if (skills.length === 0) {
          // eslint-disable-next-line no-console
          console.log("(no skills installed yet; run `eleanor4devs install`)");
        } else {
          for (const s of skills) {
            // eslint-disable-next-line no-console
            console.log(s);
          }
        }
        return 0;
      }
      // eslint-disable-next-line no-console
      console.error(`unknown 'skills' subcommand: ${rest[0] ?? "(none)"}`);
      return 1;
    }
    default:
      // eslint-disable-next-line no-console
      console.error(`unknown command: ${first}`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "eleanor4devs - the Eleanor CLI",
      "",
      "  eleanor4devs --version",
      "  eleanor4devs install              install MCP entry + Core Skills Pack + hook templates",
      "  eleanor4devs install-skills       install Core Skills Pack only",
      "  eleanor4devs skills list          list installed skills",
      "  eleanor4devs toggle --session <id>",
      "                                    flip per-session reporting state",
      "                                    (invoked by /e4d in a Claude Code session;",
      "                                    don't run directly — the slash command",
      "                                    provides the session id from ${CLAUDE_SESSION_ID})",
      "  eleanor4devs status               show linked state + recent-sessions table",
      "  eleanor4devs auth                 link this CLI to your Telegram account",
      "  eleanor4devs logout               revoke the stored token + clear the local credential",
      "  eleanor4devs auth --test-mode <code>",
      "                                    one-shot test-mode bypass (Red Team",
      "                                    /systemtest only; backend must run",
      "                                    with ELEANOR_TEST_MODE=1)",
      "  eleanor4devs hook <event>         Claude Code hook intake (used internally",
      "                                    by templates written to ~/.claude/settings.json:",
      "                                    after_create | before_run | after_run | before_remove)",
      "",
      "More: docs/products/eleanor4devs/eleanor4devs-spec.md",
    ].join("\n"),
  );
}

/**
 * Auto-invoke `main` only when this file is the entrypoint — never when
 * it's imported (e.g. from a test that wants to call `main([...])` with
 * a fake argv). The ESM-safe entrypoint check compares this file's URL
 * to the process's argv[1] URL.
 */
function isCliEntrypoint(): boolean {
  // eslint-disable-next-line no-undef
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(argv1)).href;
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  // eslint-disable-next-line no-undef
  main(process.argv.slice(2))
    .then((code) => {
      // eslint-disable-next-line no-undef
      process.exit(code);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      // eslint-disable-next-line no-undef
      process.exit(1);
    });
}
