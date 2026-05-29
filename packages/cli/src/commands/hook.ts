/**
 * `eleanor4devs hook <event>` — Claude Code reporting-hook forwarder.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md
 *   § Claude Local Box — Auth & Reporting Pipeline.
 * Plan: docs/plans/eleanor4devs-plan.md Phase 20 Group C (DD-44/47/48) +
 *   Phase 19 Group D (the Local Reporting Control state-gate).
 *
 * The four hook entries written by `eleanor4devs install` to the user's
 * `~/.claude/settings.json` shell out to this binary. Flow per invocation:
 *
 *   1. State-gate (Phase 19): if reporting is OFF (or the state file is
 *      missing/corrupt → fail-closed OFF), return immediately — NO network,
 *      NO stdout, NO audit write.
 *   2. Credential (Phase 20 DD-47): read `~/.eleanor4devs/auth.json`. If
 *      absent, reporting is ON but the machine isn't linked → surface the
 *      not-linked guidance (on SessionStart) and return. NO /hooks POST.
 *   3. Auth: exchange the refresh_token for a short-lived access_token via
 *      `POST <backend>/auth/refresh` (no caching for MVP). A 401 means the
 *      token was revoked → treat as not-linked.
 *   4. Report: `POST <backend>/hooks/<event>` with `Authorization: Bearer
 *      <access_token>` and body `{hook, payload}`.
 *
 * Failure semantics (Phase 20 DD-44): the local reporting hooks are
 * BEST-EFFORT. NONE are fatal — a reporting/backend/auth failure never
 * blocks or aborts the user's Claude Code session. `result.fatal` is
 * retained (always false) for the caller's exit-code logic. (The
 * Symphony-pattern-#4 `after_create`-fatal semantics apply only to
 * Eleanor's backend *dispatch* lifecycle, not these passive hooks.)
 *
 * Visible feedback (DD-48): on `after_create` (SessionStart, whose stdout
 * IS shown to the user) the caller prints `result.userMessage` — a "✓
 * registered" / "⚠ not registered" / "not linked" line. Other events stay
 * silent.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { appendAuditEntry } from "../audit.js";
import { readReportingState } from "../state.js";
import {
  ELEANOR_HOOK_NAMES,
  type EleanorHookName,
} from "./hook_templates.js";

/** Default credential path — `~/.eleanor4devs/auth.json` (written by `eleanor4devs auth`). */
export const DEFAULT_CREDENTIALS_PATH: string = join(
  homedir(),
  ".eleanor4devs",
  "auth.json",
);

const REGISTERED_MSG = "✓ Eleanor: session registered";
const NOT_LINKED_MSG =
  "Eleanor: this machine isn't linked. Run `eleanor4devs auth` — it prints " +
  "a code; send that code to @eleanor4devs_bot on Telegram to link.";

function notRegisteredMsg(reason: string): string {
  return `⚠ Eleanor: session not registered (${reason})`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface HookArgs {
  hookName: EleanorHookName;
  backendUrl?: string;
}

export function parseHookArgs(rest: string[]): HookArgs {
  const positional = rest[0];
  if (!positional) {
    throw new Error(
      "eleanor4devs hook: missing hook name. Usage: eleanor4devs hook <after_create|before_run|after_run|before_remove>",
    );
  }
  if (!(ELEANOR_HOOK_NAMES as readonly string[]).includes(positional)) {
    throw new Error(
      `eleanor4devs hook: unknown hook ${JSON.stringify(positional)}. Expected one of: ${ELEANOR_HOOK_NAMES.join(", ")}`,
    );
  }
  const hookName = positional as EleanorHookName;

  let backendUrl: string | undefined;
  const idx = rest.indexOf("--backend");
  if (idx !== -1) {
    const value = rest[idx + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(
        "eleanor4devs hook: --backend requires a URL argument, e.g. --backend https://api.eleanor4devs.com",
      );
    }
    backendUrl = value;
  }

  return backendUrl !== undefined
    ? { hookName, backendUrl }
    : { hookName };
}

export interface HookCallResult {
  ok: boolean;
  /**
   * DD-44: local reporting hooks are best-effort, so this is ALWAYS false.
   * Retained so the CLI's exit-code logic stays a no-op (`hook` always
   * exits 0) without a signature change.
   */
  fatal: boolean;
  reason?: string;
  /** Visible line for the caller to print on SessionStart (DD-48). */
  userMessage?: string;
}

export interface RunHookOptions {
  hookName: EleanorHookName;
  backendUrl: string;
  /** Raw stdin contents. May be empty; may have a BOM or trailing CRLF on Windows. */
  stdinJson: string;
  fetch?: typeof globalThis.fetch;
  /** Local Reporting Control state-file path (Phase 19). */
  statePath?: string;
  /** Credential file path (Phase 20). Defaults to DEFAULT_CREDENTIALS_PATH. */
  credentialsPath?: string;
  /** Audit-log path for local failure records (DD-48). */
  auditLogPath?: string;
}

/** Strip a UTF-8 BOM + trailing whitespace from a stdin payload. */
function normalizeStdin(raw: string): string {
  let s = raw;
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1);
  }
  return s.trim();
}

/** Read the stored refresh_token, or null if absent/unreadable/malformed. */
function readRefreshToken(path: string): string | null {
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

function auditFailure(opts: RunHookOptions, reason: string): void {
  // A failure to write the audit log must NEVER break the hook.
  try {
    appendAuditEntry(
      {
        ts: new Date().toISOString(),
        kind: "hook_error",
        hook: opts.hookName,
        reason,
      },
      opts.auditLogPath !== undefined
        ? { auditLogPath: opts.auditLogPath }
        : {},
    );
  } catch {
    /* swallow */
  }
}

/** Build a non-fatal failure result, audit it, and (on SessionStart) surface it. */
function failure(
  opts: RunHookOptions,
  isStart: boolean,
  reason: string,
): HookCallResult {
  auditFailure(opts, reason);
  return {
    ok: false,
    fatal: false,
    reason,
    ...(isStart ? { userMessage: notRegisteredMsg(reason) } : {}),
  };
}

/** Result for the not-linked case — non-fatal, guidance only on SessionStart. */
function notLinked(isStart: boolean): HookCallResult {
  return {
    ok: true,
    fatal: false,
    reason: "not_linked",
    ...(isStart ? { userMessage: NOT_LINKED_MSG } : {}),
  };
}

export async function runHook(opts: RunHookOptions): Promise<HookCallResult> {
  const isStart = opts.hookName === "after_create";

  // (1) State-gate — Phase 19. Must be the first observable behavior:
  // OFF / missing / corrupt all fail-closed to OFF and return silently.
  const state = readReportingState(
    opts.statePath !== undefined ? { statePath: opts.statePath } : {},
  );
  if (!state.enabled) {
    return { ok: true, fatal: false };
  }

  // (2) Credential — Phase 20. ON but unlinked → guide, don't post.
  const credPath = opts.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
  const refreshToken = readRefreshToken(credPath);
  if (refreshToken === null) {
    return notLinked(isStart);
  }

  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = opts.backendUrl.replace(/\/$/, "");

  // (3) Exchange refresh_token → access_token (no caching, DD-47).
  let accessToken: string;
  try {
    const res = await fetchFn(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (res.status === 401) {
      // Revoked / unknown refresh_token → re-link required.
      return notLinked(isStart);
    }
    if (!res.ok) {
      return failure(opts, isStart, `auth_refresh_http_${res.status}`);
    }
    const json = (await res.json()) as { access_token?: unknown };
    if (typeof json.access_token !== "string" || !json.access_token) {
      return failure(opts, isStart, "auth_refresh_no_token");
    }
    accessToken = json.access_token;
  } catch (err) {
    return failure(opts, isStart, `network_error: ${errText(err)}`);
  }

  // Parse the stdin payload (Claude Code's hook-context JSON).
  const normalized = normalizeStdin(opts.stdinJson);
  let payload: unknown = {};
  let parseError: string | undefined;
  if (normalized.length > 0) {
    try {
      payload = JSON.parse(normalized);
    } catch (err) {
      parseError = `invalid_stdin_json: ${errText(err)}`;
    }
  }
  const body =
    parseError !== undefined
      ? JSON.stringify({ hook: opts.hookName, error: parseError })
      : JSON.stringify({ hook: opts.hookName, payload });

  // (4) POST to /hooks/<event> with the bearer access_token.
  let res: Response;
  try {
    res = await fetchFn(`${base}/hooks/${opts.hookName}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body,
    });
  } catch (err) {
    return failure(opts, isStart, `network_error: ${errText(err)}`);
  }
  if (!res.ok) {
    return failure(opts, isStart, `http_${res.status}`);
  }
  if (parseError !== undefined) {
    // The POST landed (so the backend audit log sees the malformed event),
    // but registration could not happen — surface it as a failure.
    return failure(opts, isStart, parseError);
  }

  // Success — parse the typed {registered, reason} the backend returns.
  let registered = true;
  let reason: string | undefined;
  try {
    const json = (await res.json()) as {
      registered?: unknown;
      reason?: unknown;
    };
    registered = json.registered !== false;
    if (typeof json.reason === "string") {
      reason = json.reason;
    }
  } catch {
    /* tolerate a non-JSON 200 — treat as registered */
  }

  if (!registered) {
    const why = reason ?? "not_registered";
    auditFailure(opts, why);
    return {
      ok: true,
      fatal: false,
      reason: why,
      ...(isStart ? { userMessage: notRegisteredMsg(why) } : {}),
    };
  }
  return {
    ok: true,
    fatal: false,
    ...(isStart ? { userMessage: REGISTERED_MSG } : {}),
  };
}

/** Read all of stdin as a UTF-8 string. Returns "" if stdin is closed/empty. */
export async function readStdin(): Promise<string> {
  // eslint-disable-next-line no-undef
  const stdin = process.stdin;
  if (stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
