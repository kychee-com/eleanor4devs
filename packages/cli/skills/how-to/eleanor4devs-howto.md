---
name: eleanor4devs-howto
description: Pointer to the eleanor4devs development workflow skills (brainstorm → spec → plan → implement → review). NOT a duplicate skill set.
---

# Eleanor's How-To Pack

The "how-to" pack is a documentation pointer, not a copy of the
development-workflow skills. The skills you want for building software
with Eleanor are the same global skills the Kychee workflow already
provides:

- **`/brainstorm`** — Brainstorm ideas into structured input for `/spec`.
- **`/spec`** — Create or update a product specification.
- **`/plan`** — Create a new implementation plan or continue an existing one.
- **`/implement`** — Execute an implementation plan step by step.
- **`/review`** — Review a pull request.

These live globally under `~/.claude/skills/` (or your editor's
equivalent). The `eleanor4devs install` command does NOT duplicate them
under `~/.claude/skills/eleanor4devs/` — that would split the workflow
into two parallel copies and create drift.

## Usage notes for Eleanor users

- Start every non-trivial feature with `/brainstorm` → `/spec` → `/plan`
  before any code is written. Eleanor's [feedback memory]
  (memory/feedback_workflow_discipline.md) enforces this gate.
- During `/implement`, Eleanor (via the Core Skills Pack — the OTHER pack
  installed by `eleanor4devs install`) handles thread orchestration:
  dispatching to providers, pausing/waking, transferring control,
  summarizing for voice review.
- The two packs are complementary: the global workflow skills decide
  WHAT to build; the eleanor4devs Core Skills Pack handles HOW Eleanor
  manages the agent sessions doing the building.

## Installation

The how-to pack is documentation only. There's no file to install.
Running `eleanor4devs install-skills --how-to` prints this pointer.
