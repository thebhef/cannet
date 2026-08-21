# Task 93 — Source Comments Name Task Numbers

Opened 2026-08-20 by the overseer, from a review finding on task 89
phase 6. Not an owner observation — a working-agreement violation the
overseen chain introduced and every phase review missed.

## The rule being broken

`CLAUDE.md` § Documentation:

> **Source code references ADRs only — never plan docs.** Comments and
> rustdoc may cite an ADR (the durable decision) but must not point at
> anything under `plans/` (the roadmap, task files, backlog,
> technology-inventory) or name a task number. The roadmap and tasks
> track state and churn, so a code reference to them rots; ADRs record
> what _is_.

## Measured

`git grep -Ei "task [0-9]+"` over `apps/gui/src`,
`apps/gui/src-tauri/src` and `crates`:

| tree | matches |
|---|---|
| `main` | 17 |
| chain head before task 89 phase 6 | 50 |
| chain head after task 89 phase 6 | 71 |

So the chain under this engagement added **54**, roughly tripling a
violation that already existed. Phase 6 alone added 21.

## Why it matters, concretely

The references rot in two directions. `plans/tasks/0090-*.md` records
item 3 being retired into task 91 and item 1 landing in a different
phase than planned; task 88 was reopened after its exit-criteria walk
with two further phases. A comment reading "task 88 phase 4 ruled a
reload out of scope" is already false in the tree — phase 7 reversed
it. The reader has no way to know that without reading `plans/`, which
is exactly the coupling the rule forbids.

## Scope

- Rewrite every `task N` / `phase N` / `plans/…` reference in source
  comments and rustdoc so it states **the reason inline** or cites the
  governing ADR. The reason is almost always already in the sentence —
  most sites read "(task 89 phase 6): ‹the actual explanation›" and
  simply lose the parenthetical.
- A site whose only content is the task reference — it explains nothing
  without `plans/` — needs the rationale written out, not deleted.
- Include the 17 pre-existing sites on `main`. The rule is repo-wide
  and this is one mechanical sweep; splitting it leaves a violation
  behind that the next reader will copy.
- Test files count: `RbsSignalsPanel.dom.test.tsx` has a test *name*
  carrying "task 89 phase 6", which surfaces in test output.
- **No behavioural change.** Comments and test names only. If a comment
  cannot be rewritten without asserting something the code does not do,
  that is a finding for `## Blockers / side effects`, not a licence to
  change code.

## Open question — grooming

- ~~Should a lint enforce it?~~ **Decided by the overseer 2026-08-20:
  yes, in CI.** The evidence is the measurement above — the rule was
  reintroduced 54 times while every diff was being reviewed, so review
  demonstrably does not enforce it. A `grep` over `apps/` and `crates/`
  failing on `task [0-9]` or `plans/` is a few lines and turns a
  recurring cleanup into a one-time one. It goes in **CI rather than
  the pre-commit hook**: the hook stashes unstaged changes and restores
  them minutes later, which has already destroyed concurrent edits in
  this engagement, so adding work to it is the wrong direction.
  Flagged for the owner to overturn if the tooling is unwanted.

## Exit criteria (draft — firm at grooming)

- No source comment, rustdoc, or test name under `apps/` or `crates/`
  names a task number or references a path under `plans/`.
- Every rewritten site still explains *why* the code is as it is — the
  sweep loses no rationale, it relocates it.
- Test counts unchanged; no behavioural diff.
