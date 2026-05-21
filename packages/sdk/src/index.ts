/**
 * @eleanor4devs/sdk
 *
 * Canonical TypeScript SDK for Eleanor. Wraps the MCP verb surface,
 * thread orchestration, status, and auth into a typed Node interface.
 *
 * See:
 *   - docs/products/eleanor4devs/eleanor4devs-spec.md § npm package
 *   - docs/plans/eleanor4devs-plan.md Phase 7
 */
import { createRequire } from "node:module";

/**
 * Validation Profile tier. Mirrors the pytest tiers on the Python
 * backend (Phase 4 Task 17):
 *   - `core` — no network, no real APIs (CI default).
 *   - `extension` — real network, mocked vendors.
 *   - `real_integration` — real billable vendor APIs.
 */
export type ValidationProfile = "core" | "extension" | "real_integration";

/**
 * Options for constructing an {@link Eleanor} instance.
 */
export interface EleanorOptions {
  /**
   * Which validation tier this instance runs in. Defaults to
   * `"core"` — safe by default, no network calls.
   */
  validationProfile?: ValidationProfile;
}

// ---------------------------------------------------------------------------
// Verb types — narrow, typed shapes for the MVP verb surface. Mirrors
// the mcp package's `ReportPayload` shape but lives in the SDK so
// consumers don't have to depend on `@eleanor4devs/mcp` directly.
// ---------------------------------------------------------------------------

/** Branded ID for a thread. */
export type ThreadId = string & { readonly __brand: "ThreadId" };

/** Allowed `event` values on a `report` call (mirrors mcp's REPORT_EVENTS). */
export type ReportEvent =
  | "progress"
  | "done"
  | "blocked"
  | "context_warning"
  | "error"
  | "info"
  | "question";

export interface ReportPayload {
  event: ReportEvent;
  call_id?: string;
  text?: string;
  thread_id?: string;
  destructive?: boolean;
}

export interface ReportResult {
  accepted: boolean;
  /** When event === "question", the backend's decision payload. */
  decision?: unknown;
}

export interface StatusResult {
  /** Best-effort identifier for the linked Telegram user. */
  user_id?: string;
  /** Reachability — `true` if Eleanor's backend is responding. */
  online: boolean;
  /** Active thread count visible to the user. */
  active_threads: number;
}

/** Event handler for `subscribe` — called once per backend-pushed event. */
export type EventHandler = (event: unknown) => void;

/** Returned by `subscribe`; call to detach the handler. */
export type Unsubscribe = () => void;

/**
 * Thrown by stub methods that have not been wired to the MCP wire
 * protocol yet. Full implementations land in Phase 11.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

// ---------------------------------------------------------------------------
// VERSION — stamped from package.json at module init.
// ---------------------------------------------------------------------------

interface PackageJsonLike {
  version?: unknown;
}

function readVersionFromPackageJson(): string {
  const req = createRequire(import.meta.url);
  const pkg = req("../package.json") as PackageJsonLike;
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(
      "@eleanor4devs/sdk — package.json missing a `version` field",
    );
  }
  return pkg.version;
}

/**
 * Build-time-stamped package version. Always equals the `version`
 * field of `@eleanor4devs/sdk/package.json`. Surfaced for the spec's
 * smoke check:
 *   `node -e "import('@eleanor4devs/sdk').then(m => console.log(m.VERSION))"`
 */
export const VERSION: string = readVersionFromPackageJson();

/**
 * Canonical entry-point for the eleanor4devs SDK.
 *
 * Construct an `Eleanor` to interact with the backend. The verb
 * methods (`report`, `status`, `subscribe`) are typed stubs that throw
 * `NotImplementedError`; the wire implementations land in Phase 11 when
 * the MCP wire protocol is finalized.
 */
export class Eleanor {
  readonly validationProfile: ValidationProfile;

  constructor(options: EleanorOptions = {}) {
    this.validationProfile = options.validationProfile ?? "core";
  }

  /**
   * Send a `report` to Eleanor's backend. When `event === "question"`,
   * the returned Promise resolves with the user's decision (per DD-11).
   *
   * Stub: throws `NotImplementedError` until Phase 11 wires the MCP
   * protocol. The type signature is intentionally pinned now so
   * consumers can `expectTypeOf` it and IDE surfacing matches the spec.
   */
  report(_payload: ReportPayload): Promise<ReportResult> {
    return Promise.reject(
      new NotImplementedError(
        "Eleanor.report() — stub, full implementation lands in Phase 11 when the MCP wire protocol is finalized",
      ),
    );
  }

  /**
   * Return Eleanor's current backend status (online, active threads).
   *
   * Stub: throws `NotImplementedError` until Phase 11.
   */
  status(): Promise<StatusResult> {
    return Promise.reject(
      new NotImplementedError(
        "Eleanor.status() — stub, full implementation lands in Phase 11 when the MCP wire protocol is finalized",
      ),
    );
  }

  /**
   * Subscribe to backend-pushed events for a thread. Returns an
   * `Unsubscribe` thunk that detaches the handler.
   *
   * Stub: throws `NotImplementedError` until Phase 11.
   */
  subscribe(_threadId: ThreadId, _handler: EventHandler): Unsubscribe {
    throw new NotImplementedError(
      "Eleanor.subscribe() — stub, full implementation lands in Phase 11 when the MCP wire protocol is finalized",
    );
  }
}

export { AuthClient } from "./auth.js";
export type { AuthClientOptions } from "./auth.js";
