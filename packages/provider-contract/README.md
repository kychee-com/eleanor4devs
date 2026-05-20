# @eleanor4devs/provider-contract

Common Provider Contract — shared TypeScript types for [eleanor4devs](https://eleanor4devs.com) Provider Boxes.

The contract defines the 8-verb surface every Provider Box (Claude Local, Codex Local, plus Post-MVP cloud boxes) implements:

**Execution verbs (6):** `dispatch`, `subscribe`, `inject`, `pause`, `resume`, `query`.
**Metadata verbs (2):** `read_session_name`, `write_session_name`.

Plus:
- `ProviderCapabilities` descriptor (DD-24) — each box declares its native support per-feature so Eleanor Core stays agent-agnostic.
- `RunAttemptPhase` const + frozen array (11 phases) — every dispatch records phase transitions.
- `validateWorkspaceSafety(input)` runtime guard + `WorkspaceSafetyError` — three invariants enforced before any agent process starts.
- Branded `ThreadId` / `SessionId` types — opaque IDs that don't collide at the type level.

Consumed by:
- [`@eleanor4devs/sdk`](https://www.npmjs.com/package/@eleanor4devs/sdk) — TypeScript SDK.
- [`@eleanor4devs/mcp`](https://www.npmjs.com/package/@eleanor4devs/mcp) — single-verb MCP server.
- [`@eleanor4devs/cli`](https://www.npmjs.com/package/@eleanor4devs/cli) — `eleanor4devs install` + auth.
- The eleanor4devs backend (Python — types kept in sync manually with the TypeScript surface).

## Install

```bash
npm install @eleanor4devs/provider-contract
```

## Usage

```typescript
import {
  type ProviderBox,
  type ProviderCapabilities,
  type RunAttemptPhase,
  RUN_ATTEMPT_PHASES,
  validateWorkspaceSafety,
  WorkspaceSafetyError,
} from "@eleanor4devs/provider-contract";

// Validate a workspace path before launching an agent process:
validateWorkspaceSafety({
  cwd: "/home/dev/repo",
  workspace_path: "/home/dev/repo",
  workspace_root: "/home/dev",
  identifier: "auth-refactor",
});
```

## Spec reference

Internal product spec is private. Public documentation: https://eleanor4devs.com. Each release's GitHub Release notes summarize contract changes.

## License

UNLICENSED — code shipped publicly for consumer access only. Contact for licensing terms.
