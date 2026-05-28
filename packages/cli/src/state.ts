/**
 * Reporting-state read/write — the heart of Local Reporting Control.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control (acceptance lines 403-409) + § Security cross-ref (line 435).
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 19, Group A.
 *
 * Contract (per [[DD-40]] + [[DD-42]]):
 *   - Single state file at `~/.eleanor4devs/state.json` (DEFAULT_STATE_PATH).
 *   - JSON object with two keys: `enabled: boolean`, `toggled_at: string|null`.
 *   - Reader is FAIL-CLOSED: any failure to produce a clean
 *     {enabled: boolean, toggledAt: string|null} returns the OFF default
 *     `{enabled: false, toggledAt: null}` rather than throwing. The
 *     privacy invariant is "if in doubt, OFF" — a corruption bug must
 *     never silently re-enable reporting for a user who toggled OFF.
 *   - Writer is ATOMIC: it writes to `<path>.tmp` then `rename`s to the
 *     final path. This avoids leaving a half-written file behind that the
 *     reader would parse as corrupt (and fail-close to OFF — a quiet
 *     un-toggling the user never asked for).
 *
 * Callers that consult readReportingState as a state-gate before any
 * outbound POST:
 *   - packages/cli/src/commands/hook.ts (Phase 19, Group D — the only
 *     passive-reporting code path in the CLI today).
 *
 * If a future caller adds a new outbound POST that should respect the
 * kill switch, register it in the list above. `auth.ts` is intentionally
 * NOT gated — `eleanor4devs auth` is opt-in by direct user action and is
 * unrelated to the passive observation of `claude` sessions.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface ReportingState {
  enabled: boolean;
  /** ISO-8601 UTC timestamp of the last toggle, or null if never toggled. */
  toggledAt: string | null;
}

export interface StatePathOpts {
  /** Override the on-disk path. Defaults to DEFAULT_STATE_PATH. */
  statePath?: string;
}

/** OFF — the privacy-safe default for any read failure. */
const OFF_DEFAULT: ReportingState = Object.freeze({
  enabled: false,
  toggledAt: null,
}) as ReportingState;

/** Default path: `~/.eleanor4devs/state.json` per [[DD-40]]. */
export const DEFAULT_STATE_PATH: string = join(
  homedir(),
  ".eleanor4devs",
  "state.json",
);

/**
 * Read the current reporting state from disk.
 *
 * FAIL-CLOSED per [[DD-42]]: any failure mode — missing file, unreadable
 * file, unparseable JSON, wrong root type, wrong field types — returns
 * `{enabled: false, toggledAt: null}` without throwing.
 */
export function readReportingState(opts: StatePathOpts = {}): ReportingState {
  const path = opts.statePath ?? DEFAULT_STATE_PATH;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { ...OFF_DEFAULT };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...OFF_DEFAULT };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...OFF_DEFAULT };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.enabled !== "boolean") {
    return { ...OFF_DEFAULT };
  }
  if (obj.toggled_at !== null && typeof obj.toggled_at !== "string") {
    return { ...OFF_DEFAULT };
  }
  return {
    enabled: obj.enabled,
    toggledAt: (obj.toggled_at as string | null) ?? null,
  };
}

/**
 * Write a new reporting state to disk, atomically.
 *
 * Writes to `<path>.tmp` then `renameSync`s to the final path. Parent
 * dirs are auto-created. The on-disk JSON shape uses snake_case
 * (`toggled_at`) to match [[DD-40]]; the in-memory shape uses camelCase
 * (`toggledAt`) to match TypeScript convention.
 */
export function writeReportingState(
  state: ReportingState,
  opts: StatePathOpts = {},
): void {
  const path = opts.statePath ?? DEFAULT_STATE_PATH;
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const onDisk = {
    enabled: state.enabled,
    toggled_at: state.toggledAt,
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(onDisk, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}
