/**
 * `eleanor4devs on / off / toggle` — Local Reporting Control verbs.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control (acceptance lines 404-406, 408).
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 19, Group B.
 *
 * Per [[DD-43]]: all three verbs are idempotent. `on` when already ON
 * still re-writes `toggled_at`, still appends one audit-log entry, still
 * prints `Eleanor4Devs is now ON.` — the spec promise is "every toggle
 * event is recorded" regardless of whether the new state matches the
 * previous state.
 *
 * Per Phase 19 Group F robustness rule: if the audit-log append throws
 * (EACCES, ENOSPC, locked file, ...), the verb STILL writes the state
 * file and STILL prints the state line on stdout — a locked audit log
 * must never prevent the user from changing their reporting state. The
 * verb emits a stderr warning and returns 0.
 */
import { readReportingState, writeReportingState } from "../state.js";
import { appendAuditEntry } from "../audit.js";

export interface ToggleOpts {
  statePath: string;
  auditLogPath: string;
  /** Clock injection for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Stdout sink. Defaults to no-op when omitted (callers should inject `console.log`). */
  log: (text: string) => void;
  /** Stderr sink for audit-log-failed warnings. Defaults to `console.error`. */
  warn?: (text: string) => void;
}

function clockOf(opts: ToggleOpts): () => Date {
  return opts.now ?? (() => new Date());
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

/**
 * Apply `enabled = newValue` to the state file, append a toggle entry to
 * the audit log, and print the state line. Returns 0 in every case
 * (per Group F robustness rule — even an audit-log failure does not
 * propagate a non-zero exit, because the user's state change WAS
 * persisted).
 */
async function applyToggle(
  newValue: boolean,
  opts: ToggleOpts,
): Promise<number> {
  const now = clockOf(opts);
  const warn = warnOf(opts);
  const ts = now().toISOString();

  // 1) Persist state. This MUST happen before the audit-log append so
  //    that a locked audit log cannot prevent the user from toggling.
  writeReportingState(
    { enabled: newValue, toggledAt: ts },
    { statePath: opts.statePath },
  );

  // 2) Print the state line. Happens before audit so the user sees the
  //    confirmation even if the audit log is locked.
  opts.log(`Eleanor4Devs is now ${newValue ? "ON" : "OFF"}.`);

  // 3) Append the audit entry. Best-effort — surface a stderr warning
  //    on failure but never propagate the error to the exit code.
  try {
    appendAuditEntry(
      { ts, kind: "toggle", state: newValue ? "on" : "off" },
      { auditLogPath: opts.auditLogPath },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`audit log append failed: ${reason}`);
  }
  return 0;
}

/** Set reporting state to ON. Idempotent. */
export async function runOn(opts: ToggleOpts): Promise<number> {
  return applyToggle(true, opts);
}

/** Set reporting state to OFF. Idempotent. */
export async function runOff(opts: ToggleOpts): Promise<number> {
  return applyToggle(false, opts);
}

/**
 * Flip reporting state. Uses the fail-closed reader, so a missing /
 * corrupt state file starts at OFF and flips to ON.
 */
export async function runToggle(opts: ToggleOpts): Promise<number> {
  const current = readReportingState({ statePath: opts.statePath });
  return applyToggle(!current.enabled, opts);
}
