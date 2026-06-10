# CLAUDE.md

Working agreement for contributors (human and AI) on this repository.

## Building and testing locally

`README.md` § Prerequisites is the canonical list of build tooling
(Rust stable, Node 20+, pnpm 9+, and the Tauri WebView host libraries
per OS). Read it before assuming something is unavailable.

The Tauri host (`apps/gui/src-tauri`, crate `cannet-gui`) **is
buildable in a fresh Linux sandbox** — it just needs the system
libraries from README § Prerequisites → Linux, e.g. on Ubuntu/Debian:

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
    libsoup-3.0-dev libjavascriptcoregtk-4.1-dev build-essential
```

After that, `cargo build -p cannet-gui`, `cargo test -p cannet-gui`,
and `cargo clippy -p cannet-gui --all-targets` all work. A `gdk-3.0` /
`webkit2gtk-4.1` pkg-config failure means those libs aren't installed
yet — install them; it is **not** a blocker, so don't report it as one.

Frontend-only checks need no system libraries: `pnpm --dir apps/gui
install` once, then `pnpm --dir apps/gui test` and `pnpm --dir apps/gui
build`.

For the `servers/cannet-python-can` sidecar, always use `uv` to run and
test — never `pip install` into the venv. The committed `.venv` is the
runtime venv and deliberately omits dev tools; the `dev` extra in
`pyproject.toml` carries pytest/mypy/ruff. Use `uv run --extra dev <cmd>`
(e.g. `uv run --extra dev pytest tests/...`) for anything needing dev
dependencies, and plain `uv run <cmd>` for runtime.

## Planning

The `plans/` directory is the source of truth for what we're building and in
what order. Treat it as living documentation, not historical record.

- **`plans/features.md`** — the target feature set. Edit when scope changes.
- **`plans/tasks/roadmap.md`** — the ordered list of outstanding work and
  the canonical implementation order. Each item is a **task** whose detail
  lives in its own file under **`plans/tasks/`** (`NNNN-description.md`:
  scope, design questions, exit criteria). Don't start a later task before
  the current one meets its exit criteria, and don't quietly expand a
  task's scope — if something needs to move, update the roadmap (and the
  task file) first. Completed tasks are removed from the roadmap (the
  detail stays in git history), so it lists only outstanding work.
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

## GUI architecture: thin views over a paged model

**The GUI provides _views_ into a host-side data model. It does not
own the data.** The Rust host (`apps/gui/src-tauri`) holds the
capture, the decoded-signal caches, the system log — the model. The
React frontend renders windows onto it.

This is not a stylistic preference; it is what keeps the tool usable
at the data volumes it targets. The rules that follow are binding for
every new feature:

- **Any view over timeseries data must page.** Fetch only the slice
  the viewport shows (plus a bounded prefetch margin) through a paged
  Tauri command. Never hold the whole dataset — or an array that grows
  with capture length / session time — in frontend state. The
  chronological trace (LRU chunk cache in `App.tsx`), the filtered
  trace (`useFilteredTrace`), and the plot panel (`PlotPanel`'s
  visible-window resample) are the reference implementations.
- **Domain computation belongs in the model.** Decoding, aggregation,
  rate estimation, time↔index mapping, min/max and other statistics
  are the host's job. The frontend may shape already-paged data for
  the specific renderer it feeds (e.g. merging series for uPlot), but
  it must not re-derive model facts in JS.
- **Frontend state is view-local.** Scroll position, column layout,
  expanded rows, toggles — yes. Capture data, derived model state —
  no.
- **Trace renderers (the row table and the plot) share one timing
  model.** A trace is a series of messages with its own start time;
  the session buffer has the canonical timeline. See
  [`docs/adr/0024-trace-like-view-timing.md`](docs/adr/0024-trace-like-view-timing.md)
  for the rules — they govern any new trace renderer too.

**Be on the lookout for drift.** When you touch GUI code, check it
against these rules. If you find a view that holds too much, computes
what the model should, or accumulates unboundedly, fix it as part of
your change if it is in scope — otherwise add it to
`plans/backlog.md` (the running list of things noticed in passing).
Treat a code-vs-principle mismatch the same way
this document treats a doc-vs-code mismatch: don't leave it silently
inconsistent.

## File formats

**No sidecar files.** Data that logically belongs to a file lives
inside it, using the format's own extension mechanism when one exists
(DBC's `BA_` custom attributes, BLF's `GLOBAL_MARKER` records, etc.).
We do not create separate companion files alongside a format file to
carry project state. See [`docs/adr/0010-no-sidecar-files.md`](docs/adr/0010-no-sidecar-files.md)
for the rule, the rationale, and the options when a format library
doesn't yet expose the extension mechanism we need.

BLF specifics: logical bus assignment is conveyed by the ordered
project bus list mapping 1:1 to BLF channel numbers — channel index
`N` corresponds to `project.buses[N]`.

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
- **Source code references ADRs only — never plan docs.** Comments and
  rustdoc may cite an ADR (the durable decision) but must not point at
  anything under `plans/` (the roadmap, task files, backlog,
  technology-inventory) or name a task number. The roadmap and tasks
  track state and churn, so a code reference to them rots; ADRs record
  what _is_. When a comment needs rationale, cite the ADR or state the
  reason inline.
- Every phase has a documentation deliverable as part of its exit
  criteria: the README reflects what now ships, `plans/` records what
  changed and why, and rustdoc covers any new public API. A phase is
  not done until its docs match what the code does.
- When you spot a doc-vs-code mismatch, fix whichever is wrong in the
  same change — never leave them inconsistent.

## Completing the plan as documented

Follow the roadmap, in order. When reality forces a change:

1. Update `plans/tasks/roadmap.md` and the relevant `plans/tasks/NNNN-*.md`
   file (and any other affected planning doc) **before** writing code that
   diverges from it.
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
