# @eleanor4devs/cli

Eleanor CLI for [eleanor4devs](https://eleanor4devs.com) — install the MCP entry, install/list skill packs, link to Telegram, check status.

## Install

```bash
npm install -g @eleanor4devs/cli
eleanor4devs install
```

Requires Node 20+. No sudo, no global system deps; installs only into `~/.claude/` (MCP entry + skills) and `~/.eleanor4devs/` (audit log + auth state).

## Commands

### `eleanor4devs install`
Writes the eleanor4devs MCP server entry into `~/.claude/mcp_servers.json` (preserving any existing entries from other agents), installs the Core Skills Pack under `~/.claude/skills/eleanor4devs/`, and sets up the Claude Code hook templates.

### `eleanor4devs install-skills [--core|--how-to]`
Install the Core Skills Pack (7 markdown skills — `transfer-control`, `pause-thread`, `wake-thread`, `adopt-session`, `check-focus`, `dispatch-thread`, `summarize-for-voice-review`) or the How-To Pack (pointers at global `/brainstorm` / `/spec` / `/plan` / `/implement` / `/review` skills with usage notes).

### `eleanor4devs skills list`
Lists installed skills under `~/.claude/skills/eleanor4devs/` with their source pack.

### `eleanor4devs auth`
Displays a one-time code. Send it to [@eleanor4devs_bot](https://t.me/eleanor4devs_bot) on Telegram. The bot links your Telegram identity to this CLI install.

### `eleanor4devs status`
Confirms your auth, prints the connected Telegram identity, lists the threads Eleanor is currently watching.

### `eleanor4devs --version`
Prints the CLI version.

## Auth flow

CLI auth uses a one-time code linked through the Telegram bot per spec DD-4 (Telegram-only auth at MVP; Google / Apple ship Post-MVP with the native apps).

## Updating

```bash
npm install -g @eleanor4devs/cli@latest
```

Releases are lockstep across all 4 `@eleanor4devs/*` packages (`provider-contract`, `sdk`, `mcp`, `cli`) — they share a single version.

## Uninstall

```bash
eleanor4devs auth revoke && npm uninstall -g @eleanor4devs/cli
```

Revokes the backend OAuth token, then removes the CLI binary. The MCP entry in `~/.claude/mcp_servers.json` remains until you delete it manually — we don't edit a file we did not exclusively own.

## Spec reference

Internal product spec is private. Public documentation: https://eleanor4devs.com.

## License

UNLICENSED — code shipped publicly for consumer access only. Contact for licensing terms.
