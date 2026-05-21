/**
 * `eleanor4devs auth` — one-time-code linking flow.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Auth +
 * DD-4 (Telegram-only auth for MVP). The CLI:
 *   1. Calls backend `/auth/cli/start` → gets `{code, poll_token}`.
 *   2. Displays the short code to the user with instructions to
 *      forward it to @eleanor4devs_bot.
 *   3. Polls `/auth/cli/poll?token=<poll_token>` until backend
 *      returns `{linked: true, refresh_token}`.
 *   4. Persists the refresh token to ~/.eleanor4devs/auth.json so
 *      subsequent CLI invocations + the SDK's AuthClient can reuse it.
 *
 * TR-006 (Phase 17, spec v0.8.0): `--test-mode <code>` skips step 1's
 * `/auth/cli/start` + the Telegram instructions in step 2, posting to
 * `/test/auth/issue` instead. The remaining poll+persist path is
 * shared. Designed exclusively for the Red Team's `/systemtest`
 * automation — when the backend is in production mode (no
 * `ELEANOR_TEST_MODE=1`), `/test/auth/issue` returns 404 and the CLI
 * surfaces a `test_mode_not_enabled` error so a user can't
 * accidentally use the flag against the production deployment.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class AuthTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthTimeoutError";
  }
}

export class TestModeNotEnabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestModeNotEnabledError";
  }
}

/** Parsed positional+flag arguments from the `eleanor4devs auth ...` argv. */
export type AuthArgs =
  | { mode: "interactive" }
  | { mode: "test"; code: string };

/**
 * Tiny argv parser for the `auth` subcommand. Kept inline (no commander
 * dep) to match the rest of the CLI surface. The caller passes the argv
 * slice AFTER the `auth` literal.
 */
export function parseAuthArgs(rest: string[]): AuthArgs {
  const tmIdx = rest.indexOf("--test-mode");
  if (tmIdx === -1) return { mode: "interactive" };
  const code = rest[tmIdx + 1];
  if (!code || code.startsWith("-")) {
    throw new Error(
      "--test-mode requires a code argument: `eleanor4devs auth --test-mode <code>`",
    );
  }
  return { mode: "test", code };
}

export interface AuthFlowOptions {
  apiBase: string;
  fetch?: typeof globalThis.fetch;
  /** Where to surface user-facing instruction text. */
  display: (text: string) => void;
  /** Where to write `{refresh_token}` on success. */
  credentialsPath: string;
  /** ms between polls. Defaults to 2000. */
  pollIntervalMs?: number;
  /** Max polls before timing out. Defaults to 150 (5 min @ 2s). */
  maxPolls?: number;
  /** Injectable sleep for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * TR-006: when present, the flow skips the interactive Telegram
   * exchange and hits `/test/auth/issue` instead. The `code` value is
   * sent as a hint but the backend is free to ignore it (current
   * test-mode backend treats it as a no-op placeholder; the poll_token
   * the backend returns is what drives credential delivery).
   *
   * If the backend returns 404 from `/test/auth/issue` (production
   * deployment with `ELEANOR_TEST_MODE` unset), this throws
   * `TestModeNotEnabledError` and writes NO credentials.
   */
  testMode?: { code: string };
}

export interface AuthFlowResult {
  refreshToken: string;
}

interface StartResponse {
  code: string;
  poll_token: string;
}

interface IssueResponse {
  code: string;
  poll_token: string;
  expires_at: number;
}

interface PollResponse {
  linked: boolean;
  refresh_token?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function authFlow(options: AuthFlowOptions): Promise<AuthFlowResult> {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const maxPolls = options.maxPolls ?? 150;

  let pollToken: string;
  if (options.testMode) {
    // TR-006 — test-mode bypass. Hit `/test/auth/issue` and skip the
    // Telegram instruction display entirely.
    const issueRes = await fetchFn(`${options.apiBase}/test/auth/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hint: options.testMode.code }),
    });
    if (issueRes.status === 404) {
      throw new TestModeNotEnabledError(
        "test_mode_not_enabled: backend returned 404 for /test/auth/issue. " +
          "The backend must be started with ELEANOR_TEST_MODE=1; the production " +
          "deployment NEVER has this enabled. Use this flag only against an " +
          "isolated test-mode backend.",
      );
    }
    if (!issueRes.ok) {
      throw new Error(
        `auth --test-mode: /test/auth/issue returned HTTP ${issueRes.status}`,
      );
    }
    const issueBody = (await issueRes.json()) as IssueResponse;
    pollToken = issueBody.poll_token;
    options.display(
      `Test-mode auth: backend minted poll_token (code=${issueBody.code}). Driving poll loop...`,
    );
  } else {
    const startRes = await fetchFn(`${options.apiBase}/auth/cli/start`, {
      method: "POST",
    });
    const startBody = (await startRes.json()) as StartResponse;
    pollToken = startBody.poll_token;
    options.display(
      `To link this CLI to your Eleanor account, send this code to @eleanor4devs_bot on Telegram:\n\n    ${startBody.code}\n\n(Waiting for you to confirm in the bot...)`,
    );
  }

  for (let i = 0; i < maxPolls; i += 1) {
    const pollUrl = `${options.apiBase}/auth/cli/poll?token=${encodeURIComponent(pollToken)}`;
    const pollRes = await fetchFn(pollUrl);
    const pollBody = (await pollRes.json()) as PollResponse;
    if (pollBody.linked && typeof pollBody.refresh_token === "string") {
      mkdirSync(dirname(options.credentialsPath), { recursive: true });
      writeFileSync(
        options.credentialsPath,
        JSON.stringify({ refresh_token: pollBody.refresh_token }, null, 2) + "\n",
        "utf-8",
      );
      return { refreshToken: pollBody.refresh_token };
    }
    if (i + 1 < maxPolls) await sleep(pollIntervalMs);
  }
  throw new AuthTimeoutError(
    `Auth flow timed out after ${maxPolls} polls. Re-run \`eleanor4devs auth\` to try again.`,
  );
}
