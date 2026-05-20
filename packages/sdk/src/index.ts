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

/**
 * Canonical entry-point for the eleanor4devs SDK.
 *
 * Construct an `Eleanor` to interact with the backend; methods land in
 * later phase-7 tasks (MCP verb wrappers, thread orchestration, etc.).
 */
export class Eleanor {
  readonly validationProfile: ValidationProfile;

  constructor(options: EleanorOptions = {}) {
    this.validationProfile = options.validationProfile ?? "core";
  }
}

export { AuthClient } from "./auth.js";
export type { AuthClientOptions } from "./auth.js";
