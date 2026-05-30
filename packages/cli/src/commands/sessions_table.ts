/**
 * Recent-sessions table renderer for `eleanor4devs status` (Phase 21).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI (status table).
 *
 * Pure, dependency-free: column widths are computed from the data and the
 * cells are space-padded. Kept separate from the fetch/IO so it's trivially
 * testable.
 */

export interface SessionRow {
  thread_id: string;
  display_name: string;
  state: string;
  repo: string;
  last_event_at: string;
}

/** Human-relative age of an ISO-8601 timestamp ("2m ago" / "3h ago" / …). */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const COLUMNS = ["SESSION", "STATE", "REPO", "LAST ACTIVE"] as const;

/** Render an aligned text table of sessions, or a friendly note when empty. */
export function renderSessionsTable(
  sessions: SessionRow[],
  nowMs: number = Date.now(),
): string {
  if (sessions.length === 0) {
    return "  (no sessions yet) — run a `claude` session with reporting ON";
  }
  const rows = sessions.map((s) => [
    s.display_name,
    s.state,
    s.repo,
    relativeTime(s.last_event_at, nowMs),
  ]);
  const widths = COLUMNS.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => r[i]!.length)),
  );
  const fmt = (cells: readonly string[]): string =>
    ("  " + cells.map((c, i) => c.padEnd(widths[i]!)).join("  ")).trimEnd();
  const separator = "  " + widths.map((w) => "-".repeat(w)).join("  ");
  return [fmt(COLUMNS), separator, ...rows.map(fmt)].join("\n");
}
