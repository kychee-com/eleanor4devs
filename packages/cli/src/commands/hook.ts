/**
 * `eleanor4devs hook <event>` — Claude Code hook intake forwarder.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Provider Boxes.
 * Plan: docs/plans/eleanor4devs-plan.md Phase 8 — hook templates +
 *   hook lifecycle enforcement.
 *
 * Why a CLI subcommand instead of a shell snippet:
 *   The four hook entries written by `eleanor4devs install` to the
 *   user's `~/.claude/settings.json` shell out to this binary. Keeping
 *   the hook commands in a single CLI subcommand keeps the settings.json
 *   cross-platform — no PowerShell-vs-POSIX escaping landmines — and
 *   keeps the actual POST + payload-shaping logic in one tested place.
 *
 * Wire protocol:
 *   - stdin: Claude Code's hook context JSON (Claude writes a JSON
 *     object describing the event to the hook command's stdin).
 *   - argv: `eleanor4devs hook <logical-name> [--backend <url>]`.
 *   - HTTP: POST to `<backend>/hooks/<logical-name>` with body
 *     `{ "hook": "<logical-name>", "payload": <stdin-json> }`.
 *
 * Failure semantics — these mirror exactly `backend/src/eleanor4devs/
 * hook_lifecycle.py`'s `FATAL_HOOKS` set so the runtime contract
 * matches the backend's enforcement:
 *   - after_create  → fatal on POST failure (caller exits non-zero,
 *                     Claude Code aborts dispatch)
 *   - before_run /
 *     after_run /
 *     before_remove → tolerated on POST failure (caller exits 0, run
 *                     continues; the failure is still POSTed so it
 *                     lands in the backend audit log)
 */
import {
  ELEANOR_HOOK_NAMES,
  type EleanorHookName,
} from "./hook_templates.js";

/** Hooks whose failure aborts dispatch — must equal `FATAL_HOOKS` in `hook_lifecycle.py`. */
const FATAL_HOOKS: ReadonlySet<EleanorHookName> = new Set([
  "after_create",
]);

export interface HookArgs {
  hookName: EleanorHookName;
  backendUrl?: string;
}

export function parseHookArgs(rest: string[]): HookArgs {
  const positional = rest[0];
  if (!positional) {
    throw new Error(
      "eleanor4devs hook: missing hook name. Usage: eleanor4devs hook <after_create|before_run|after_run|before_remove>",
    );
  }
  if (!(ELEANOR_HOOK_NAMES as readonly string[]).includes(positional)) {
    throw new Error(
      `eleanor4devs hook: unknown hook ${JSON.stringify(positional)}. Expected one of: ${ELEANOR_HOOK_NAMES.join(", ")}`,
    );
  }
  const hookName = positional as EleanorHookName;

  let backendUrl: string | undefined;
  const idx = rest.indexOf("--backend");
  if (idx !== -1) {
    const value = rest[idx + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(
        "eleanor4devs hook: --backend requires a URL argument, e.g. --backend https://api.eleanor4devs.com",
      );
    }
    backendUrl = value;
  }

  return backendUrl !== undefined
    ? { hookName, backendUrl }
    : { hookName };
}

export interface HookCallResult {
  ok: boolean;
  /** True iff a failure here should cause the CLI to exit non-zero (= abort Claude dispatch). */
  fatal: boolean;
  reason?: string;
}

export interface RunHookOptions {
  hookName: EleanorHookName;
  backendUrl: string;
  /** Raw stdin contents. May be empty; may have a BOM or trailing CRLF on Windows. */
  stdinJson: string;
  fetch?: typeof globalThis.fetch;
}

/** Strip a UTF-8 BOM + trailing whitespace from a stdin payload. */
function normalizeStdin(raw: string): string {
  let s = raw;
  // U+FEFF — BOM. Windows pipes occasionally inject one.
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1);
  }
  return s.trim();
}

export async function runHook(opts: RunHookOptions): Promise<HookCallResult> {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const fatal = FATAL_HOOKS.has(opts.hookName);
  const url = `${opts.backendUrl.replace(/\/$/, "")}/hooks/${opts.hookName}`;
  const normalized = normalizeStdin(opts.stdinJson);

  let payload: unknown = {};
  let parseError: string | undefined;
  if (normalized.length > 0) {
    try {
      payload = JSON.parse(normalized);
    } catch (err) {
      parseError = `invalid_stdin_json: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Always POST — even on a stdin parse error we want the failure to land
  // in the backend audit log (3-channel surfacing, Spec § hook failures).
  const body =
    parseError !== undefined
      ? JSON.stringify({ hook: opts.hookName, error: parseError })
      : JSON.stringify({ hook: opts.hookName, payload });

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) {
      const reason = `http_${res.status}`;
      return { ok: false, fatal, reason };
    }
  } catch (err) {
    const reason = `network_error: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, fatal, reason };
  }

  if (parseError !== undefined) {
    // The POST succeeded but the payload was malformed — surface the
    // parse error to the caller. Tolerated hooks still exit 0; only
    // after_create escalates to a non-zero exit.
    return { ok: false, fatal, reason: parseError };
  }

  return { ok: true, fatal };
}

/** Read all of stdin as a UTF-8 string. Returns "" if stdin is closed/empty. */
export async function readStdin(): Promise<string> {
  // Node-only helper. Kept tiny to avoid coupling tests to stdin behavior;
  // tests inject the string directly via `runHook(stdinJson: ...)`.
  // eslint-disable-next-line no-undef
  const stdin = process.stdin;
  if (stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
