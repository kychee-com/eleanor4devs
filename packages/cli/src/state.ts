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

export interface PruneStaleOpts extends StatePathOpts {
  /**
   * Staleness window in seconds. Defaults to
   * `ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS` (the SAME env the backend sweep
   * reads, [[DD-57]]) or 72h when that env is unset/invalid — so the local
   * and backend windows never surprise-diverge.
   */
  windowSeconds?: number;
}

export interface RefreshLastSeenOpts extends StatePathOpts {
  /**
   * Debounce interval in seconds. A refresh whose current activity time is
   * within this of `now` is skipped (no rewrite). Defaults to 1h, so a hook
   * firing every turn writes state.json at most once per hour per session.
   */
  debounceSeconds?: number;
}

/** Default staleness window — 72h, identical to the backend sweep ([[DD-57]]). */
export const DEFAULT_EXPIRY_WINDOW_SECONDS = 72 * 3600;
/** Default refresh debounce — 1h (≤ 1 state.json write per hour per session). */
const DEFAULT_DEBOUNCE_SECONDS = 3600;

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
  /**
   * Last-activity timestamp (Phase 26, [[DD-70]]) — refreshed (debounced) when
   * a lifecycle hook fires for this session. OPTIONAL: a record written before
   * v0.15.x has none, and the staleness logic falls back to `toggled_at`.
   */
  last_seen_at?: string | null;
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
 * Resolve the staleness window from `ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS`,
 * mirroring the backend's `_window_from_env` (backend/.../expiry_sweep.py):
 * absent / empty / non-integer / <= 0 all fall back to the 72h default, so
 * the local prune and the backend sweep stay coherent.
 */
function windowSecondsFromEnv(): number {
  const raw = process.env.ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_EXPIRY_WINDOW_SECONDS;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) {
    return DEFAULT_EXPIRY_WINDOW_SECONDS;
  }
  return value > 0 ? value : DEFAULT_EXPIRY_WINDOW_SECONDS;
}

/**
 * Normalize a raw on-disk record to a clean `OnDiskSessionRecord`, or null if
 * the shape is invalid (fail-closed — a malformed record is dropped, never
 * promoted to a real opt-in). A wrong-typed `last_seen_at` is dropped to
 * absent (the staleness logic then falls back to `toggled_at`).
 */
function normalizeRecord(rec: unknown): OnDiskSessionRecord | null {
  if (typeof rec !== "object" || rec === null) {
    return null;
  }
  const r = rec as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") {
    return null;
  }
  if (r.toggled_at !== null && typeof r.toggled_at !== "string") {
    return null;
  }
  const out: OnDiskSessionRecord = {
    enabled: r.enabled,
    toggled_at: (r.toggled_at as string | null) ?? null,
  };
  if (typeof r.last_seen_at === "string") {
    out.last_seen_at = r.last_seen_at;
  }
  return out;
}

/**
 * Read every well-formed v2 per-session record (preserving `last_seen_at`).
 * Fail-closed: a missing / v1 / corrupt file yields `{}`; malformed individual
 * records are dropped. This is the read half shared by the staleness API and
 * `setSessionReporting`.
 */
function readV2Records(path: string): Record<string, OnDiskSessionRecord> {
  const parsed = parseStateFile(path);
  if (parsed.kind !== "v2") {
    return {};
  }
  const out: Record<string, OnDiskSessionRecord> = {};
  for (const [sid, rec] of Object.entries(parsed.sessions)) {
    const normalized = normalizeRecord(rec);
    if (normalized !== null) {
      out[sid] = normalized;
    }
  }
  return out;
}

/** Persist a full v2 record map atomically (temp + rename), creating parents. */
function writeV2Records(
  path: string,
  sessions: Record<string, OnDiskSessionRecord>,
): void {
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

  // Preserve every well-formed sibling record INCLUDING its `last_seen_at`.
  // A v1 / absent / corrupt file yields {} (drop the v1 global enabled — never
  // auto-opt-in any session); malformed siblings are dropped by normalization.
  const sessions = readV2Records(path);

  // Fresh write for the target — toggling is explicit activity, so the clock
  // resets: drop any prior `last_seen_at` and let `toggled_at` be the staleness
  // reference until the next debounced refresh.
  sessions[sessionId] = { enabled, toggled_at: ts };

  writeV2Records(path, sessions);
}

/**
 * Count of `enabled:true` per-session records. Fail-closed: a missing /
 * corrupt / v1 file returns 0. This is the reference count for hook
 * registration ([[DD-69]]) — when it reaches 0 the four lifecycle hooks
 * de-register.
 */
export function countEnabledSessions(opts: StatePathOpts = {}): number {
  const path = opts.statePath ?? DEFAULT_STATE_PATH;
  return Object.values(readV2Records(path)).filter((r) => r.enabled).length;
}

/**
 * Drop every per-session record whose effective activity time
 * (`last_seen_at` ?? `toggled_at`) is older than the staleness window, and
 * return the count of ENABLED records that remain ([[DD-70]]). A record with
 * no parseable timestamp is treated as stale (fail-closed). The file is
 * rewritten ONLY when at least one record is dropped — a no-stale call leaves
 * the file byte-identical and never creates an absent file. The window
 * resolves from `opts.windowSeconds`, else `ELEANOR4DEVS_EXPIRY_WINDOW_SECONDS`,
 * else 72h.
 */
export function pruneStaleSessions(
  now: Date,
  opts: PruneStaleOpts = {},
): number {
  const path = opts.statePath ?? DEFAULT_STATE_PATH;
  const windowMs = (opts.windowSeconds ?? windowSecondsFromEnv()) * 1000;
  const nowMs = now.getTime();

  const sessions = readV2Records(path);
  const kept: Record<string, OnDiskSessionRecord> = {};
  let dropped = false;
  for (const [sid, rec] of Object.entries(sessions)) {
    const effective = rec.last_seen_at ?? rec.toggled_at;
    const effMs = effective !== null ? Date.parse(effective) : Number.NaN;
    const stale = Number.isNaN(effMs) || nowMs - effMs >= windowMs;
    if (stale) {
      dropped = true;
    } else {
      kept[sid] = rec;
    }
  }
  if (dropped) {
    writeV2Records(path, kept);
  }
  return Object.values(kept).filter((r) => r.enabled).length;
}

/**
 * DEBOUNCED last-activity stamp for an opted-in session ([[DD-70]]). Rewrites
 * `last_seen_at` to `now` only when the record exists, is enabled, and its
 * current effective activity time is older than `debounceSeconds` (default 1h)
 * — so a hook firing every turn writes state.json at most once per hour per
 * session. A no-op (no rewrite) for an absent or not-enabled record, so a
 * non-opted-in session never causes a state write.
 */
export function refreshLastSeen(
  sessionId: string,
  now: Date,
  opts: RefreshLastSeenOpts = {},
): void {
  const path = opts.statePath ?? DEFAULT_STATE_PATH;
  const debounceMs = (opts.debounceSeconds ?? DEFAULT_DEBOUNCE_SECONDS) * 1000;

  const sessions = readV2Records(path);
  const rec = sessions[sessionId];
  if (rec === undefined || !rec.enabled) {
    return;
  }
  const effective = rec.last_seen_at ?? rec.toggled_at;
  if (effective !== null) {
    const effMs = Date.parse(effective);
    if (!Number.isNaN(effMs) && now.getTime() - effMs <= debounceMs) {
      return; // within the debounce window — skip the write
    }
  }
  sessions[sessionId] = { ...rec, last_seen_at: now.toISOString() };
  writeV2Records(path, sessions);
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
