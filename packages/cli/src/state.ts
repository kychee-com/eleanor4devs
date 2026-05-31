/**
 * Reporting-state read/write — the heart of Local Reporting Control.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control (v0.14.0 — PER-SESSION, acceptance lines 461-465).
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 23, Group A.
 *
 * Contract (per [[DD-53]]):
 *   - Single state file at `~/.eleanor4devs/state.json` (DEFAULT_STATE_PATH).
 *   - On-disk shape:
 *     `{ "version": 2, "sessions": { "<session_id>": { "enabled": boolean, "toggled_at": string|null } } }`
 *   - Reader is FAIL-CLOSED: any failure to produce a clean record for the
 *     queried session — missing file, unparseable JSON, wrong shape, unknown
 *     session_id, wrong field types — returns the OFF default
 *     `{enabled: false, toggledAt: null}` rather than throwing. The privacy
 *     invariant is "if in doubt, OFF" — a corruption bug must never silently
 *     opt-in a session the user never opted in.
 *   - Writer is ATOMIC: writes to `<path>.tmp` then `rename`s to the final
 *     path. Concurrent sessions are preserved (a write of SID_A never
 *     overwrites SID_B's record).
 *   - v1 → v2 migration is READ-ONLY: a legacy v1 file `{enabled, toggled_at}`
 *     on disk causes every session to read as not-enabled (privacy-safe —
 *     a stale global `enabled: true` is NEVER auto-applied to any session).
 *     The first `setSessionReporting` call replaces the v1 file with a v2
 *     map containing ONLY the session being set.
 *
 * Callers that consult readSessionReporting as a state-gate before any
 * outbound POST:
 *   - packages/cli/src/commands/hook.ts (Phase 23 Group A — the only
 *     passive-reporting code path in the CLI).
 *
 * If a future caller adds a new outbound POST that should respect the
 * per-session opt-in, register it in the list above. `auth.ts` is
 * intentionally NOT gated — `eleanor4devs auth` is opt-in by direct user
 * action and is unrelated to passive observation of `claude` sessions.
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

// ----------------------------------------------------------------------------
// Per-session API (v2 — the post-v0.14.0 contract).
// ----------------------------------------------------------------------------

/**
 * In-memory shape returned by readSessionReporting.
 *
 * Same fields as the deprecated machine-wide ReportingState — kept stable
 * so callers migrating from one to the other don't need to relearn the
 * payload, only the per-session keying.
 */
export interface SessionReportingState {
  enabled: boolean;
  /** ISO-8601 UTC timestamp of the last toggle for this session, or null. */
  toggledAt: string | null;
}

export interface StatePathOpts {
  /** Override the on-disk path. Defaults to DEFAULT_STATE_PATH. */
  statePath?: string;
}

export interface SetSessionReportingOpts extends StatePathOpts {
  /** Clock for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** OFF — the privacy-safe default for any read failure. */
const OFF_DEFAULT: SessionReportingState = Object.freeze({
  enabled: false,
  toggledAt: null,
}) as SessionReportingState;

/** Default path: `~/.eleanor4devs/state.json` per [[DD-40]]/[[DD-53]]. */
export const DEFAULT_STATE_PATH: string = join(
  homedir(),
  ".eleanor4devs",
  "state.json",
);

interface OnDiskSessionRecord {
  enabled: boolean;
  toggled_at: string | null;
}

interface OnDiskV2 {
  version: 2;
  sessions: Record<string, OnDiskSessionRecord>;
}

/**
 * Result of probing the state file's on-disk shape.
 *
 *   - `v2`: the post-v0.14.0 per-session map. Honored.
 *   - `v1`: a pre-v0.14.0 global toggle file. Treated as "no session opted in"
 *     on read (privacy-safe); replaced wholesale by the first write.
 *   - `absent` / `corrupt`: nothing readable. Every session reads as OFF.
 */
type ParsedState =
  | { kind: "v2"; sessions: Record<string, unknown> }
  | { kind: "v1" }
  | { kind: "absent" }
  | { kind: "corrupt" };

function parseStateFile(path: string): ParsedState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "corrupt" };
  }
  const obj = parsed as Record<string, unknown>;
  if (
    obj.version === 2 &&
    typeof obj.sessions === "object" &&
    obj.sessions !== null &&
    !Array.isArray(obj.sessions)
  ) {
    return {
      kind: "v2",
      sessions: obj.sessions as Record<string, unknown>,
    };
  }
  // Looks like a v1 file iff the top-level `enabled` field is a boolean —
  // that's the only distinguishing shape (toggled_at can be null in both).
  if (typeof obj.enabled === "boolean") {
    return { kind: "v1" };
  }
  return { kind: "corrupt" };
}

function recordToState(rec: unknown): SessionReportingState {
  if (typeof rec !== "object" || rec === null) {
    return { ...OFF_DEFAULT };
  }
  const r = rec as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") {
    return { ...OFF_DEFAULT };
  }
  if (r.toggled_at !== null && typeof r.toggled_at !== "string") {
    return { ...OFF_DEFAULT };
  }
  return {
    enabled: r.enabled,
    toggledAt: (r.toggled_at as string | null) ?? null,
  };
}

/**
 * Read the per-session reporting state for a single session_id.
 *
 * FAIL-CLOSED per [[DD-53]]/[[DD-42]]: every failure mode — missing file,
 * unparseable JSON, wrong shape, v1 legacy file, unknown session_id, wrong
 * field types — returns `{enabled: false, toggledAt: null}` without
 * throwing. **Never auto-opts-in a session that wasn't explicitly set.**
 */
export function readSessionReporting(
  sessionId: string,
  opts: StatePathOpts = {},
): SessionReportingState {
  const path = opts.statePath ?? DEFAULT_STATE_PATH;
  const parsed = parseStateFile(path);
  if (parsed.kind !== "v2") {
    return { ...OFF_DEFAULT };
  }
  return recordToState(parsed.sessions[sessionId]);
}

/**
 * Set the reporting state for a single session_id and persist atomically.
 *
 * On a v1/absent/corrupt file: replaces it wholesale with a fresh v2 map
 * containing ONLY the session being set. **A pre-existing v1 `enabled: true`
 * is dropped — never auto-applied to any session.**
 *
 * On a v2 file: preserves every other session's record and updates only
 * the targeted session_id.
 */
export function setSessionReporting(
  sessionId: string,
  enabled: boolean,
  opts: SetSessionReportingOpts = {},
): void {
  const path = opts.statePath ?? DEFAULT_STATE_PATH;
  const nowFn = opts.now ?? (() => new Date());
  const ts = nowFn().toISOString();

  const parsed = parseStateFile(path);
  const sessions: Record<string, OnDiskSessionRecord> = {};
  if (parsed.kind === "v2") {
    // Preserve every well-formed sibling record. Drop malformed ones —
    // we never persist garbage on top of garbage.
    for (const [sid, rec] of Object.entries(parsed.sessions)) {
      const normalized = recordToState(rec);
      // Only keep records where the on-disk shape was valid (otherwise
      // recordToState returned the OFF default, which we shouldn't promote
      // to a real session-record).
      if (
        typeof rec === "object" &&
        rec !== null &&
        typeof (rec as Record<string, unknown>).enabled === "boolean"
      ) {
        sessions[sid] = {
          enabled: normalized.enabled,
          toggled_at: normalized.toggledAt,
        };
      }
    }
  }
  // v1 / absent / corrupt: start from empty (drop the v1 global enabled,
  // never auto-opt-in any session).

  sessions[sessionId] = { enabled, toggled_at: ts };

  const onDisk: OnDiskV2 = { version: 2, sessions };
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(onDisk, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/**
 * Detect whether the on-disk file is a legacy v1 (pre-v0.14.0) global toggle.
 * Used by the first-run migration UX warning to decide whether to nudge the
 * user about re-opting-in sessions (since v1 → v2 silently drops the
 * global ON).
 */
export function isLegacyV1StateFile(opts: StatePathOpts = {}): boolean {
  const path = opts.statePath ?? DEFAULT_STATE_PATH;
  return parseStateFile(path).kind === "v1";
}

// ----------------------------------------------------------------------------
// Legacy machine-wide API (DEPRECATED — removed in Phase 23 Group F).
//
// The pre-v0.14.0 global toggle. Spec v0.14.0 replaces it with the
// per-session API above. These stubs are kept ONLY so that callers still on
// the old shape (status.ts, Phase 21) typecheck during the Group A window;
// the stubs always return / no-op as the OFF default, because there is no
// global state anymore.
// ----------------------------------------------------------------------------

/** @deprecated Use `readSessionReporting(sessionId, ...)`. Removed in Group F. */
export interface ReportingState {
  enabled: boolean;
  toggledAt: string | null;
}

/**
 * @deprecated Use `readSessionReporting(sessionId, ...)`. There is no global
 * reporting state in spec v0.14.0+ — this stub always returns the OFF default
 * so legacy callers (status.ts) typecheck. Status display is rewritten in
 * Phase 23 Group F.
 */
export function readReportingState(_opts: StatePathOpts = {}): ReportingState {
  return { ...OFF_DEFAULT };
}

/**
 * @deprecated Use `setSessionReporting(sessionId, ...)`. The legacy global
 * shape is no longer persisted; this stub is a no-op. Callers (legacy
 * toggle.ts) are rewritten in Phase 23 Group A.
 */
export function writeReportingState(
  _state: ReportingState,
  _opts: StatePathOpts = {},
): void {
  /* no-op — see deprecation notice above */
}
