/**
 * @eleanor4devs/cli
 *
 * The eleanor4devs CLI. Commands:
 *   - install                — writes the MCP entry to the agent's
 *                              config (e.g., ~/.claude/mcp_servers.json),
 *                              copies the Core Skills Pack, sets up
 *                              hook templates.
 *   - install-skills [--core | --how-to]
 *   - skills list
 *   - auth                   — drives the one-time-code auth handshake
 *                              with the Eleanor backend via the bot.
 *   - status
 *   - --version
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI.
 */
import { createRequire } from "node:module";

interface PackageJsonLike {
  version?: unknown;
}

/**
 * Resolve the CLI's version from its own `package.json` at module init.
 *
 * F-005 fix: previously hardcoded to "0.0.0" which made every published
 * binary print the wrong version. Stamping from package.json means
 * the printed version always matches what npm shipped.
 */
function readVersionFromPackageJson(): string {
  // `createRequire` keeps this CJS-compatible and works under both the
  // dev `tsc`-emitted ESM and the published `dist/index.js`. The
  // package.json sits one directory above dist/ in the published
  // tarball — match the same relative-path pattern that
  // packages/mcp/src/cli.ts uses for its --version flag.
  const req = createRequire(import.meta.url);
  const pkg = req("../package.json") as PackageJsonLike;
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(
      "@eleanor4devs/cli — package.json missing a `version` field",
    );
  }
  return pkg.version;
}

export const CLI_VERSION: string = readVersionFromPackageJson();
