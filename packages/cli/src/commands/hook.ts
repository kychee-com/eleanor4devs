/**
 * `eleanor4devs hook <event>` — Claude Code reporting-hook forwarder
 * (Phase 23, Group A — per-session gate + disabled-cache local half).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md
 *   § Local Reporting Control (v0.14.0 — per-session, lines 461-465)
 *   § Auth & Reporting Pipeline (lines 143-148, 397).
 * Plan: docs/plans/eleanor4devs-plan.md Phase 23, Group A.
 *
 * The four hook entries written by `eleanor4devs install` to the user's
 * `~/.claude/settings.json` shell out to this binary on every lifecycle
 * event. Flow per invocation:
 *
 *   1. Parse `session_id` from stdin payload. Missing → audit + exit 0
 *      (the four lifecycle hooks are best-effort; spec line 397).
 *
 *   2. PER-SESSION GATE (Phase 23, [[DD-53]]). Call
 *      readSessionReporting(session_id). NOT opted in → exit 0 immediately,
 *      with NO network call, NO stdout, NO audit write. This is the
 *      interference fix: a session the user never opted in is observable
 *      from the outside as "no traffic at all".
 *
 *   3. CREDENTIAL READ (Phase 20). Opted in but no credential → guidance
 *      ONLY on SessionStart, never on other events; NO /hooks POST.
 *
 *   4. AUTH EXCHANGE. refresh_token → access_token. 401 → not-linked.
 *
 *   5. POST /hooks/<event> with `Authorization: Bearer <access_token>`.
 *
 *   6. RESPONSE HANDLING. If the backend returns
 *      `{registered:false, reason:"disabled"}`, locally cache that session
 *      as disabled — the next hook for the same session_id no-ops without
 *      a round-trip. The disable-cache write is wrapped in try/catch —
 *      a disk failure NEVER aborts the hook (spec line 397 non-fatal).
 *
 * Visible feedback (DD-48):
 *   - SessionStart (after_create) on a registered opted-in session: ✓ message.
 *   - SessionStart on an opted-in not-linked session: not-linked guidance.
 *   - SessionStart on a NOT-opted-in session: SILENT — merely starting a
 *     session never surfaces the not-linked prompt (spec line 143-144). The
 *     user opts in with /e4d to trigger that prompt.
 *
 * Failure semantics (DD-44): all four reporting hooks are best-effort.
 * NONE are fatal. `result.fatal` is retained (always false) for the CLI's
 * exit-code logic.
 */
import { appendAuditEntry } from "../audit.js";
import {
  readSessionReporting,
  setSessionReporting,
} from "../state.js";
import {
  ELEANOR_HOOK_NAMES,
  type EleanorHookName,
} from "./hook_templates.js";
import {
  DEFAULT_CREDENTIALS_PATH,
  readRefreshToken,
  refreshToAccessToken,
} from "../auth_refresh.js";

// Re-export so cli.ts (and any external caller) keeps a stable import path.
export { DEFAULT_CREDENTIALS_PATH };

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
  /** Per-session reporting state file path. */
  statePath?: string;
  /** Credential file path. Defaults to DEFAULT_CREDENTIALS_PATH. */
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

/** Parse session_id out of the stdin payload. Returns null on any failure. */
function extractSessionId(stdinJson: string): string | null {
  const normalized = normalizeStdin(stdinJson);
  if (normalized.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const sid = (parsed as Record<string, unknown>).session_id;
  if (typeof sid !== "string" || sid.length === 0) return null;
  return sid;
}

export async function runHook(opts: RunHookOptions): Promise<HookCallResult> {
  const isStart = opts.hookName === "after_create";

  // (1) Extract session_id from stdin. Missing → log + exit ok.
  const sessionId = extractSessionId(opts.stdinJson);
  if (sessionId === null) {
    auditFailure(opts, "missing_session_id");
    return { ok: true, fatal: false, reason: "missing_session_id" };
  }

  // (2) Per-session gate — Phase 23. NOT opted-in → silent no-op.
  // Spec line 143-144: merely starting a session never surfaces the
  // not-linked prompt — no userMessage even on SessionStart.
  const state = readSessionReporting(
    sessionId,
    opts.statePath !== undefined ? { statePath: opts.statePath } : {},
  );
  if (!state.enabled) {
    return { ok: true, fatal: false };
  }

  // (3) Credential — opted-in but no credential → guide (only on SessionStart).
  const credPath = opts.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
  const refreshToken = readRefreshToken(credPath);
  if (refreshToken === null) {
    return notLinked(isStart);
  }

  // (4) Exchange refresh_token → access_token (no caching, DD-47).
  const auth = await refreshToAccessToken({
    backendUrl: opts.backendUrl,
    refreshToken,
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
  if (!auth.ok) {
    if (auth.reason === "not_linked") {
      return notLinked(isStart);
    }
    return failure(opts, isStart, auth.reason);
  }

  // Parse the stdin payload to forward verbatim (Claude Code's hook context).
  const normalized = normalizeStdin(opts.stdinJson);
  let payload: unknown = {};
  let parseError: string | undefined;
  try {
    payload = JSON.parse(normalized);
  } catch (err) {
    parseError = `invalid_stdin_json: ${errText(err)}`;
  }
  const body =
    parseError !== undefined
      ? JSON.stringify({ hook: opts.hookName, error: parseError })
      : JSON.stringify({ hook: opts.hookName, payload });

  // (5) POST /hooks/<event>.
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = opts.backendUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetchFn(`${base}/hooks/${opts.hookName}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.accessToken}`,
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
    return failure(opts, isStart, parseError);
  }

  // (6) Parse the typed {registered, reason} response.
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
    // [[DD-60]] local half: backend says this session is disabled → flip
    // the local gate so the next hook for the same session no-ops without
    // a network round-trip. Wrap in try/catch — disk write failure must
    // NEVER abort the hook (spec line 397).
    if (why === "disabled") {
      try {
        setSessionReporting(
          sessionId,
          false,
          opts.statePath !== undefined ? { statePath: opts.statePath } : {},
        );
      } catch (err) {
        auditFailure(opts, `disabled_cache_write_failed: ${errText(err)}`);
      }
    }
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
