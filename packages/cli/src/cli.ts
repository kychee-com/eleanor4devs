#!/usr/bin/env node
/**
 * `eleanor4devs` CLI binary.
 *
 * Minimal argv dispatcher — no commander/yargs dep. Commands:
 *   eleanor4devs --version
 *   eleanor4devs install                          (Task 8)
 *   eleanor4devs install-skills [--core|--how-to]
 *   eleanor4devs skills list
 *   eleanor4devs auth                             (Task 9 — TODO)
 *   eleanor4devs status                           (TODO)
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { CLI_VERSION } from "./index.js";
import { install } from "./commands/install.js";
import {
  installSkills,
  ALWAYS_APPLY,
} from "./commands/install_skills.js";
import { listSkills } from "./commands/skills_list.js";
import { authFlow, parseAuthArgs, TestModeNotEnabledError } from "./commands/auth.js";

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
const CREDENTIALS_PATH = join(homedir(), ".eleanor4devs", "auth.json");
const DEFAULT_API_BASE = "https://api.eleanor4devs.com";

async function main(argv: string[]): Promise<number> {
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
        skillsSourceDir: PACKAGED_SKILLS,
        skillsTargetDir: SKILLS_TARGET_DIR,
        review: ALWAYS_APPLY,
      });
      // eslint-disable-next-line no-console
      console.log(
        `installed: ${result.skillsInstalled.length} skill(s); mcp entry written.`,
      );
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
      "  eleanor4devs install              install MCP entry + Core Skills Pack",
      "  eleanor4devs install-skills       install Core Skills Pack only",
      "  eleanor4devs skills list          list installed skills",
      "  eleanor4devs auth                 link this CLI to your Telegram account",
      "  eleanor4devs auth --test-mode <code>",
      "                                    one-shot test-mode bypass (Red Team",
      "                                    /systemtest only; backend must run",
      "                                    with ELEANOR_TEST_MODE=1)",
      "",
      "More: docs/products/eleanor4devs/eleanor4devs-spec.md",
    ].join("\n"),
  );
}

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
