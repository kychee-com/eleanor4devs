# @eleanor4devs/sdk

Canonical TypeScript SDK for [eleanor4devs](https://eleanor4devs.com).

Typed entry points for:
- **MCP verbs** — wraps the single declarative `report` verb the eleanor4devs MCP server exposes (see [`@eleanor4devs/mcp`](https://www.npmjs.com/package/@eleanor4devs/mcp)).
- **Thread orchestration** — `Eleanor` class for dispatch / inject / pause / resume / query operations against the backend.
- **Status + auth** — the auth handshake the CLI uses to link a local install to a Telegram identity.

Imports the [`@eleanor4devs/provider-contract`](https://www.npmjs.com/package/@eleanor4devs/provider-contract) types so the SDK surface and the contract stay aligned.

## Install

```bash
npm install @eleanor4devs/sdk
```

Requires Node 20+. Ships both CJS and ESM via `package.json` `exports`; works in both `require` and `import` contexts.

## Usage

```typescript
import { Eleanor, VERSION } from "@eleanor4devs/sdk";

console.log(VERSION); // "0.0.1"

const eleanor = new Eleanor({
  apiBase: "https://api.eleanor4devs.com",
  // Auth token from `eleanor4devs auth` (CLI) or the bot-issued linking flow.
  refreshToken: process.env.ELEANOR_REFRESH_TOKEN,
});

// Future: eleanor.threads.list(), eleanor.threads.dispatch(...), etc.
// Surface lands as Phase 9+ work in docs/plans/eleanor4devs-plan.md.
```

## Spec reference

Internal product spec is private. Public documentation: https://eleanor4devs.com.

## License

UNLICENSED — code shipped publicly for consumer access only. Contact for licensing terms.
