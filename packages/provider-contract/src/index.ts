/**
 * @eleanor4devs/provider-contract
 *
 * Common Provider Contract — types shared by every Provider Box.
 *
 * See:
 *   - docs/products/eleanor4devs/eleanor4devs-spec.md § Provider Boxes
 *   - docs/plans/eleanor4devs-plan.md DD-10
 */

export const RunAttemptPhase = {
  PreparingWorkspace: "PreparingWorkspace",
  BuildingPrompt: "BuildingPrompt",
  LaunchingAgentProcess: "LaunchingAgentProcess",
  InitializingSession: "InitializingSession",
  StreamingTurn: "StreamingTurn",
  Finishing: "Finishing",
  Succeeded: "Succeeded",
  Failed: "Failed",
  TimedOut: "TimedOut",
  Stalled: "Stalled",
  CanceledByReconciliation: "CanceledByReconciliation",
} as const;

export type RunAttemptPhase =
  (typeof RunAttemptPhase)[keyof typeof RunAttemptPhase];

export const RUN_ATTEMPT_PHASES: readonly RunAttemptPhase[] = Object.freeze(
  Object.values(RunAttemptPhase),
);

// ----------------------------------------------------------------------------
// Workspace Safety (spec § Provider Boxes, Symphony pattern #3)
//
// Three invariants. Any violation must fail BEFORE any process starts.
//   1. cwd == workspace_path
//   2. workspace_path is prefix-contained by workspace_root (after normalization)
//   3. identifier matches /^[A-Za-z0-9._-]+$/
// ----------------------------------------------------------------------------

export type WorkspaceSafetyInvariant = "cwd" | "workspace_path" | "identifier";

export class WorkspaceSafetyError extends Error {
  override readonly name = "WorkspaceSafetyError";
  readonly invariant: WorkspaceSafetyInvariant;

  constructor(invariant: WorkspaceSafetyInvariant, message: string) {
    super(message);
    this.invariant = invariant;
  }
}

export interface WorkspaceSafetyInput {
  cwd: string;
  workspace_path: string;
  workspace_root: string;
  identifier: string;
}

const IDENTIFIER_RE = /^[A-Za-z0-9._-]+$/;

function normalize(p: string): string {
  // POSIX-style normalization for the contract; runtime callers pass
  // absolute paths. We collapse `.` and `..` segments without touching
  // the filesystem so this works the same in tests and in production.
  const parts = p.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      if (stack.length === 0) stack.push(part);
      continue;
    }
    if (part === "..") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    stack.push(part);
  }
  let out = stack.join("/");
  if (out === "") out = "/";
  return out;
}

export function validateWorkspaceSafety(input: WorkspaceSafetyInput): void {
  const cwd = normalize(input.cwd);
  const wp = normalize(input.workspace_path);
  const wr = normalize(input.workspace_root);

  if (cwd !== wp) {
    throw new WorkspaceSafetyError(
      "cwd",
      `cwd (${cwd}) must equal workspace_path (${wp})`,
    );
  }

  const rootWithSlash = wr.endsWith("/") ? wr : wr + "/";
  if (wp !== wr && !wp.startsWith(rootWithSlash)) {
    throw new WorkspaceSafetyError(
      "workspace_path",
      `workspace_path (${wp}) must be prefix-contained by workspace_root (${wr})`,
    );
  }

  if (!IDENTIFIER_RE.test(input.identifier)) {
    throw new WorkspaceSafetyError(
      "identifier",
      `identifier (${JSON.stringify(input.identifier)}) must match ${IDENTIFIER_RE}`,
    );
  }
}

// ----------------------------------------------------------------------------
// Provider Box contract (spec § Provider Boxes — 6 verbs)
//
// Skeleton types only. Concrete payload shapes evolve as Phase 8 (Claude
// Local Box) and Phase 10 (Codex Local Box) implement this interface. The
// goal here is to lock the SHAPE of the contract — verb names, arg arity,
// return-type kinds — so neither Box can drift unilaterally.
// ----------------------------------------------------------------------------

export type ThreadId = string & { readonly __brand: "ThreadId" };
export type SessionId = string & { readonly __brand: "SessionId" };

export interface DispatchInput {
  thread_id: ThreadId;
  workspace_path: string;
  workspace_root: string;
  identifier: string;
  prompt: string;
}

export interface InjectInput {
  continuation: string;
}

export interface ThreadHandle {
  thread_id: ThreadId;
  session_id: SessionId;
  phase: RunAttemptPhase;
}

export interface ThreadState {
  thread_id: ThreadId;
  session_id: SessionId;
  phase: RunAttemptPhase;
  status: "active" | "paused" | "completed";
}

export interface ProviderEvent {
  thread_id: ThreadId;
  phase: RunAttemptPhase;
  timestamp: string;
  payload: unknown;
}

export type Unsubscribe = () => void;

// ----------------------------------------------------------------------------
// Capability descriptors (DD-24)
//
// Every Provider Box exposes `capabilities()` so Eleanor Core can branch
// on supported features at orchestration-layer decision points rather than
// scattering `if provider == "..."` through Core. The descriptor is a typed
// record so a future capability flag is added once at the contract level
// and every Box must declare its value truthfully.
// ----------------------------------------------------------------------------

export interface ProviderCapabilities {
  /** Whether the box can spawn a new agent session itself. */
  can_dispatch: boolean;
  /**
   * How the box delivers a continuation prompt to the running agent.
   * - `native`: the box can push the prompt directly (e.g. Codex `turn/start`).
   * - `user_mediated`: the box surfaces the prompt to the user, who pastes
   *   it into the agent (e.g. Claude Code's MCP request-response model).
   */
  inject_mechanism: "native" | "user_mediated";
  /** Whether the box can observe streaming agent events between turns. */
  can_observe_streaming: boolean;
  /**
   * Process model of an agent session:
   * - `process`: one OS process per session (Claude Code).
   * - `container`: a single host process hosts multiple sessions (Codex
   *   app-server).
   */
  session_lifetime: "process" | "container";
  /** Whether the box's `write_session_name` does a real provider-side write. */
  can_write_session_name: boolean;
}

export interface ProviderBox {
  dispatch(input: DispatchInput): Promise<ThreadHandle>;
  subscribe(
    thread_id: ThreadId,
    handler: (event: ProviderEvent) => void,
  ): Unsubscribe;
  inject(thread_id: ThreadId, input: InjectInput): Promise<void>;
  pause(thread_id: ThreadId): Promise<void>;
  resume(thread_id: ThreadId): Promise<void>;
  query(thread_id: ThreadId): Promise<ThreadState>;
  /** Describe which contract features this box supports natively (DD-24). */
  capabilities(): ProviderCapabilities;
}
