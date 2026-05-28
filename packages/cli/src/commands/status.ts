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
import { readReportingState } from "../state.js";

export interface RunStatusOpts {
  statePath: string;
  log: (text: string) => void;
}

export async function runStatus(opts: RunStatusOpts): Promise<number> {
  const state = readReportingState({ statePath: opts.statePath });
  opts.log(formatFirstLine(state.enabled, state.toggledAt));
  return 0;
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
