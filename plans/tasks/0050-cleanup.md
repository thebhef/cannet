# Task 50 — Cleanup and Usage Fixes

Loose ends carried out of task 48, plus a further round of defects and
small features found by using the app.

They share no design and gate nothing. Land them independently, one
commit each, and strike each as it goes.

## 1. Show progress while a cold signal cache builds

Carried from task 48 item 2. **Decided: show progress.** Not warming the
pyramids on reload, and not persisting a manifest.

After a disk-cache reload the decimation pyramids are cold, so the first
`sample_signals` for a given signal set builds them on demand — seconds
on a real capture. This is by design: a pyramid is derived state that
carries no reopen manifest, and `SignalCacheStore::new` wipes its root on
every launch (`apps/gui/src-tauri/src/signal_cache.rs`), so it is rebuilt
by re-decoding the reopened raw frames. **That design is not changing** —
persisting a manifest would have amended ADR 0002 and put a correctness
burden on reopen, and warming only helps signals a restored panel names.

So the wait stays; what changes is that the user can see it. A plot area
waiting on its first sample must say so rather than showing a blank
canvas that is indistinguishable from "no data" or "hung".

**Decided: an indeterminate indicator, gated behind a short delay.**
Frontend only — no host-side progress reporting, no new IPC. A
determinate percentage was rejected because the host discovers the work
while decoding rather than knowing it up front, so it would have to grow
a progress channel to answer "how much longer"; that cost is not worth it
for a wait the user is not blocked by.

The delay gate is the load-bearing half, not a refinement: because this
fires on **every** signal add against a large buffer (see below), an
indicator with no threshold would flash on sub-100 ms adds and read as
jitter rather than information. Only an area whose first sample has not
landed within roughly 300 ms should say anything.

Two facts from task 48 item 12's profiling that bear on the design:

- **Host latency is not on the UI thread.** In a CPU profile of the
  shipping app under a heavy plot, `fetch` — every host round-trip the
  panel makes — was 0.6 % of the main thread. So the window stays
  responsive throughout; the progress indication is about informing, not
  about unblocking.
- **The first fetch after *any* signal-set change is a whole-window
  one.** Changing an area's signal list re-anchors `useDecimatedRange`'s
  cache, which clears `base` — and with no `base` the request carries
  `fromSeconds`/`toSeconds` of `null`, i.e. the whole window at full
  point budget. So adding one signal to an N-signal area pays a cold
  whole-window sample of all N + 1. That means this indication fires on
  every signal add against a large buffer, not only after a reload.

## 2. Restore the commit gate — surgically

The full test suites were dropped from `.pre-commit-config.yaml` so a run
of small fixes would not pay a whole-workspace test run per commit.
`cargo test --workspace` is gone and the frontend hook runs `pnpm build`
without `pnpm test`. CI still runs both per-PR, so nothing is unguarded —
but the local gate is weaker than it reads.

**Restore it surgically. Do not revert.** A blanket `cargo test
--workspace` on every commit touching a `.rs` file is what made this
worth removing; putting it back reintroduces the problem. The gate should
run the smallest set of tests that could actually be broken by what is
staged.

Directions worth taking, to be measured rather than assumed:

- Scope the Rust run to the crates a commit touches, rather than the
  workspace.
- `cargo nextest`, which parallelises and reports better than `cargo
  test` — a technology-inventory decision, so record it either way.
- `cargo clippy --all-targets` is already in the gate and already builds
  every target, so the marginal cost of running the tests may be only
  linking and execution. Measure that before assuming a test run is
  expensive.
- The same question for the frontend: vitest over changed files versus
  the whole suite.

The comment in `.pre-commit-config.yaml` explaining the trade-off must
match what the hooks actually do when this lands.

## 3. The shared-x-window plot test is flaky

`PlotPanel.dom.test.tsx` — "slides the shared x window once per frame,
not once per area". Timing-sensitive around rAF coalescing.

Seen failing on an unchanged re-run during the settings review pass
(2026-08-03), and again at roughly **2 in 5 full-suite runs** during the
task 48 work — so it is not a once-off, and it flakes often enough to
train people to ignore a red suite, which is the real cost.

**Nobody has established whether the test or the coalescing is at
fault**, and that is the first question: a test asserting a
once-per-frame invariant against a real rAF is a plausible bad test, and
a coalescer that occasionally slides twice is a plausible real bug. Find
out which before changing either.

## 4. Constant signals still get a degenerate plot scale

Task 48 item 8 let a constant signal's degenerate extent (`hi == lo`)
into its unit group's union, which fixed the case where a constant was
dropped from a group that had other signals in it. **A signal that is
constant for the whole plot duration is still wrong**: it draws on a
0.0–1.0 axis with the trace sitting in the middle, which says nothing
about the value.

A constant signal has no span, so any scale is a choice rather than a
measurement. **Give it a minimum range — at least ±10 % around the
value** — so the axis labels read as the value it actually holds.

Decide what ±10 % means for a value of exactly zero, where a proportional
band collapses; that case needs an absolute fallback.

This is ADR 0026 territory (per-unit axes); if the rule it records needs
to say something about constant signals, it changes in the same commit.

## 5. Collapsible sections in the project view

`ProjectPanel` already renders six `<section class="project-section">`
blocks with `<h3>` headers — Project, Elements, Logical buses, Virtual
buses, Connection, DBC. They just do not collapse. Make them collapsible.

Alongside that: **group the Elements section's contents by type** —
trace, plot, signals, and so on. This is sub-structure *within* one
existing section, not a reorganisation of the panel; the type groups get
their own headers and collapse the same way the outer sections do.

Assumptions taken rather than asked, correct them if wrong: collapse
state persists in the workspace scope alongside the rest of the layout
(ADR 0042 §3), because a panel that forgets what you folded away is
worse than one that never folded; and the type grouping replaces the
flat list rather than being a toggle, since a toggle implies two layouts
to maintain for a panel this small.

Task 48 item 5 fixed this panel's scrolling because it was unusable at
1024 px vertical. Collapsing is the other half of that fix.

## 6. Rename should rename in place

The `panel.rename` command ("Rename panel…") sends the user to the
project view to do the rename. It should rename in place — the panel's
own dock tab title becomes editable where the user already is — and
leave them where they were.

## 7. Audit every view for scroll correctness

**Confirmed symptom, and it is a known-unfixed defect.** Reviewing
captured (not live) data in the chronological trace, the last rows cannot
be reached: scrolling to the bottom stops short. That is precisely what
task 48 item 5 fixed in the by-ID panel — `maxAnchorRow` subtracts
`visibleRowCount`, whose two-row pad puts the anchor bound two rows
*past* the end — and explicitly did not fix here, on the grounds that the
chronological view's anchor interacts with auto-scroll and
`scrollForRow`. The same presentation was meant to be fixed alongside it.
So: apply `tailAnchorRow` here too, and deal with the auto-scroll
interaction that was the reason for deferring.

**Then widen it.** Scroll defects have now been found in the project
panel, the by-ID panel, the colormap panel, the trace table's horizontal
axis, the system messages view, and now the chronological trace — six
surfaces, four distinct mechanisms. That rate says the next one is not
far off. **Review every scrollable view**, and answer the question the
count raises: is there a base implementation — a shared scroll container
or viewport primitive — that would satisfy them all, rather than each
panel getting its geometry right independently?

If such a primitive exists, adopting it is the deliverable and the
individual fixes fall out. If it does not, say why in the record, because
the next reader will ask the same question.

Method is settled: jsdom does no layout, so measure in Chromium against
the real stylesheets or the live WebView2 host. Every one of the four
mechanisms found so far turned out not to be what the CSS suggested.

## 8. Put the version and project in the title bar

The About panel is the only place the version appears, and it is buried.

**Decided format** — project first, then the capture source, then the
app and version:

```text
ev-zonal — drive-cycle.blf — cannet 0.9.3     project + capture
• ev-zonal — drive-cycle.blf — cannet 0.9.3   unsaved changes
ev-zonal — cannet 0.9.3                       project, nothing loaded
ev-zonal — PCAN-USB — cannet 0.9.3            live connection
cannet 0.9.3                                  no project
```

The project name leads because it is what distinguishes one window from
another — it is what survives truncation in a taskbar hover or alt-tab
preview, where a title starting with the app name is identical for every
window. The **capture source segment is omitted entirely when nothing is
loaded**, so the title only grows when it has something to say.

The About panel stays: it carries build info and licences, not just the
version.

## Exit criteria

- Every item above is fixed or struck with a recorded reason, and this
  file is deleted when the list empties.
- Each fix lands with a test that fails before it — except item 3, whose
  deliverable is a test that stops failing intermittently.
- Item 4 changes ADR 0026 in the same commit if the per-unit axis rule
  needs to say something about constant signals.
- Item 2 records any new tool in `plans/technology-inventory.md`,
  adopted or rejected.
- Item 7 answers the base-implementation question explicitly — either a
  shared scroll primitive lands and the individual fixes fall out of it,
  or the record says why one does not fit. "We fixed the six we knew
  about" does not close it.
- Where jsdom cannot verify a layout claim, the record says so and the
  claim is backed by a Chromium measurement instead. No test that passes
  either way.
