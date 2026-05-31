/**
 * First-run migration UX warning (Phase 23 Group A, [[DD-53]]).
 *
 * Spec/plan context: pre-v0.14.0 the CLI used a machine-wide
 * `{enabled, toggled_at}` state file ("global toggle"). v0.14.0+ replaces
 * it with a per-session map. Migration is privacy-safe: a stale global
 * `enabled: true` is NEVER auto-applied to any session. But that means
 * the user's existing monitoring silently STOPS post-upgrade — they'll
 * wonder why their sessions aren't appearing in `eleanor4devs status`.
 *
 * This helper prints one warning to stderr the first time a CLI command
 * (toggle, hook, status) is invoked AFTER a v1 → v2 migration is
 * detected. A sentinel file (`~/.eleanor4devs/migrated_v2`) ensures we
 * only nag the user once.
 *
 * Failure-tolerant: any disk-write failure on the sentinel is silently
 * swallowed — the worst case is the user sees the warning twice.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { isLegacyV1StateFile } from "./state.js";

const WARNING_TEXT =
  "eleanor4devs: per-session reporting migration — your previous machine-wide " +
  "ON does NOT carry forward. Opt in any session you want monitored via /e4d " +
  "inside that session.";

export interface MigrationWarningOpts {
  /** Path to the state file. Defaults to `~/.eleanor4devs/state.json`. */
  statePath?: string;
  /** Path to the migration sentinel. Defaults to `~/.eleanor4devs/migrated_v2`. */
  sentinelPath?: string;
  /** Stderr sink. Defaults to `console.error`. */
  warn?: (text: string) => void;
}

const DEFAULT_SENTINEL_PATH: string = join(
  homedir(),
  ".eleanor4devs",
  "migrated_v2",
);

/**
 * If a v1 state.json is present on disk AND the migration sentinel does
 * NOT exist, print the migration warning once and create the sentinel.
 * No-op in every other case.
 *
 * Returns true iff the warning was printed (useful for tests).
 */
export function maybePrintMigrationWarning(
  opts: MigrationWarningOpts = {},
): boolean {
  const sentinelPath = opts.sentinelPath ?? DEFAULT_SENTINEL_PATH;
  if (existsSync(sentinelPath)) return false;

  const stateOpts =
    opts.statePath !== undefined ? { statePath: opts.statePath } : {};
  if (!isLegacyV1StateFile(stateOpts)) return false;

  const warn =
    opts.warn ??
    ((text: string) => {
      // eslint-disable-next-line no-console
      console.error(text);
    });
  warn(WARNING_TEXT);

  // Best-effort sentinel write — never throws to the caller.
  try {
    mkdirSync(dirname(sentinelPath), { recursive: true });
    writeFileSync(sentinelPath, new Date().toISOString() + "\n", "utf-8");
  } catch {
    /* swallow — at worst the user sees the warning twice */
  }
  return true;
}
