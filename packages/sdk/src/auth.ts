/**
 * AuthClient — short-lived scoped OAuth tokens for the SDK.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Auth.
 * The MCP server itself cannot do outbound HTTP (credential
 * isolation source lint), so the auth flow lives on the SDK. The
 * CLI's `auth` command drives this on behalf of the user during
 * install; the SDK consumer holds the refresh token and exchanges
 * it for short-lived access tokens.
 */

export interface AuthClientOptions {
  apiBase: string;
  refreshToken: string;
  /** Inject for tests; defaults to globalThis.fetch in production. */
  fetch?: typeof globalThis.fetch;
  /** OAuth scope (whitespace-delimited per RFC 6749). */
  scope?: string;
  /**
   * Buffer in milliseconds before the cached token's expiry at which
   * we treat it as stale and refresh. Defaults to 30s — leaves room
   * for clock skew + the round-trip latency back to the backend.
   */
  refreshSkewMs?: number;
  /** Injectable clock for deterministic cache-TTL tests. */
  now?: () => number;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class AuthClient {
  private readonly apiBase: string;
  private readonly refreshToken: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly scope: string | undefined;
  private readonly refreshSkewMs: number;
  private readonly now: () => number;
  private cached: CachedToken | null = null;

  constructor(options: AuthClientOptions) {
    this.apiBase = options.apiBase;
    this.refreshToken = options.refreshToken;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.scope = options.scope;
    this.refreshSkewMs = options.refreshSkewMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  async getAccessToken(): Promise<string> {
    if (
      this.cached !== null &&
      this.now() < this.cached.expiresAt - this.refreshSkewMs
    ) {
      return this.cached.value;
    }
    const body: Record<string, unknown> = {
      refresh_token: this.refreshToken,
    };
    if (this.scope !== undefined) body.scope = this.scope;
    const response = await this.fetchFn(`${this.apiBase}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.cached = {
      value: payload.access_token,
      expiresAt: this.now() + payload.expires_in * 1000,
    };
    return payload.access_token;
  }

  async revoke(): Promise<void> {
    await this.fetchFn(`${this.apiBase}/auth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: this.refreshToken }),
    });
    this.cached = null;
  }
}
