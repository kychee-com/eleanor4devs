---
name: eleanor4devs-adopt-session
description: Reconcile an externally-started agent session into a new Eleanor thread (transfer-in flow).
---

# When to use

- The user has run `claude` (or `codex`) directly in a terminal and the appropriate hook has fired its `after_create` event
- The Provider Box reports an unknown `session_id` that isn't already bound to a `thread_id`

# Procedure

1. Receive the adopt signal from the Provider Box, including: provider name, `session_id`, `cwd`, and (if available) the provider-native session name.
2. Mint a fresh `thread_id` (UUIDv7) via ThreadStateManager.create_thread.
3. Bind the `session_id` → `thread_id` mapping in `sessions-map`.
4. Set initial `state = active`. Set primary fields from the user profile (focus cap, escalation ladder, etc.).
5. Emit `report({event: "info", thread_id, text: "Adopted '<display_name>' from <provider>."})` so the user knows the thread is now under Eleanor's view.
6. Enqueue a `summarize(thread_id)` async job if no `auto_summary` is cached yet.

# Invariants

- Adoption MUST NOT drop or rename existing sessions on the same `thread_id` if one already exists.
- Adopt is idempotent: re-running with the same `session_id` is a no-op.
