/**
 * Claude Code hook template definitions (Phase 8 — Claude Local Box).
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Provider Boxes:
 *   "Hook lifecycle (per Symphony pattern #4) — `after_create / before_run
 *   / after_run / before_remove` with `timeout_ms` and explicit failure
 *   semantics (`after_create` fatal; `after_run` logged-and-ignored)."
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 8 — "Claude Code hook
 * templates: `after_create / before_run / after_run / before_remove`;
 * written by `eleanor4devs install` to user's `~/.claude/settings.json`".
 *
 * Eleanor uses four logical hook names (matching the Provider Box
 * contract and the backend-side `hook_lifecycle.py` policy). Claude
 * Code's settings.json uses its own event names for the same lifecycle
 * points — this module owns the mapping in one place so the install
 * step and the runtime `eleanor4devs hook <name>` subcommand stay in
 * sync with each other and with the backend policy.
 *
 *   Eleanor logical  →  Claude Code event
 *   --------------      -----------------
 *   after_create     →  SessionStart       (new session created)
 *   before_run       →  UserPromptSubmit   (each turn, before model call)
 *   after_run        →  Stop               (each turn, after model finishes)
 *   before_remove    →  SessionEnd         (session closing)
 *
 * The hook entries shell out to `eleanor4devs hook <logical-name>`. The
 * CLI's `hook` subcommand reads Claude Code's hook context JSON from
 * stdin and forwards it to the backend. Keeping the hook command in a
 * single binary keeps `~/.claude/settings.json` cross-platform — no
 * PowerShell-vs-POSIX escaping landmines.
 */

/** Eleanor-side logical hook names (mirror of `ALL_HOOK_NAMES` in `claude_local_box.py`). */
export const ELEANOR_HOOK_NAMES = [
  "after_create",
  "before_run",
  "after_run",
  "before_remove",
] as const;

export type EleanorHookName = (typeof ELEANOR_HOOK_NAMES)[number];

/** Mapping from Eleanor logical hook → Claude Code's settings.json event key. */
export const ELEANOR_HOOK_EVENT_MAP: Record<EleanorHookName, string> = {
  after_create: "SessionStart",
  before_run: "UserPromptSubmit",
  after_run: "Stop",
  before_remove: "SessionEnd",
};

/**
 * Matcher for our hook entries.
 *
 * GOTCHA (fixed in v0.0.13): the matcher is NOT a free-form identifier.
 * For `SessionStart` and `SessionEnd`, Claude Code treats `matcher` as a
 * SESSION SOURCE filter (`startup|resume|clear|compact` for SessionStart;
 * `clear|logout|prompt_input_exit|other` for SessionEnd) — an arbitrary
 * string like "eleanor4devs" matches NO source, so the hook NEVER FIRES.
 * (For `UserPromptSubmit`/`Stop` the matcher is silently ignored, which is
 * why those fired while SessionStart/SessionEnd silently didn't.)
 *
 * The empty string `""` means "match all" for every event, and is the
 * safe universal value. We therefore identify our own entries by their
 * COMMAND prefix (see `isEleanorHookEntry`), not by the matcher.
 */
export const ELEANOR_HOOK_MATCHER = "";

/** Command prefix that uniquely identifies an eleanor4devs-owned hook entry. */
export const ELEANOR_HOOK_COMMAND_PREFIX = "eleanor4devs hook ";

/** Matcher used by installs ≤ v0.0.12 — detected on re-install so the old, never-firing entries get cleaned up. */
export const LEGACY_ELEANOR_HOOK_MATCHER = "eleanor4devs";

/**
 * Is this hook entry one of ours? Identified by the command prefix (the
 * stable identifier) OR the legacy matcher (so re-installing over a
 * ≤v0.0.12 config removes the broken old entries).
 */
export function isEleanorHookEntry(entry: {
  matcher?: string;
  hooks?: ReadonlyArray<{ command?: string }>;
}): boolean {
  if (entry.matcher === LEGACY_ELEANOR_HOOK_MATCHER) return true;
  return (entry.hooks ?? []).some(
    (h) =>
      typeof h.command === "string" &&
      h.command.startsWith(ELEANOR_HOOK_COMMAND_PREFIX),
  );
}

/** Shape of a single hook entry within `settings.json.hooks[<event>]`.
 * `matcher` is OPTIONAL — Claude Code allows omitting it (match-all), and
 * other agents' pre-existing entries may not set it. */
export interface ClaudeHookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/**
 * Build the canonical hook-entry record keyed by Claude Code event name.
 * Each entry shells out to `eleanor4devs hook <logical-name>` — the CLI
 * binary lives on $PATH after `npm install -g @eleanor4devs/cli` (or via
 * `npx`); the single-line command is shell-safe on Windows + macOS +
 * Linux because it has no shell metacharacters.
 */
export function buildHookEntries(): Record<string, ClaudeHookEntry[]> {
  const out: Record<string, ClaudeHookEntry[]> = {};
  for (const logical of ELEANOR_HOOK_NAMES) {
    const claudeEvent = ELEANOR_HOOK_EVENT_MAP[logical];
    out[claudeEvent] = [
      {
        matcher: ELEANOR_HOOK_MATCHER,
        hooks: [
          {
            type: "command",
            command: `eleanor4devs hook ${logical}`,
          },
        ],
      },
    ];
  }
  return out;
}
