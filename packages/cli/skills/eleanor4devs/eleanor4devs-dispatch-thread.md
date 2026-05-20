---
name: eleanor4devs-dispatch-thread
description: Route a new thread to the appropriate Provider Box based on user preferences and explicit override.
---

# When to use

- The user asks Eleanor to start a new agent thread ("dispatch a thread on the auth refactor")
- A multi-step task has been decomposed into parallel sub-tasks and each needs its own thread

# Procedure

1. Consult the user profile for `primary_provider` (claude / codex).
2. If the user explicitly named a provider in the request, treat that as `explicit_override`.
3. Run `select_provider({primary_provider, available_providers, explicit_override})` from the dispatch module — order is override → primary → first-available fallback.
4. Check the focus cap via the `eleanor4devs-check-focus` skill before launching. If `has_capacity_for_more = false`, surface a soft warning ("you're already at your focus cap of N; this will push you over") but proceed if the user confirms.
5. Call `Dispatcher.dispatch(user_id, provider, ...)`; capture the resulting `(Thread, FocusStatus)`.
6. Emit `report({event: "info", thread_id, text: "Dispatched to <provider>: <display_name>"})`.

# Invariants

- Soft cap, not hard: dispatch always proceeds. The FocusStatus is informational.
- `thread_id` minted at dispatch time is the stable identity for the rest of the thread's lifecycle.
