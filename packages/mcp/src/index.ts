/**
 * @eleanor4devs/mcp
 *
 * Eleanor's MCP server. Exposes a SINGLE declarative verb: `report`.
 * The event field on every `report` call is itself a closed enum.
 * `event: "question"` blocks per DD-11 until Eleanor's backend posts
 * the user's decision.
 *
 * See:
 *   - docs/products/eleanor4devs/eleanor4devs-spec.md § MCP
 *   - docs/plans/eleanor4devs-plan.md DD-11
 */

import { LocalAuditLog } from "./audit_log.js";

/**
 * Closed payload schema for a `report` call. Every safe field is
 * listed here explicitly — the type is intentionally NOT extended
 * with an index signature, so new fields require an explicit spec
 * change + addition. Runtime validation in `McpServer.call` rejects
 * payloads that contain any of `FORBIDDEN_REPORT_ARG_KEYS`.
 */
export interface ReportPayload {
  event: ReportEvent;
  /** Required when event === "question". Used by `postDecision`. */
  call_id?: string;
  /** Free-form, NOT credential-bearing. */
  text?: string;
  thread_id?: string;
  /** Marks an op as destructive — Eleanor routes consent via text chat. */
  destructive?: boolean;
}

/**
 * Closed enum of report event types. New events require an explicit
 * spec change + addition here. Anything else returns unknown_event.
 */
export const REPORT_EVENTS = [
  "progress",
  "done",
  "blocked",
  "context_warning",
  "error",
  "info",
  "question",
] as const;
export type ReportEvent = (typeof REPORT_EVENTS)[number];

const REPORT_EVENT_SET: ReadonlySet<string> = new Set(REPORT_EVENTS);

export type McpErrorCode = "unknown_verb" | "unknown_event" | "invalid_argument";

/**
 * Argument keys that may NOT appear on a `report` payload. The MCP
 * must not become a side-door for arbitrary file/network/shell I/O —
 * if any of these keys arrives on the wire it's a regression signal.
 */
export const FORBIDDEN_REPORT_ARG_KEYS = [
  "command",
  "path",
  "read",
  "write",
  "fetch",
] as const;

export interface McpError {
  code: McpErrorCode;
  message: string;
}

export interface McpErrorEnvelope {
  error: McpError;
}

export interface McpSuccessEnvelope {
  result: unknown;
}

export type McpResult = McpErrorEnvelope | McpSuccessEnvelope;

export interface McpServerOptions {
  /**
   * Local audit log destination. When provided, every call (success
   * or rejection) emits exactly one JSONL line at call-entry time.
   * Wire-level 1:1 logging is the credential-isolation invariant
   * from the plan's MCP-credential-isolation task.
   */
  auditLog?: LocalAuditLog;
}

/**
 * MCP server with a single declarative verb surface.
 *
 * For `report({event: "question", ...})` calls, the server holds the
 * response open per DD-11 until the backend invokes `postDecision`
 * with the matching `call_id`. No synthetic timeout — a question that
 * never gets answered blocks indefinitely. The backend is expected
 * to call `postDecision` when the user replies via Telegram/voice.
 */
export class McpServer {
  private readonly pending = new Map<string, (decision: unknown) => void>();
  private readonly auditLog: LocalAuditLog | undefined;

  constructor(options: McpServerOptions = {}) {
    this.auditLog = options.auditLog;
  }

  private audit(eventType: string, payload: unknown): void {
    if (this.auditLog === undefined) return;
    const threadId =
      (payload as { thread_id?: unknown } | null | undefined)?.thread_id;
    this.auditLog.append({
      thread_id: typeof threadId === "string" ? threadId : "(none)",
      event_type: eventType,
      payload,
    });
  }

  async call(verb: string, payload: unknown): Promise<McpResult> {
    if (verb !== "report") {
      this.audit(`error.unknown_verb.${verb}`, payload);
      return {
        error: {
          code: "unknown_verb",
          message: `Unknown verb '${verb}'. The only supported verb is 'report'.`,
        },
      };
    }
    const payloadObj = (payload ?? {}) as Record<string, unknown>;
    for (const forbidden of FORBIDDEN_REPORT_ARG_KEYS) {
      if (forbidden in payloadObj) {
        this.audit(`error.invalid_argument.${forbidden}`, payload);
        return {
          error: {
            code: "invalid_argument",
            message: `report payload must not include the '${forbidden}' key. MCP is a single-verb report surface, not an I/O side-door.`,
          },
        };
      }
    }
    const event = payloadObj.event;
    if (typeof event !== "string" || !REPORT_EVENT_SET.has(event)) {
      this.audit("error.unknown_event", payload);
      return {
        error: {
          code: "unknown_event",
          message: `Unknown event '${String(event)}'. Allowed: ${REPORT_EVENTS.join(", ")}.`,
        },
      };
    }
    this.audit(`report.${event}`, payload);
    if (event === "question") {
      const callId = payloadObj.call_id;
      if (typeof callId !== "string" || callId.length === 0) {
        return {
          error: {
            code: "unknown_event",
            message: `event 'question' requires a non-empty 'call_id' string.`,
          },
        };
      }
      return new Promise<McpResult>((resolve) => {
        this.pending.set(callId, (decision) => {
          resolve({ result: decision });
        });
      });
    }
    return { result: { accepted: true } };
  }

  /**
   * Backend-side hook: deliver the user's decision for a previously
   * blocked `report({event: "question", call_id, ...})` call.
   * Unknown call_ids are a silent no-op so a stale post can't crash
   * the server.
   */
  postDecision(callId: string, decision: unknown): void {
    const resolver = this.pending.get(callId);
    if (resolver === undefined) return;
    this.pending.delete(callId);
    resolver(decision);
  }
}
