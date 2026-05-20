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
  // Defer the FS read so the module-level dry-run path stays
  // FS-free (the source-lint pin in cli.test.ts checks
  // handleDryRunRequest.toString() for fs references).
  // Using require() keeps this CJS-compatible and lazy.
  const { createRequire } = require("node:module") as typeof import("node:module");
  const req = createRequire(import.meta.url);
  const pkg = req("../package.json") as { version: string };
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
