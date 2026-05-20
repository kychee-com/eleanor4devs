# @eleanor4devs/mcp

Eleanor's MCP server. Exposes a **single declarative verb**: `report({event, ...})`. Used by Claude Code / Codex to surface agent progress to Eleanor without giving the MCP any new I/O capabilities.

Part of [eleanor4devs](https://eleanor4devs.com) — voice-first developer assistant that orchestrates your Claude Code and Codex sessions.

## Install

The CLI installer wires this up automatically:

```bash
npm install -g @eleanor4devs/cli
eleanor4devs install
```

(Writes the MCP entry to `~/.claude/mcp_servers.json` — preserving any other agents' entries.)

## Verb surface

**Exactly one verb: `report`.** Closed event enum:

```typescript
type ReportEvent =
  | "progress"
  | "done"
  | "blocked"
  | "context_warning"
  | "error"
  | "info"
  | "question";
```

Forbidden argument keys (the no-new-vector contract — rejected with a typed validation error):
- `command`, `path`, `read`, `write`, `fetch`

The MCP server does NOT shell out, does NOT read arbitrary files, does NOT make arbitrary HTTP calls. The only file path it touches is `~/.eleanor4devs/audit.log` (append-only JSONL), and the only network endpoint it talks to is the eleanor4devs backend configured at install time.

`event: "question"` blocks the response until the user answers (no synthetic timeout, per DD-11). Other events return immediately.

## CLI flags

- `eleanor4devs-mcp` — runs the production MCP server on stdio (what Claude Code invokes).
- `eleanor4devs-mcp --version` — prints the package version.
- `eleanor4devs-mcp --dry-run` — accepts mocked verb calls on stdio and emits validation results without contacting the backend. Used by the Red Team to probe the verb surface.
- `eleanor4devs-mcp --verify` — verifies the local install's SHA256 against the npm registry's published shasum + provenance attestation. Use after `npm install` to spot-check supply-chain integrity.
- `eleanor4devs-mcp --help` — list flags.

## Spec reference

Internal product spec is private. Public documentation: https://eleanor4devs.com.

## License

UNLICENSED — code shipped publicly for consumer access only. Contact for licensing terms.
