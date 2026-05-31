/**
 * Shared `refresh_token` → `access_token` exchange + credential read.
 *
 * Extracted from `commands/hook.ts` so the new `commands/toggle.ts`
 * (Phase 23, Group A) can re-use the same exchange without duplicating
 * the network/error-handling flow. Both `hook.ts` and `toggle.ts` need
 * a bearer access token to POST to `/hooks/*`; this is the one place
 * the exchange logic lives.
 *
 * Per [[DD-47]]: no caching for MVP — every invocation re-exchanges.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default credential path — `~/.eleanor4devs/auth.json`. */
export const DEFAULT_CREDENTIALS_PATH: string = join(
  homedir(),
  ".eleanor4devs",
  "auth.json",
);

/** Read the stored refresh_token, or null if absent/unreadable/malformed. */
export function readRefreshToken(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as { refresh_token?: unknown };
    return typeof obj.refresh_token === "string" && obj.refresh_token
      ? obj.refresh_token
      : null;
  } catch {
    return null;
  }
}

export type RefreshResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: string };

export interface RefreshOpts {
  backendUrl: string;
  refreshToken: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Exchange a refresh_token for a short-lived access_token via
 * `POST <backend>/auth/refresh`.
 *
 * Failure reasons surfaced to callers:
 *   - `"not_linked"` — backend returned 401 (revoked / unknown refresh_token).
 *   - `"auth_refresh_http_<status>"` — non-401 non-2xx.
 *   - `"auth_refresh_no_token"` — 200 but body had no access_token.
 *   - `"network_error: <msg>"` — fetch threw.
 *
 * Callers translate these into their own UX (the hook prints
 * "not linked" guidance; the toggle command prints a backend-status
 * suffix on the state line).
 */
export async function refreshToAccessToken(
  opts: RefreshOpts,
): Promise<RefreshResult> {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = opts.backendUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetchFn(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: opts.refreshToken }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `network_error: ${msg}` };
  }
  if (res.status === 401) {
    return { ok: false, reason: "not_linked" };
  }
  if (!res.ok) {
    return { ok: false, reason: `auth_refresh_http_${res.status}` };
  }
  let json: { access_token?: unknown };
  try {
    json = (await res.json()) as { access_token?: unknown };
  } catch {
    return { ok: false, reason: "auth_refresh_no_token" };
  }
  if (typeof json.access_token !== "string" || !json.access_token) {
    return { ok: false, reason: "auth_refresh_no_token" };
  }
  return { ok: true, accessToken: json.access_token };
}
