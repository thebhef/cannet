# Task 79 — Restore-Then-Import Leaves the View Empty + Scratch Isolation

Opened by owner ruling 2026-08-15 out of Task 78 phase 1's flake
attribution ("capture the new task"; scratch isolation folded in per
the same review).

## 1. The product defect

A launch that restores a prior scratch capture and is then driven
through a BLF import leaves the frontend's trace view empty while the
host store refills: status line "Open a BLF log or connect to a server
to begin" against a host log reading a fully-imported store, pyramids
wiped. A user reaches it by reopening the app and then importing a
trace. Attributed by task 78's phase 1 (task file retired — see its
status log in git history; 31-run experiment, p ≈ 0.00065): the screenshot-scenario
empty-plot flake was this defect photographed — **fit x axis** then
falls back to its `max = start + 1` degenerate axis. The fix shape
recorded there is the starting point; the harness guard landed in
`65e27674` already fails a capture scenario photographed against an
empty buffer, and stops guarding nothing once this is fixed.

## 2. Scratch isolation for harness runs

`--app-data-dir` moves `app_config_dir()` only; `resolve_project_dir`
reads `app.path().app_cache_dir()` directly, so every screenshot and
perf run shares one capture scratch with the operator's own sessions
and inherits what the last run left there — the reason §1 was
reachable from the harness at all, and a real gap against ADR 0031's
"`--app-data-dir` is the whole isolation mechanism". Make the flag
isolate the cache/scratch root too (or document and implement whatever
narrower mechanism ADR 0031 amends to), so a harness run neither reads
nor writes the operator's scratch.

## Owner ruling (2026-08-19)

Kept as scoped. The 2026-08-18 question of whether this is worth
implementing at all is closed: both halves stand, §1 as a
user-reachable defect and §2 because ADR 0031's isolation claim and the
implementation disagree, which is not optional to leave standing.

Note when it is picked up: tasks 86 and 27 both moved session
re-anchoring after §1 was attributed — task 86 item 2(c) cross-references
this task for "an import into a session whose start came from somewhere
else never re-anchors" — so re-run the reproduction against the tip
before implementing, to see whether the defect still presents in the
same shape.

## Exit criteria (draft — firm at grooming)

- The restore-then-import sequence shows the imported trace (the
  reproducing test from the attribution becomes the regression guard);
  the screenshot scenario's empty-frame rate goes to zero across a
  re-run batch.
- A harness launch under `--app-data-dir` reads and writes no
  operator-owned scratch; ADR 0031's isolation claim matches the
  implementation; tested.
