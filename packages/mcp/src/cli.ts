#!/usr/bin/env node
/**
 * @eleanor4devs/mcp CLI binary entry point.
 *
 * Flags (per TR-003 + TR-005 fix cycle):
 *   --version    Print package version, exit 0.
 *   --dry-run    Accept mocked verb calls on stdio; dispatch through the
 *                validation surface without contacting the backend. The
 *                Red Team probes the no-new-vector contract with this.
 *   --verify     Verify the local install's bytes against the npm
 *                registry's published shasum + provenance attestation.
 *                Useful for supply-chain assurance.
 *   --help       List flags.
 *   (no flag)    Run the production MCP server on stdio.
 *
 * The dry-run handler is intentionally a pure function — no filesystem
 * access, no network egress. A unit test pins the absence of `fs`/`http`
 * imports inside its source.
 */
import { FORBIDDEN_REPORT_ARG_KEYS, REPORT_EVENTS } from "./index.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const requireFrom = createRequire(import.meta.url);

export type CliCommand =
  | { command: "version" }
  | { command: "help" }
  | { command: "dry-run" }
  | { command: "verify" }
  | { command: "server" }
  | { command: "unknown"; arg: string };

/** Pure argv parser — first matching flag wins. */
export function parseArgv(argv: readonly string[]): CliCommand {
  if (argv.length === 0) return { command: "server" };
  for (const arg of argv) {
    if (arg === "--version") return { command: "version" };
    if (arg === "--help") return { command: "help" };
    if (arg === "--dry-run") return { command: "dry-run" };
    if (arg === "--verify") return { command: "verify" };
  }
  return { command: "unknown", arg: argv[0]! };
}

/** Read package.json synchronously at CLI startup, return version. */
export function handleVersionFlag(): string {
  // Uses `createRequire(import.meta.url)` (declared at module top) so
  // the file works under ESM (`"type": "module"` in package.json).
  // Bare `require()` is not defined in ESM scope.
  const pkg = requireFrom("../package.json") as { version: string };
  return pkg.version;
}

export interface DryRunRequest {
  verb: string;
  payload: Record<string, unknown>;
}

export interface DryRunResult {
  ok: boolean;
  event?: string;
  error?: "unknown_verb" | "unknown_event" | "forbidden_arg";
  detail?: string;
}

const REPORT_EVENT_SET: ReadonlySet<string> = new Set<string>(REPORT_EVENTS);
const FORBIDDEN_SET: ReadonlySet<string> = new Set<string>(
  FORBIDDEN_REPORT_ARG_KEYS,
);

/**
 * Pure verb-dispatch function used by `--dry-run`. No filesystem access,
 * no network egress. The Red Team probe relies on this purity: if a
 * verb were ever to read a file or open a socket during validation, it
 * would defeat the no-new-vector contract.
 */
export function handleDryRunRequest(req: DryRunRequest): DryRunResult {
  if (req.verb !== "report") {
    return { ok: false, error: "unknown_verb" };
  }
  for (const key of Object.keys(req.payload)) {
    if (FORBIDDEN_SET.has(key)) {
      return {
        ok: false,
        error: "forbidden_arg",
        detail: `payload contained forbidden arg: ${key}`,
      };
    }
  }
  const event = (req.payload as { event?: unknown }).event;
  if (typeof event !== "string" || !REPORT_EVENT_SET.has(event)) {
    return { ok: false, error: "unknown_event" };
  }
  return { ok: true, event };
}


// ---------------------------------------------------------------------------
// --verify supply-chain check
// ---------------------------------------------------------------------------

export interface RegistryDist {
  shasum: string;
  attestations?: unknown;
}

export interface RegistryVersionMeta {
  version: string;
  dist: RegistryDist;
}

export interface VerifyDeps {
  version: string;
  readLocalTarball: () => Promise<Buffer>;
  fetchRegistryMeta: (version: string) => Promise<RegistryVersionMeta>;
  sha256: (buf: Buffer) => string;
}

export interface VerifyResult {
  ok: boolean;
  version: string;
  error?: "shasum_mismatch" | "no_attestation" | "version_mismatch";
  detail?: string;
}

/**
 * Verify the local install's tarball against the npm registry's published
 * shasum + provenance attestation.
 *
 * Pure with respect to its injected dependencies — the production caller
 * provides `readLocalTarball` (reads the installed .tgz from disk),
 * `fetchRegistryMeta` (single GET to https://registry.npmjs.org), and
 * `sha256` (node:crypto). The test harness substitutes fakes.
 */
export async function verifyAgainstRegistry(
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const meta = await deps.fetchRegistryMeta(deps.version);
  if (meta.version !== deps.version) {
    return {
      ok: false,
      version: deps.version,
      error: "version_mismatch",
      detail: `registry returned version ${meta.version}, expected ${deps.version}`,
    };
  }
  const local = await deps.readLocalTarball();
  const localSha = deps.sha256(local);
  if (localSha !== meta.dist.shasum) {
    return {
      ok: false,
      version: deps.version,
      error: "shasum_mismatch",
      detail: `local sha256 ${localSha} does not match expected ${meta.dist.shasum}`,
    };
  }
  if (
    meta.dist.attestations === undefined ||
    meta.dist.attestations === null
  ) {
    return {
      ok: false,
      version: deps.version,
      error: "no_attestation",
      detail:
        "npm registry returned no provenance attestation — package was " +
        "published without OIDC trusted-publisher (publish silently fell " +
        "back to anonymous)",
    };
  }
  return { ok: true, version: deps.version };
}


// ---------------------------------------------------------------------------
// Top-level dispatcher (F-006 fix)
// ---------------------------------------------------------------------------

/**
 * Print the human-readable flag list. Used by `--help` and by the
 * unknown-flag error path.
 */
function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "eleanor4devs-mcp — Eleanor's MCP server",
      "",
      "  eleanor4devs-mcp --version    Print package version",
      "  eleanor4devs-mcp --help       Show this message",
      "  eleanor4devs-mcp --dry-run    Pure verb-dispatch via stdio (no I/O)",
      "  eleanor4devs-mcp --verify     Supply-chain check vs npm registry",
      "  eleanor4devs-mcp              Run the production MCP server (stdio)",
      "",
      "Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § MCP",
    ].join("\n"),
  );
}

/**
 * Read one line of JSON from stdin synchronously. Uses `readFileSync(0)`
 * (fd 0 = stdin) — covered by the cli.ts allowlist in the source lint.
 * Returns the parsed object or throws on malformed JSON.
 */
function readJsonLineFromStdin(): DryRunRequest {
  // Reading the entire stdin to EOF — pipes are short, no streaming
  // needed for dry-run validation. `readFileSync(0)` reads from fd 0
  // (stdin) and is covered by the cli.ts allowlist in source_lint.test.ts.
  const raw = readFileSync(0, "utf-8").trim();
  // Take only the first line if multiple were piped in.
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const parsed = JSON.parse(firstLine) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { verb?: unknown }).verb !== "string"
  ) {
    throw new Error(
      `--dry-run stdin must be a JSON object with a 'verb' string field`,
    );
  }
  const obj = parsed as { verb: string; payload?: unknown };
  return {
    verb: obj.verb,
    payload:
      typeof obj.payload === "object" && obj.payload !== null
        ? (obj.payload as Record<string, unknown>)
        : {},
  };
}

/**
 * Production `--verify` deps wired against the local filesystem +
 * npm registry. Kept inline so the dispatcher is the only place that
 * names real I/O; the pure helpers (`verifyAgainstRegistry`,
 * `handleDryRunRequest`) stay testable in isolation.
 */
async function runVerify(): Promise<VerifyResult> {
  const pkg = requireFrom("../package.json") as { name: string; version: string };
  return verifyAgainstRegistry({
    version: pkg.version,
    readLocalTarball: async () => {
      // The published tarball is not present on disk after `npm install`,
      // so --verify operates against an explicitly-passed tarball path
      // in production. In bootstrap mode (no tarball available) we fail
      // with a clear remediation message rather than pretending to verify.
      const tarballPath = process.env.ELEANOR4DEVS_VERIFY_TARBALL;
      if (typeof tarballPath !== "string" || tarballPath.length === 0) {
        throw new Error(
          "--verify requires ELEANOR4DEVS_VERIFY_TARBALL=<path-to-tgz>. " +
            "Bootstrap path: `npm pack @eleanor4devs/mcp@<version>` then " +
            "re-run with that path.",
        );
      }
      return Buffer.from(await readFile(tarballPath));
    },
    fetchRegistryMeta: async (version: string) => {
      const url = `https://registry.npmjs.org/${pkg.name}/${version}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `npm registry returned ${res.status} for ${pkg.name}@${version}`,
        );
      }
      return (await res.json()) as RegistryVersionMeta;
    },
    sha256: (buf: Buffer) =>
      createHash("sha256").update(buf).digest("hex"),
  });
}

/**
 * Top-level dispatcher. Routes the parsed CliCommand to its handler and
 * exits with the appropriate code. Pulled out as `main(argv)` so unit
 * tests can drive it directly, but the binary entry below calls it with
 * `process.argv.slice(2)`.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const cmd = parseArgv(argv);
  switch (cmd.command) {
    case "version":
      // eslint-disable-next-line no-console
      console.log(handleVersionFlag());
      return 0;
    case "help":
      printHelp();
      return 0;
    case "dry-run": {
      try {
        const req = readJsonLineFromStdin();
        const result = handleDryRunRequest(req);
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result));
        return 0;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `--dry-run: ${(err as Error).message ?? String(err)}`,
        );
        return 1;
      }
    }
    case "verify": {
      try {
        const result = await runVerify();
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result));
        return result.ok ? 0 : 1;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `--verify: ${(err as Error).message ?? String(err)}`,
        );
        return 1;
      }
    }
    case "server":
      // Production MCP server bootstrap not yet wired (lands in Phase 11
      // when the MCP wire protocol is finalized). Fail with a clear
      // remediation message so the failure mode is honest, not silent.
      // eslint-disable-next-line no-console
      console.error(
        "eleanor4devs-mcp: production server bootstrap not yet wired. " +
          "See docs/plans/eleanor4devs-plan.md Phase 11. For supply-chain " +
          "or dry-run dispatch use --verify or --dry-run.",
      );
      return 1;
    case "unknown":
      // eslint-disable-next-line no-console
      console.error(`unknown flag: ${cmd.arg}`);
      printHelp();
      return 1;
  }
}

// Detect "am I being run as a script?". When the bin is invoked via
// `node dist/cli.js`, `import.meta.url` points at the cli.js file and
// `process.argv[1]` resolves to the same path. When this file is
// imported as a module (unit tests), the two differ and we DO NOT
// auto-dispatch. Uses createRequire because raw `require` is not
// defined in ESM (package.json has "type": "module").
function isCliEntrypoint(): boolean {
  if (typeof process === "undefined" || !process.argv?.[1]) return false;
  try {
    const entryUrl = pathToFileURL(process.argv[1]).href;
    return entryUrl === import.meta.url;
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
