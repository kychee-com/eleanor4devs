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
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class AuthTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthTimeoutError";
  }
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
}

export interface AuthFlowResult {
  refreshToken: string;
}

interface StartResponse {
  code: string;
  poll_token: string;
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

  const startRes = await fetchFn(`${options.apiBase}/auth/cli/start`, {
    method: "POST",
  });
  const startBody = (await startRes.json()) as StartResponse;
  options.display(
    `To link this CLI to your Eleanor account, send this code to @eleanor4devs_bot on Telegram:\n\n    ${startBody.code}\n\n(Waiting for you to confirm in the bot...)`,
  );

  for (let i = 0; i < maxPolls; i += 1) {
    const pollUrl = `${options.apiBase}/auth/cli/poll?token=${encodeURIComponent(startBody.poll_token)}`;
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
