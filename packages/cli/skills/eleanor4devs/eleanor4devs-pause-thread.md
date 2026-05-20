---
name: eleanor4devs-pause-thread
description: Move an active thread to the paused state while keeping its thread_id, nickname, and auto_summary intact.
---

# When to use

- The user has explicitly asked to pause a thread ("park this one", "hold off on the auth refactor")
- An auto-pause condition has fired (unreached call, no response within DnD, etc.)
- The agent is awaiting external input and Eleanor wants to stop foreground narration

# Procedure

1. Resolve the target thread via the Session Naming precedence helper. Never speak UUIDs/hex IDs.
2. Confirm the thread is currently `active`. Pausing a `completed` thread is a no-op; pausing an already-`paused` thread is also a no-op (silently OK).
3. Stop foreground subscriptions; persist `state = paused` via ThreadStateManager.
4. Emit `report({event: "info", thread_id, text: "<thread name> is paused. I'll surface it again when the agent emits."})`.

# Invariants

- `thread_id` stable across pause/wake cycles.
- Nickname + auto_summary persist through pause.
- Focus cap math counts only `active` threads — pausing frees up a slot.
