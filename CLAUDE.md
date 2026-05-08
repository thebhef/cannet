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

When a planning document and the code disagree, fix whichever is wrong in the
same change — never leave them inconsistent.

## Work in small, verifiable steps

Prefer many small commits that each leave the repo in a working state over a
single large commit.

- Break a phase into the smallest steps that still produce something
  observable (a passing test, a runnable demo, a committed doc update).
- Each step should be independently reviewable: clear scope, clear
  before/after, no drive-by changes.
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
