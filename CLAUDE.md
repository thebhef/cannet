# CLAUDE.md

Working agreement for contributors (human and AI) on this repository.

## Planning

The `plans/` directory is the source of truth for what we're building and in
what order. Treat it as living documentation, not historical record.

- **`plans/features.md`** — the target feature set. Edit when scope changes.
- **`plans/phased-implementation.md`** — the ordered plan. Each phase has a
  scope and exit criteria. Don't start a later phase before the current one
  meets its exit criteria, and don't quietly expand a phase's scope — if
  something needs to move, update the document first.
- **`plans/technology-inventory.md`** — running list of third-party libraries,
  protocols, file formats, and drivers. **Update it whenever a dependency
  decision is made**, even if the decision is "rejected." Mark each entry as
  `proposed`, `adopted`, or `rejected` so the rationale is traceable.
- **`plans/backlog.md`** — short list of things noticed in passing that don't
  belong in the current step (cleanups, follow-ups, ideas). Add to it instead
  of doing drive-by work; review and prune it whenever a new phase or step is
  being planned. Keep it small — if it's growing, that's a signal to fold
  items into a phase or drop them.

When a planning document and the code disagree, fix whichever is wrong in the
same change — never leave them inconsistent.

## Work in small, verifiable steps

Prefer many small commits that each leave the repo in a working state over a
single large commit.

- Identify any missing dependencies or technologies before starting. If a
  step needs something not already in `plans/technology-inventory.md`,
  surface that decision first — don't quietly bring in a new library
  mid-step.
- Break a phase into the smallest steps that still produce something
  observable (a passing test, a runnable demo, a committed doc update).
- Each step should be independently reviewable: clear scope, clear
  before/after, no drive-by changes. If you spot something worth doing that
  isn't part of the current step, add it to `plans/backlog.md` and keep
  going.
- Reviewability is about content as much as size. A small diff of
  hand-rolled async networking, threading, or protocol framing is harder
  to spot-check than a larger diff that defines a schema and leans on a
  vetted library for the failure-mode-rich parts. When slicing work — and
  when choosing between build-it-ourselves and adopt-a-library — prefer
  shapes where the hand-written surface is small and the hard parts are
  either generated, library-provided, or exercised by tests. Reviewers
  catch mistakes in code they can read; the goal is to give them code
  they can read.
- If a step starts sprawling, stop and split it. It's cheaper to land two
  focused commits than to untangle one.
- Keep documentation updates in the same commit as the code change they
  describe. A behavioral change without a corresponding doc update is
  incomplete.

## Test-driven development

Write the test first, watch it fail, then make it pass.

- New behavior lands with tests that exercise it. No "we'll add tests later."
- Fix bugs by first writing a failing test that reproduces the bug, then
  fixing the code. The test stays as a regression guard.
- Refactors are done under a green test suite — if existing tests don't cover
  the area being refactored, add coverage before refactoring.
- Tests should be fast and deterministic. If a test needs hardware, network,
  or large fixtures, isolate it so the default suite stays quick.

## Documentation

Docs are a deliverable, not an afterthought. The repository carries three
layers of documentation, and each has a specific job:

- **`README.md`** — the entry point for someone who has just cloned the
  repo. It must answer: what is this, what's in it, what do I need to
  build it on every supported OS, and how do I run it. Update it
  whenever any of those answers change (new module, new dependency,
  new prerequisite, new run command).
- **`plans/`** — the roadmap and rationale. See "Planning" above.
- **rustdoc on crate roots and stable public APIs** — the contract for
  in-process consumers. When a public type or trait changes shape, its
  rustdoc changes with it, in the same commit.

Rules:

- Keep doc updates in the same commit as the code change they describe.
  A behavioral change without a corresponding doc update is incomplete.
- Every phase has a documentation deliverable as part of its exit
  criteria: the README reflects what now ships, `plans/` records what
  changed and why, and rustdoc covers any new public API. A phase is
  not done until its docs match what the code does.
- When you spot a doc-vs-code mismatch, fix whichever is wrong in the
  same change — never leave them inconsistent.

## Completing the plan as documented

Follow the phased plan in order. When reality forces a change:

1. Update `plans/phased-implementation.md` (and any other affected planning
   doc) **before** writing code that diverges from it.
2. Note why the change was needed in the commit message.
3. If a dependency was added, removed, or swapped, update
   `plans/technology-inventory.md` in the same change.

Finishing a phase means meeting its documented exit criteria — not "the code
roughly does the thing." If the criteria are wrong, fix them; don't ignore
them.

## Behavioral guidelines

Adapted from <https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md>.
Bias toward caution over speed. For trivial tasks, use judgment.

### Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes,
simplify.

### Surgical changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, log it in `plans/backlog.md` — don't
  delete it inline.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### Goal-driven execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it
work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs,
fewer rewrites due to overcomplication, and clarifying questions come before
implementation rather than after mistakes.
