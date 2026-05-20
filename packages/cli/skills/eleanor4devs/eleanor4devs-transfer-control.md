---
name: eleanor4devs-transfer-control
description: Hand a thread between Eleanor-managed mode and direct user control without losing thread_id continuity.
---

# When to use

Invoke this when:
- The user explicitly asks to take over a thread directly ("let me drive this one" / "transfer to me")
- The user asks Eleanor to take over a session they started manually
- A transfer-in or transfer-out signal has been detected by the appropriate Provider Box

# Procedure

1. Identify the target thread via the Session Naming precedence (user nickname → provider-native name → auto_summary topic). Never quote a UUID or hex id back to the user.
2. Confirm the direction (Eleanor → user, or user → Eleanor) and the destination provider session id.
3. For Eleanor → user: emit `report({event: "info", thread_id, text: "transferring control to user"})`, then mark the thread as `paused` on Eleanor's side and stop subscribing.
4. For user → Eleanor: emit `report({event: "info", thread_id, text: "adopting external session"})`, attach to the underlying provider session via the Provider Box's subscribe verb, transition the thread to `active`.
5. `thread_id` MUST remain stable across the transfer. The underlying `session_id` may change; the `thread_id` does not.

# Invariants

- Nicknames survive transfer-in and transfer-out (they're bound to `thread_id`, not `session_id`).
- Auto-summaries survive transfer-in/out for the same reason.
- A transfer NEVER drops the user's focus-cap accounting.
