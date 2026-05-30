/**
 * `eleanor4devs status` — current reporting state + diagnostics.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI + § Local
 *   Reporting Control line 409 — "`status` first output line shows
 *   current reporting state and last-toggle timestamp".
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 19, Group E.
 *
 * Phase 19 owns ONLY the first line. The three legal first-line
 * patterns are:
 *
 *   - `Eleanor4Devs reporting: ON (since 2026-05-28T15:42:00Z)`
 *     (state.enabled === true && toggledAt non-null)
 *
 *   - `Eleanor4Devs reporting: OFF (since 2026-05-28T15:42:00Z)`
 *     (state.enabled === false && toggledAt non-null)
 *
 *   - `Eleanor4Devs reporting: OFF (no toggle recorded)`
 *     (toggledAt is null — fresh install with no toggles, OR fail-closed
 *     read of a missing / corrupt file)
 *
 * Lines 2+ (thread counts, focus cap, last sync time, etc.) are
 * reserved for later phases. Keep `runStatus` minimal until those land.
 */
import { readFileSync } from "node:fs";

import { readReportingState } from "../state.js";
import { renderSessionsTable, type SessionRow } from "./sessions_table.js";

export interface RunStatusOpts {
  statePath: string;
  log: (text: string) => void;
  /** Backend base URL. When set with credentialsPath, status also shows the sessions table. */
  backendUrl?: string;
  /** Path to ~/.eleanor4devs/auth.json. */
  credentialsPath?: string;
  fetch?: typeof globalThis.fetch;
  /** Injectable clock for the relative-time column (tests). */
  nowMs?: number;
}

const AUTH_HINT = "  (run `eleanor4devs auth` to see your sessions)";
const LOAD_ERR = "  (couldn't load sessions right now)";

export async function runStatus(opts: RunStatusOpts): Promise<number> {
  const state = readReportingState({ statePath: opts.statePath });
  opts.log(formatFirstLine(state.enabled, state.toggledAt));
  // Phase 21: recent-sessions table — best-effort, NEVER throws/hangs.
  if (opts.backendUrl && opts.credentialsPath) {
    opts.log(await sessionsBlock(opts));
  }
  return 0;
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

/** Fetch + render the sessions table; returns a hint/error note on any failure. */
async function sessionsBlock(opts: RunStatusOpts): Promise<string> {
  const refreshToken = readRefreshToken(opts.credentialsPath!);
  if (refreshToken === null) return AUTH_HINT;
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = opts.backendUrl!.replace(/\/$/, "");
  try {
    const refreshRes = await fetchFn(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (refreshRes.status === 401) return AUTH_HINT;
    if (!refreshRes.ok) return LOAD_ERR;
    const tok = (await refreshRes.json()) as { access_token?: unknown };
    if (typeof tok.access_token !== "string" || !tok.access_token) {
      return LOAD_ERR;
    }
    const res = await fetchFn(`${base}/sessions?limit=5`, {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    if (!res.ok) return LOAD_ERR;
    const body = (await res.json()) as { sessions?: SessionRow[] };
    return renderSessionsTable(body.sessions ?? [], opts.nowMs);
  } catch {
    return LOAD_ERR;
  }
}

export function formatFirstLine(
  enabled: boolean,
  toggledAt: string | null,
): string {
  const onOff = enabled ? "ON" : "OFF";
  if (toggledAt === null) {
    return `Eleanor4Devs reporting: ${onOff} (no toggle recorded)`;
  }
  return `Eleanor4Devs reporting: ${onOff} (since ${toggledAt})`;
}
