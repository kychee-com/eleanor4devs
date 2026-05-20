---
name: eleanor4devs-check-focus
description: Read the user's focus cap, count of currently-active threads, and whether the cap has been breached.
---

# When to use

- The user asks "how many threads do I have open?" / "am I over my focus cap?"
- Before suggesting a parallel dispatch (always check focus before recommending another thread)
- When surfacing a status summary at session start or after a paused → active transition

# Procedure

1. Look up the user profile to find the configured `focus_cap` (default 3).
2. Query ThreadStateManager.list_threads_for_user(user_id, state="active") and count.
3. Compute the FocusStatus record: `{active_count, cap, over_cap_by, has_capacity_for_more}`.
4. Report to the user using the precedence-helper names for the active threads — never list `thread_id` strings.
5. If `over_cap_by > 0`, soft-warn (do not block actions).

# Invariants

- Focus checks are read-only — never mutate thread state during a focus check.
- The cap is per-user, not per-provider. A user with `focus_cap=3` may have all 3 active threads on the same provider.
