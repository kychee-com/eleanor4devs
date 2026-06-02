/**
 * Lazy hook registration — register / de-register the four Claude Code
 * lifecycle hooks in `~/.claude/settings.json` (Phase 26, [[DD-69]]).
 *
 * Spec v0.15.0 § Local Reporting Control + Auth & Reporting Pipeline:
 *   `eleanor4devs install` registers NO hooks; the first `/e4d` on registers
 *   the four lifecycle hooks; the last opt-out (or the 72h local staleness
 *   prune) de-registers them. A never-opted-in machine carries zero
 *   eleanor4devs hook entries and spawns nothing.
 *
 * This module owns the shared settings.json mutator that backs both the
 * toggle (register/deregister) and the install prune. Two operations:
 *   - `registerHooks(settingsPath)`   — idempotent: the four entries present,
 *     no duplicates, foreign-agent entries preserved.
 *   - `deregisterHooks(settingsPath)` — remove every eleanor4devs entry and
 *     delete any event array thereby emptied; no-op when none present.
 *
 * Both reuse `buildHookEntries` / `isEleanorHookEntry` from `hook_templates.ts`
 * and share `stripEleanorHookEntries` (also used by install's prune).
 *
 * Writes are SYMLINK-AWARE ([[DD-64]]): `~/.claude/settings.json` may be a
 * symlink into a dotfile repo. A naive temp+rename over the symlink would
 * REPLACE the symlink with a regular file (destroying the dotfile setup), so
 * we resolve the symlink to its real target first and temp+rename THERE —
 * writing through the link, never over it.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  buildHookEntries,
  isEleanorHookEntry,
  type ClaudeHookEntry,
} from "./hook_templates.js";

interface SettingsShape {
  hooks?: Record<string, ClaudeHookEntry[]>;
  [key: string]: unknown;
}

/** Read + parse settings.json; `{}` on absent / unreadable / non-object. */
function readSettings(path: string): SettingsShape {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as SettingsShape;
    }
  } catch {
    /* fall through to {} */
  }
  return {};
}

/**
 * Resolve a path THROUGH any symlinks to its real file location ([[DD-64]]).
 * `realpathSync` throws when the leaf doesn't exist yet, so fall back to
 * resolving the parent directory and re-appending the basename. If neither
 * resolves (parent missing too), return the path unchanged — the caller's
 * `mkdirSync(recursive)` will create it.
 */
export function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/** Atomic, symlink-aware JSON write: resolve the real path, then temp+rename there. */
function writeSettingsAtomic(path: string, settings: SettingsShape): void {
  const real = resolveRealPath(path);
  mkdirSync(dirname(real), { recursive: true });
  const tmp = `${real}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  renameSync(tmp, real);
}

/**
 * Remove every eleanor4devs hook entry from a hooks map and delete any event
 * array thereby emptied. Pure — returns a new map; foreign entries preserved.
 * Shared by `deregisterHooks` and install's prune so there is ONE implementation
 * of "strip e4d entries + clean emptied arrays" ([[DD-69]]).
 */
export function stripEleanorHookEntries(
  hooks: Record<string, ClaudeHookEntry[]>,
): Record<string, ClaudeHookEntry[]> {
  const out: Record<string, ClaudeHookEntry[]> = {};
  for (const [event, list] of Object.entries(hooks)) {
    const kept = list.filter((e) => !isEleanorHookEntry(e));
    if (kept.length > 0) {
      out[event] = kept;
    }
    // else: drop the now-empty event key entirely.
  }
  return out;
}

/** True iff `hooks` holds at least one eleanor4devs entry in any event. */
function hasEleanorEntries(hooks: Record<string, ClaudeHookEntry[]>): boolean {
  return Object.values(hooks).some((list) =>
    list.some((e) => isEleanorHookEntry(e)),
  );
}

/**
 * Idempotently register the four lifecycle hooks in `settingsPath`.
 * Strips any existing eleanor4devs entries first (so re-running never
 * duplicates), preserves foreign-agent entries and all non-hook settings
 * keys, then appends the canonical four. Symlink-aware atomic write.
 */
export function registerHooks(settingsPath: string): void {
  const settings = readSettings(settingsPath);
  const merged = stripEleanorHookEntries(settings.hooks ?? {});
  for (const [event, list] of Object.entries(buildHookEntries())) {
    merged[event] = [...(merged[event] ?? []), ...list];
  }
  writeSettingsAtomic(settingsPath, { ...settings, hooks: merged });
}

/**
 * Remove all eleanor4devs hook entries (and any event key they emptied) from
 * `settingsPath`. No-op — and crucially, NO rewrite — when the file is absent
 * or holds no eleanor4devs entry, so it never touches an unrelated settings
 * file or creates one. Foreign entries and non-hook keys are preserved.
 * Symlink-aware atomic write. When the `hooks` map empties entirely, the
 * `hooks` key is removed so the file returns to its pre-opt-in shape.
 */
export function deregisterHooks(settingsPath: string): void {
  if (!existsSync(settingsPath)) return;
  const settings = readSettings(settingsPath);
  const hooks = settings.hooks;
  if (hooks === undefined || !hasEleanorEntries(hooks)) return;

  const stripped = stripEleanorHookEntries(hooks);
  const next: SettingsShape = { ...settings };
  if (Object.keys(stripped).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = stripped;
  }
  writeSettingsAtomic(settingsPath, next);
}
