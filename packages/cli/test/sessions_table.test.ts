/**
 * Phase 21 Group B — recent-sessions table renderer (pure functions).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI (status table).
 */
import { describe, expect, it } from "vitest";

import {
  relativeTime,
  renderSessionsTable,
  type SessionRow,
} from "../src/commands/sessions_table.js";

const NOW = Date.parse("2026-05-29T12:00:00.000Z");

function at(deltaMs: number): string {
  return new Date(NOW - deltaMs).toISOString();
}

describe("relativeTime", () => {
  it("buckets seconds/minutes/hours/days", () => {
    expect(relativeTime(at(5_000), NOW)).toBe("just now");
    expect(relativeTime(at(2 * 60_000), NOW)).toBe("2m ago");
    expect(relativeTime(at(3 * 3_600_000), NOW)).toBe("3h ago");
    expect(relativeTime(at(5 * 86_400_000), NOW)).toBe("5d ago");
  });
  it("returns '?' for an unparseable timestamp", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("?");
  });
});

describe("renderSessionsTable", () => {
  it("renders an empty list as a friendly note", () => {
    expect(renderSessionsTable([], NOW)).toContain("(no sessions yet)");
  });

  it("shows a header and every session's fields", () => {
    const sessions: SessionRow[] = [
      {
        thread_id: "t1",
        display_name: "auth pipeline",
        state: "active",
        repo: "eleanor4devs",
        last_event_at: at(2 * 60_000),
      },
    ];
    const out = renderSessionsTable(sessions, NOW);
    for (const col of ["SESSION", "STATE", "REPO", "LAST ACTIVE"]) {
      expect(out).toContain(col);
    }
    expect(out).toContain("auth pipeline");
    expect(out).toContain("active");
    expect(out).toContain("eleanor4devs");
    expect(out).toContain("2m ago");
  });

  it("aligns columns regardless of name length", () => {
    const sessions: SessionRow[] = [
      { thread_id: "t1", display_name: "a", state: "active", repo: "r1", last_event_at: at(60_000) },
      {
        thread_id: "t2",
        display_name: "bbbbbbbbbbbb",
        state: "paused",
        repo: "r2",
        last_event_at: at(3_600_000),
      },
    ];
    const lines = renderSessionsTable(sessions, NOW).split("\n");
    const dataRows = lines.filter((l) => l.includes("active") || l.includes("paused"));
    expect(dataRows).toHaveLength(2);
    // The state column starts at the same character position in both rows.
    expect(dataRows[0]!.indexOf("active")).toBe(dataRows[1]!.indexOf("paused"));
  });
});
