/**
 * JSONL audit-log writer shared by every CLI command that needs to leave
 * a local forensic trail.
 *
 * Format pinned by [[DD-13]] (one JSON object per line, newline-delimited).
 * Local file at `~/.eleanor4devs/audit.log`.
 *
 * Currently used by:
 *   - packages/cli/src/commands/toggle.ts (Phase 19 — toggle events,
 *     `{ts, kind: "toggle", state: "on"|"off"}`).
 *
 * Future callers (hook intake failures surfaced locally, auth events,
 * etc.) should reuse this helper rather than reimplementing the
 * append+mkdir+newline pattern.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Default path: `~/.eleanor4devs/audit.log` per [[DD-13]]. */
export const DEFAULT_AUDIT_LOG_PATH: string = join(
  homedir(),
  ".eleanor4devs",
  "audit.log",
);

export interface AuditAppendOpts {
  /** Override the on-disk path. Defaults to DEFAULT_AUDIT_LOG_PATH. */
  auditLogPath?: string;
}

/**
 * Append one JSONL entry to the audit log.
 *
 * Auto-creates the parent directory if missing. The entry is serialized
 * via `JSON.stringify` with no options (so the caller's field ordering
 * is preserved) and a single trailing `\n`.
 *
 * Re-raises any underlying I/O error — callers that must not fail (e.g.
 * `eleanor4devs toggle` per [[DD-43]] + Phase 19 Group F's robustness
 * rule) are expected to wrap this call in a try/catch and degrade
 * gracefully.
 */
export function appendAuditEntry(
  entry: Record<string, unknown>,
  opts: AuditAppendOpts = {},
): void {
  const path = opts.auditLogPath ?? DEFAULT_AUDIT_LOG_PATH;
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}
