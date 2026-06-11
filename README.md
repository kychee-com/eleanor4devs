# eleanor4devs — public packages

Public npm packages for [eleanor4devs](https://eleanor4devs.com), a voice-first developer assistant that orchestrates Claude Code and Codex sessions.

This repo holds the source for the 4 `@eleanor4devs/*` packages on npm:

| Package | npm | Description |
|---|---|---|
| [`@eleanor4devs/provider-contract`](https://www.npmjs.com/package/@eleanor4devs/provider-contract) | [![npm](https://img.shields.io/npm/v/@eleanor4devs/provider-contract.svg)](https://www.npmjs.com/package/@eleanor4devs/provider-contract) | Common Provider Contract — shared TypeScript types for Eleanor's Provider Boxes (Claude Local, Codex Local). |
| [`@eleanor4devs/sdk`](https://www.npmjs.com/package/@eleanor4devs/sdk) | [![npm](https://img.shields.io/npm/v/@eleanor4devs/sdk.svg)](https://www.npmjs.com/package/@eleanor4devs/sdk) | Canonical TypeScript SDK — typed entry points for MCP verbs, thread orchestration, status, auth. |
| [`@eleanor4devs/mcp`](https://www.npmjs.com/package/@eleanor4devs/mcp) | [![npm](https://img.shields.io/npm/v/@eleanor4devs/mcp.svg)](https://www.npmjs.com/package/@eleanor4devs/mcp) | MCP server — single declarative verb `report({event, ...})`. Strict credential isolation. |
| [`@eleanor4devs/cli`](https://www.npmjs.com/package/@eleanor4devs/cli) | [![npm](https://img.shields.io/npm/v/@eleanor4devs/cli.svg)](https://www.npmjs.com/package/@eleanor4devs/cli) | CLI — `eleanor4devs install`, skill packs, Telegram auth, status. |

## Install

```bash
npm install -g @eleanor4devs/cli
eleanor4devs install
```

Then visit the Telegram bot at [`@eleanor4devs_bot`](https://t.me/eleanor4devs_bot).

Full install instructions: https://eleanor4devs.com/install/

## Repository structure

```
packages/
├── provider-contract/   Shared TypeScript types (the 8-verb common contract).
├── sdk/                 Canonical TypeScript SDK consumed by 3rd-party code + this repo's other packages.
├── mcp/                 Single-verb MCP server for Claude Code / Codex.
└── cli/                 `eleanor4devs` CLI — install + auth + status.

.github/workflows/
└── publish-all.yml      Trusted Publisher OIDC publish pipeline.
```

This is a monorepo using npm workspaces. All 4 packages release lockstep at the same version via the `publish-all.yml` workflow.

## Validation profiles (test tiers)

Tests follow the product's three-profile partition (spec AC-145):

- **Core** — offline: `ELEANOR4DEVS_SKIP_LIVE_NPM=1 npm test`. Every live-network regression test self-gates on that env var (pinned monorepo-wide by `packages/sdk/test/core_profile_offline.test.ts`), so the gated run passes with no network access (AC-102).
- **Extension** — real network against the npm registry and the deployed surfaces: `npm test` (the default — includes the live tests).
- **Real Integration** — real vendor APIs; exercised by the private repo's backend suite and the Red Team's `/systemtest` cycles against the deployed product, not from this repo.

## Release process

All releases go through the GitHub Actions `publish-all.yml` workflow using npm's Trusted Publisher OIDC federation — **no stored npm tokens**. Each published version has cryptographic provenance attestation linking the binary to the GitHub Actions run that produced it. Verify any release via:

```bash
npm audit signatures @eleanor4devs/<package>
```

Or via the published shasum + the workflow's GitHub Release attachment.

## Privacy & Security

See https://eleanor4devs.com/privacy/. Short version:

- The MCP server exposes **exactly one verb** (`report`). No file I/O, no shell exec, no arbitrary network egress.
- Local audit log at `~/.eleanor4devs/audit.log` records every call's hashed digest. Raw payloads stay local.
- Only **hashed payload digests** + session metadata leave the user's machine, not raw `report` contents.
- Sign out a CLI install (revokes its backend token, then deletes the local credential) with `eleanor4devs logout`.

## Reporting issues

Open an issue: https://github.com/kychee-com/eleanor4devs/issues

For security disclosures, please email volinskey@gmail.com instead of opening a public issue.

## License

UNLICENSED — code shipped publicly for consumer access only. Contact for licensing terms.

Internal product spec, plan documents, backend implementation, and infrastructure code live in a separate private repository.
