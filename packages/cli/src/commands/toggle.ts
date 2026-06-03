/**
 * `eleanor4devs toggle --session <id>` — per-session reporting opt-in/opt-out.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control (v0.14.0 — per-session, acceptance lines 461-465).
 * Plan: docs/plans/eleanor4devs-plan.md Phase 23, Group A
 *   ([[DD-54]], [[DD-55]]).
 *
 * Replaces the pre-v0.14.0 `on`/`off`/`toggle` verbs (which targeted a
 * machine-wide state) with a single `toggle --session <id>` that flips a
 * single session's record. The global verbs are gone — there is no
 * machine-wide reporting state in v0.14.0.
 *
 * Flow per invocation:
 *
 *   1. Validate the `--session` value isn't an unsubstituted Claude Code
 *      template (`${CLAUDE_SESSION_ID}` literal). If it is, fail loud —
 *      better to break early than to flip a record keyed by literal
 *      template text that would silently persist.
 *
 *   2. Read the current per-session reporting state. The new value is
 *      its negation (toggle semantics).
 *
 *   3. Persist locally FIRST via `setSessionReporting`. This makes the
 *      user's intent durable BEFORE any network round-trip — a slow or
 *      failed backend can never block the local flip.
 *
 *   4. Best-effort backend POST: `/hooks/opt-in` (on opt-IN) or
 *      `/hooks/disable` (on opt-OUT). Both endpoints are NEW in Phase 23
 *      Group B and may 404 during the Ship 1 window — that's acceptable;
 *      the local state was already persisted in step 3.
 *
 *   5. Print the state line: `Eleanor4Devs is now ON/OFF for this
 *      session.` plus a backend-status suffix (✓/⚠/not-linked guidance).
 *
 *   6. Append one audit-log entry: `{ts, kind: "toggle", session_id,
 *      state}`. Even an idempotent re-affirmation appends per [[DD-43]].
 *      An audit-log failure NEVER propagates non-zero — the state change
 *      already happened (Group F robustness rule).
 *
 * Privacy-monotonic invariant: opt-OUT always flips the local gate,
 * regardless of network outcome. The CLI is the source of truth for the
 * user's local opt-in choice; the backend mirrors it.
 */
import {
  countEnabledSessions,
  pruneStaleSessions,
  readSessionReporting,
  setSessionReporting,
} from "../state.js";
import { appendAuditEntry } from "../audit.js";
import { deregisterHooks, registerHooks } from "./hook_registry.js";
import {
  readRefreshToken,
  refreshToAccessToken,
} from "../auth_refresh.js";

const SUBST_LITERAL = "${CLAUDE_SESSION_ID}";

export interface ToggleOpts {
  /** The Claude Code session id (from `${CLAUDE_SESSION_ID}` in `/e4d`). */
  sessionId: string;
  /** Path to ~/.eleanor4devs/state.json. */
  statePath: string;
  /**
   * Path to `~/.claude/settings.json` — where the four lifecycle hooks are
   * registered on opt-IN and de-registered on the last opt-OUT (Phase 26,
   * [[DD-69]]). Optional only for tests that don't exercise hook registration;
   * the CLI entrypoint always injects the real path. When absent, the local
   * gate + audit still happen but no hooks are (de)registered.
   */
  settingsPath?: string;
  /** Path to ~/.eleanor4devs/audit.log. */
  auditLogPath: string;
  /** Path to ~/.eleanor4devs/auth.json (the stored refresh_token). */
  credentialsPath: string;
  /** Backend base URL — e.g. `https://api.eleanor4devs.com`. */
  backendUrl: string;
  /** Clock injection for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Stdout sink. Callers should inject `console.log`. */
  log: (text: string) => void;
  /** Stderr sink for warnings. Defaults to `console.error`. */
  warn?: (text: string) => void;
  /** Fetch override for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Override the cwd / workspace_root reported on opt-IN. Tests inject;
   * the CLI's real entrypoint passes `process.cwd()`.
   */
  cwd?: string;
}

function warnOf(opts: ToggleOpts): (text: string) => void {
  return (
    opts.warn ??
    ((text: string) => {
      // eslint-disable-next-line no-console
      console.error(text);
    })
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUnsubstitutedTemplate(value: string): boolean {
  return value === SUBST_LITERAL || value.startsWith("${");
}

/**
 * Reconcile the four lifecycle hooks in settings.json with the local opt-in
 * set after a toggle ([[DD-69]]/[[DD-70]]). Best-effort + NON-FATAL: every
 * settings/state mutation here is wrapped so a failure only warns — the local
 * gate flip and the audit line (the privacy-relevant facts) already happened /
 * still happen regardless (privacy-monotonic).
 *
 *   - Opportunistically prune stale sibling records at the toggle write path,
 *     so an opt-in that was abandoned without `/e4d` off can't keep the hooks
 *     registered forever ([[DD-70]]).
 *   - opt-IN  → `registerHooks` (idempotent — no duplicate if already present).
 *   - opt-OUT → `deregisterHooks` ONLY when no enabled record remains (counted
 *     AFTER the prune), returning the machine to zero eleanor4devs hooks.
 *
 * No-op for `settingsPath === undefined` (tests that don't exercise hook
 * registration). The prune still runs (it touches state.json, not settings).
 */
function syncHookRegistration(
  opts: ToggleOpts,
  newValue: boolean,
  now: Date,
): void {
  const warn = warnOf(opts);
  // Prune is independent of the register/deregister decision; isolate its
  // failure so a prune error can't stop the hooks from (de)registering.
  try {
    pruneStaleSessions(now, { statePath: opts.statePath });
  } catch (err) {
    warn(`eleanor4devs toggle: stale-prune skipped (${errText(err)})`);
  }
  const settingsPath = opts.settingsPath;
  if (settingsPath === undefined) {
    return;
  }
  try {
    if (newValue) {
      registerHooks(settingsPath);
    } else if (countEnabledSessions({ statePath: opts.statePath }) === 0) {
      deregisterHooks(settingsPath);
    }
  } catch (err) {
    warn(
      `eleanor4devs toggle: hook ${newValue ? "registration" : "de-registration"} ` +
        `skipped (settings.json write failed: ${errText(err)})`,
    );
  }
}

interface BackendResult {
  suffix: string;
}

/** Best-effort backend POST. Local state has already flipped — this never throws. */
async function postBackend(
  opts: ToggleOpts,
  newValue: boolean,
): Promise<BackendResult> {
  const refreshToken = readRefreshToken(opts.credentialsPath);
  if (refreshToken === null) {
    return {
      suffix: newValue
        ? " (not linked — run `eleanor4devs auth`)"
        : "",
    };
  }
  const fetchOpts = opts.fetch !== undefined ? { fetch: opts.fetch } : {};
  const auth = await refreshToAccessToken({
    backendUrl: opts.backendUrl,
    refreshToken,
    ...fetchOpts,
  });
  if (!auth.ok) {
    if (auth.reason === "not_linked") {
      return {
        suffix: newValue
          ? " (not linked — run `eleanor4devs auth`)"
          : "",
      };
    }
    return { suffix: ` (backend ${auth.reason})` };
  }
  const endpoint = newValue ? "opt-in" : "disable";
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = opts.backendUrl.replace(/\/$/, "");
  const cwd = opts.cwd ?? process.cwd();
  const body = newValue
    ? JSON.stringify({
        session_id: opts.sessionId,
        cwd,
        workspace_root: cwd,
      })
    : JSON.stringify({ session_id: opts.sessionId });
  let res: Response;
  try {
    res = await fetchFn(`${base}/hooks/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.accessToken}`,
      },
      body,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { suffix: ` (network error: ${msg})` };
  }
  if (res.status === 404) {
    // Ship 1 window: backend endpoint isn't deployed yet. Acceptable.
    return { suffix: " (backend endpoint pending — local gate flipped)" };
  }
  if (!res.ok) {
    return { suffix: ` (backend ${endpoint} failed: http_${res.status})` };
  }
  return { suffix: newValue ? " (✓ registered)" : "" };
}

/**
 * Flip the per-session reporting state for `opts.sessionId`. See module
 * docstring for the full flow.
 */
export async function runToggle(opts: ToggleOpts): Promise<number> {
  // (1) Literal-template validator — fail loud on unsubstituted ${...}.
  if (isUnsubstitutedTemplate(opts.sessionId)) {
    warnOf(opts)(
      `eleanor4devs toggle: --session value looks like an unsubstituted ` +
        `Claude Code template (${opts.sessionId}). Substitution failed in ` +
        `the slash-command body — re-install with the latest CLI, or invoke ` +
        `from inside an active Claude Code session.`,
    );
    return 1;
  }

  // (2) Read current state and compute the new value.
  const nowFn = opts.now ?? (() => new Date());
  const nowDate = nowFn();
  const ts = nowDate.toISOString();
  const current = readSessionReporting(opts.sessionId, {
    statePath: opts.statePath,
  });
  const newValue = !current.enabled;

  // (3) Persist locally FIRST. The user's intent always wins; network
  //     POST is best-effort.
  setSessionReporting(opts.sessionId, newValue, {
    statePath: opts.statePath,
    now: nowFn,
  });

  // (3.5) Reconcile the lazy hook registration with the new local opt-in set
  //       ([[DD-69]]/[[DD-70]]). Non-fatal: the local gate already flipped in
  //       (3) and the audit line still appends in (6), no matter what happens
  //       to settings.json here (privacy-monotonic).
  syncHookRegistration(opts, newValue, nowDate);

  // (4) Best-effort backend POST.
  const backend = await postBackend(opts, newValue);

  // (5) Print the state line.
  opts.log(
    `Eleanor4Devs is now ${newValue ? "ON" : "OFF"} for this session.${backend.suffix}`,
  );

  // (6) Audit-log entry — never breaks the exit code.
  try {
    appendAuditEntry(
      {
        ts,
        kind: "toggle",
        session_id: opts.sessionId,
        state: newValue ? "on" : "off",
      },
      { auditLogPath: opts.auditLogPath },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnOf(opts)(`audit log append failed: ${reason}`);
  }
  return 0;
}
