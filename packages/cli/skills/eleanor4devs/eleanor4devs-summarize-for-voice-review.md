---
name: eleanor4devs-summarize-for-voice-review
description: Decompose a thread's recent output into a numbered micro-todo list suitable for voice narration via the Voice Review Narrator.
---

# When to use

- A thread has produced more than ~500 chars of agent output and the user is on a voice surface
- The user explicitly asks for a voice walkthrough of an active or just-completed thread
- After a paused thread auto-wakes and there's queued output to surface

# Procedure

1. Pull the latest agent output for the thread via the Provider Box's `query` verb.
2. Run it through the Conversation Decomposer (`decompose(text, sentences_per_chunk=2)`) to produce numbered MicroTodo items.
3. For each item, classify by category (destructive-changes, test-results, new-external-deps, agent-uncertainty, security-changes, or general).
4. Categories in the user profile's `voice_review_always_narrate` set are NON-SKIPPABLE — the user cannot say "skip this item" and have it skipped.
5. Output structured: a list of NarratorItem records each carrying `{text, category, is_mandatory}`. The Voice Review Narrator consumes this directly.

# Invariants

- The 5 base always-narrate categories are non-skippable regardless of user config: destructive-changes, test-results, new-external-deps, agent-uncertainty, security-changes.
- The narrator advances ONE item at a time and waits for explicit acknowledgment between items.
- Voice descriptions of sessions (when offered for selection) NEVER contain UUIDs, hex IDs, or `thread_id` strings — always use the precedence helper.
