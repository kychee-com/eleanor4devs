---
name: eleanor4devs-wake-thread
description: Transition a paused thread back to active when the underlying agent emits output or the user re-engages.
---

# When to use

- The provider box has reported new output on a `paused` thread's session
- The user explicitly asks to resume a thread ("come back to that auth refactor")
- A wake condition from the user profile fires (e.g., DnD window closed and queued events flush)

# Procedure

1. Resolve the thread via Session Naming precedence. Never quote IDs.
2. Confirm the thread is currently `paused` (waking an `active` thread is a no-op; waking a `completed` thread is invalid — surface a clarifying message instead).
3. Re-attach the foreground subscription to the underlying provider session.
4. Persist `state = active` via ThreadStateManager.
5. Surface the wake to the user via the escalation ladder (Telegram by default; voice if Continuous Chat Mode is active).

# Invariants

- `thread_id` stable across wake.
- The wake itself does not consume a tap-to-call link; the user-initiated path covers that separately.
