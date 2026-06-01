/**
 * `eleanor4devs status` — machine link state + recent-sessions table.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI line 209.
 * Plan: docs/plans/eleanor4devs-plan.md Phase 23 Group F ([[DD-52]]).
 *
 * Phase 23 ([[DD-52]]) killed the machine-wide reporting toggle: reporting
 * is now PER-SESSION, and each session's reporting state IS its `state`
 * column (`disabled` = opted out; `active`/`paused` = monitored). So the
 * first line no longer shows a global ON/OFF — it shows:
 *
 *   - `Eleanor4Devs: not linked`  (no credential, or a stale/revoked one)
 *     + a one-line `eleanor4devs auth` hint.
 *   - `Eleanor4Devs: linked · N session(s) monitored`  (active + paused),
 *     followed by the recent-sessions table (up to 5, all five states).
 *   - `Eleanor4Devs: linked`  + a couldn't-load note when the backend is
 *     unreachable (we have a credential but can't fetch the count).
 *
 * Best-effort + never throws/hangs — a backend hiccup degrades to the
 * couldn't-load note, exit 0.
 */
import { readFileSync } from "node:fs";

import { readSessionReporting } from "../state.js";
import { renderSessionsTable, type SessionRow } from "./sessions_table.js";

export interface RunStatusOpts {
  /** Reporting-state file path. Unused by the link/monitored line (kept for
   * signature stability with callers); per-session state lives server-side. */
  statePath?: string;
  log: (text: string) => void;
  /** Backend base URL. With credentialsPath, drives the link line + table. */
  backendUrl?: string;
  /** Path to ~/.eleanor4devs/auth.json. */
  credentialsPath?: string;
  fetch?: typeof globalThis.fetch;
  /** Injectable clock for the relative-time column (tests). */
  nowMs?: number;
  /**
   * Current Claude session id (`/e4d-status` passes `${CLAUDE_SESSION_ID}`).
   * When set, append a read-only line stating whether THIS session is
   * monitored — read from the LOCAL per-session reporting record only (no
   * network, no state mutation, no audit entry).
   */
  sessionId?: string;
}

const NOT_LINKED = "Eleanor4Devs: not linked";
const AUTH_HINT =
  "  (run `eleanor4devs auth` to link this machine and see your sessions)";
const LOAD_ERR = "  (couldn't load sessions right now)";
// Fetch enough to count monitored sessions accurately while only rendering
// the top few. The backend clamps to its own MAX_LIMIT.
const FETCH_LIMIT = 50;
const TABLE_ROWS = 5;
const MONITORED_STATES = new Set(["active", "paused"]);

type FetchResult =
  | { kind: "not_linked" }
  | { kind: "error" }
  | { kind: "ok"; sessions: SessionRow[] };

export async function runStatus(opts: RunStatusOpts): Promise<number> {
  // No backend wired (shouldn't happen in prod — cli.ts always passes both).
  if (!opts.backendUrl || !opts.credentialsPath) {
    opts.log(NOT_LINKED);
    opts.log(AUTH_HINT);
  } else {
    const result = await fetchSessions(opts);
    if (result.kind === "not_linked") {
      opts.log(NOT_LINKED);
      opts.log(AUTH_HINT);
    } else if (result.kind === "error") {
      // Credential present (linked) but the backend wouldn't give the data.
      opts.log(linkedLine(null));
      opts.log(LOAD_ERR);
    } else {
      const monitored = result.sessions.filter((s) =>
        MONITORED_STATES.has(s.state),
      ).length;
      opts.log(linkedLine(monitored));
      opts.log(
        renderSessionsTable(result.sessions.slice(0, TABLE_ROWS), opts.nowMs),
      );
    }
  }
  // `/e4d-status` extra: this session's own reporting state, read locally.
  const sessionLine = currentSessionLine(opts);
  if (sessionLine !== null) opts.log(sessionLine);
  return 0;
}

/** Read-only "is THIS session monitored" line, from the local record only. */
export function currentSessionLine(opts: RunStatusOpts): string | null {
  const id = opts.sessionId;
  if (id === undefined || id === "") return null;
  // Defensive: the slash-command template literal failed to substitute.
  if (id.startsWith("${")) {
    return "This session: reporting state unavailable (session id not detected).";
  }
  const state = readSessionReporting(
    id,
    opts.statePath !== undefined ? { statePath: opts.statePath } : {},
  );
  return state.enabled
    ? "This session: monitored (reporting ON for this session)."
    : "This session: not monitored — run /e4d to start reporting it.";
}

export function linkedLine(monitored: number | null): string {
  if (monitored === null) return "Eleanor4Devs: linked";
  const noun = monitored === 1 ? "session" : "sessions";
  return `Eleanor4Devs: linked · ${monitored} ${noun} monitored`;
}

/** Read the stored refresh_token, or null if absent/unreadable/malformed. */
function readRefreshToken(path: string): string | null {
  try {
    const obj = JSON.parse(readFileSync(path, "utf-8")) as {
      refresh_token?: unknown;
    };
    return typeof obj.refresh_token === "string" && obj.refresh_token
      ? obj.refresh_token
      : null;
  } catch {
    return null;
  }
}

/** Refresh → list sessions. Maps outcomes to link state + the row set. */
async function fetchSessions(opts: RunStatusOpts): Promise<FetchResult> {
  const refreshToken = readRefreshToken(opts.credentialsPath!);
  if (refreshToken === null) return { kind: "not_linked" };
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = opts.backendUrl!.replace(/\/$/, "");
  try {
    const refreshRes = await fetchFn(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    // A stale/revoked credential (401) is "not linked" — prompt to re-auth.
    if (refreshRes.status === 401) return { kind: "not_linked" };
    if (!refreshRes.ok) return { kind: "error" };
    const tok = (await refreshRes.json()) as { access_token?: unknown };
    if (typeof tok.access_token !== "string" || !tok.access_token) {
      return { kind: "error" };
    }
    const res = await fetchFn(`${base}/sessions?limit=${FETCH_LIMIT}`, {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    if (!res.ok) return { kind: "error" };
    const body = (await res.json()) as { sessions?: SessionRow[] };
    return { kind: "ok", sessions: body.sessions ?? [] };
  } catch {
    return { kind: "error" };
  }
}
