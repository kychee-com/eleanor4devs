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
 * The `matcher` value we use for every eleanor4devs hook entry. Claude
 * Code's matcher field is normally a tool name (Bash, Read, ...) for
 * tool-related hooks, but it's a free-form string and we use a stable
 * identifier here so we can find + replace our own entry on re-install
 * without touching other agents' hooks.
 */
export const ELEANOR_HOOK_MATCHER = "eleanor4devs";

/** Shape of a single hook entry within `settings.json.hooks[<event>]`. */
export interface ClaudeHookEntry {
  matcher: string;
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
