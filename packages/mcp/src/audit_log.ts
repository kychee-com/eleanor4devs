/**
 * Local audit log writer.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § audit log
 * + DD-13. JSONL format (newline-delimited JSON, one event per line).
 * Local audit-log entries store a `payload_digest` rather than the
 * raw payload — that's the credential-isolation boundary at the file
 * level. Even with full filesystem read access, an attacker reading
 * `~/.eleanor4devs/audit.log` cannot recover the original payload
 * contents.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Canonical local audit-log path. The CLI's `install` writes here on
 * first run; the MCP server's wire-level 1:1 logger also writes here.
 */
export function defaultAuditLogPath(): string {
  return join(homedir(), ".eleanor4devs", "audit.log");
}

export interface AuditAppendInput {
  thread_id: string;
  event_type: string;
  payload: unknown;
}

export interface AuditLogOptions {
  /** Override the canonical `~/.eleanor4devs/audit.log` path. */
  path?: string;
}

export class LocalAuditLog {
  readonly path: string;

  constructor(options: AuditLogOptions = {}) {
    this.path = options.path ?? defaultAuditLogPath();
  }

  append(input: AuditAppendInput): void {
    const digest = createHash("sha256")
      .update(JSON.stringify(input.payload))
      .digest("hex");
    const entry = {
      timestamp: new Date().toISOString(),
      thread_id: input.thread_id,
      event_type: input.event_type,
      payload_digest: digest,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf-8");
  }
}
