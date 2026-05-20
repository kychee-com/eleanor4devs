/**
 * @eleanor4devs/cli
 *
 * The eleanor4devs CLI. Commands:
 *   - install                — writes the MCP entry to the agent's
 *                              config (e.g., ~/.claude/mcp_servers.json),
 *                              copies the Core Skills Pack, sets up
 *                              hook templates.
 *   - install-skills [--core | --how-to]
 *   - skills list
 *   - auth                   — drives the one-time-code auth handshake
 *                              with the Eleanor backend via the bot.
 *   - status
 *   - --version
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § CLI.
 */

export const CLI_VERSION = "0.0.0";
