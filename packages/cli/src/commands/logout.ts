/**
 * `eleanor4devs logout` — revoke + clear the stored credential.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md
 *   § Claude Local Box — Auth & Reporting Pipeline (spec v0.13.0, DD-62).
 *
 * Flow:
 *   1. Read ~/.eleanor4devs/auth.json.
 *   2. If a refresh_token is present, POST /auth/revoke to revoke it
 *      server-side (durable now that the backend persists tokens to
 *      DynamoDB — Phase 22 DD-61).
 *   3. Delete auth.json regardless of the revoke outcome.
 *
 * Idempotent + privacy-monotonic:
 *   - No credential file → "not signed in", no network call, exit 0.
 *   - Backend unreachable / non-2xx → the local credential is STILL
 *     deleted (the user asked to sign out; we honor that locally even if
 *     the server-side revoke couldn't be confirmed), a warning goes to
 *     stderr, exit 0.
 *   - Always exits 0 — logout never fails the user.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";

export interface LogoutOptions {
  /** Path to ~/.eleanor4devs/auth.json. */
  credentialsPath: string;
  /** Backend base URL, e.g. https://api.eleanor4devs.com. */
  backendUrl: string;
  /** Fetch override for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Where user-facing lines go (stdout). */
  log: (text: string) => void;
  /** Where warnings go (stderr). Optional; defaults to `log`. */
  errorLog?: (text: string) => void;
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

export async function runLogout(opts: LogoutOptions): Promise<number> {
  const errorLog = opts.errorLog ?? opts.log;

  if (!existsSync(opts.credentialsPath)) {
    opts.log("Not signed in. (no credential found — nothing to do.)");
    return 0;
  }

  const refreshToken = readRefreshToken(opts.credentialsPath);

  if (refreshToken) {
    const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const base = opts.backendUrl.replace(/\/$/, "");
    try {
      const res = await fetchFn(`${base}/auth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) {
        errorLog(
          `eleanor4devs: server-side revoke returned HTTP ${res.status}; ` +
            "clearing the local credential anyway.",
        );
      }
    } catch (err) {
      errorLog(
        "eleanor4devs: could not reach the backend to revoke the token " +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          "clearing the local credential anyway.",
      );
    }
  }

  // Delete the local credential regardless of revoke outcome.
  rmSync(opts.credentialsPath, { force: true });
  opts.log("Signed out. Local credential removed.");
  return 0;
}
