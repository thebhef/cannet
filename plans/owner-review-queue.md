# Owner review queue

An index for the owner to walk when time allows — detail stays in the
task files' status logs; this points at it. A resolved item is
**deleted** (record the ruling in the task file first; git history
keeps the queue's copy). This file shrinks every time it is walked.

## 1. Behaviour changes needing a yes or no

- **The ruff locks aligned DOWN to 0.15.16** — *not accepted* (owner,
  2026-09-21). The 0.16 uplift lands as its own branch absorbing the
  ~200 mechanical fixes, with a `[tool.ruff.lint] select` stanza so
  the rule set can't drift again; the two judgment calls (the 50
  deliberate `noqa`s, the 5 silent teardown paths) are decided there.
  Noted for now, not scheduled. Detail: 0136 § Status log, 2026-09-16.

- **The unified enum-lane serve will still lose a held code under
  ~1.5 pixel columns**, where the categorical reducer lost none. The
  ruled fix (first and last beside min and max) takes the worst-case
  loss from 3.21 columns to 1.49; the residual is the *pyramid fold's*
  min/max, and closing it measures **worse**, not better (4.78 columns
  lost, 2.3x the pyramid), because a fatter level makes the serve read
  a coarser one. Accept the 1.5-column boundary, or reopen? Detail:
  0146 § Status log, 2026-09-20 phase 1.

- **An enum lane's tiles now draw *under* the line and its markers**,
  with only the labels held back to draw over. The ruling said "the
  lane is an overlay; the enum value is plotted under it", and the
  exit criterion said a lane's markers are uPlot's *and* legible over
  the tile — which cannot both hold, because a marker under a
  0.65–0.75 alpha tile measures 1.8:1 against it on a light theme
  against the project's own 3:1 bar. Legibility won. Confirm, or say
  the tiles must stay in front and the markers go back to a pass of
  their own? Detail: 0146 § Status log, 2026-09-20 phase 2.

- **A lane under `Points: auto` loses its exemption from uPlot's
  density rule.** With the private marker pass gone, a slow lane on a
  shared enum-lanes axis is governed by the axis's merged density and
  the minimum-sample-count floor, exactly as a slow line on a shared
  axis is — where before a lane was always marked. That is what
  "marked exactly like a numeric stepped series" means, and it is a
  visible change to `auto`. Detail: 0146 § Status log, 2026-09-20
  phase 2.

- **A wide `ΔH` chip is clipped at the plot box's edge.** The H1/H2/ΔH
  readouts moved into the y gutter (~52 px) per the cursor-chrome
  ruling, and deliberately do not widen it — a gutter that grew with a
  transient reading would slide every plot box in the stack sideways as
  the cursor was placed. So `ΔH` plus a long value loses its tail. The
  full value is in the side panel and the measurement strip. Accept, or
  want it elsewhere? Detail: 0146 § Blockers / side effects.

- **Project caches row: the auto-located explanation sits only on the
  `auto-located` badge.** An open project that is itself auto-located
  wears the `active` badge and gets no tooltip saying its directory is
  in cache space — which was the row behind observation 3. The phase
  judged the row's `Save as…` tooltip enough. Extend the tooltip to
  every `auto_located` row (one condition in `ProjectCachesList.tsx`),
  or accept? Detail: 0150 § Status log, 2026-09-21 phase 2.

## 2. Fix on this stack (owner-ordered 2026-09-16)

- Bring `plans/release-notes.md` up to date with everything on the
  stack (it is tracked, contrary to the earlier entry).

## 3. Fix later

- TLS end-to-end coverage — a TLS-terminating debug identity in
  `cannet-server`; goes to a new or existing task targeting that
  area. (136-1)
- Session-scoped pyramids — persist per-kernel resume state beside
  the level files + park on redefinition. Review at close-out with a
  reopen-recompute number, which is still owed: 135-3's math case
  measured only the steady-state cost (host +6.5 MB mean, tree
  +18 MB peak, flush mean 3.0 → 3.4 ms, timing family unmoved).
  (135-1, flagged 2026-09-06)

- The GUI's `servers.json` writer **drops JSON keys it doesn't
  know** on every write; the new CLI writer preserves them. Safe in
  today's direction (the GUI owns the schema) but the asymmetry
  bites the day the store grows a field an older GUI build rewrites
  away. GUI-side fix, some later task. (0144 § Status log)

- **145: the server token gate is per-service now**, not a server-wide
  `Server::layer` — `ServerInfo` must answer without a credential and
  a tonic interceptor cannot see which service a call is for.
  `crates/cannet-server/tests/auth.rs` holds the line (every gated RPC
  refuses an absent or wrong token; `ServerInfo` answers with
  neither). Detail: 0145 § Blockers / side effects.
- **145: `grpcio-tools` dev pin `>=1.80,<1.81`** on `task136-core-bus`:
  the wire package's lock had resolved 1.84 while the committed gencode
  came from 1.80; the new drift check exposed it. Inventory entry
  records the rule. FYI only.
- **145: CI runs no `cargo fmt --check`**; only the pre-commit hook
  does, which `--no-verify` skips. `interfaces.rs` had drifted once
  (fixed on `task145-server-info`). A one-line CI job would close it.

## 4. Finished tasks awaiting acceptance

- **Task 136 — python-can Cannet Client** (2026-09-06): both phases
  landed (`task136-core-bus` → `task136-clock-detect`); all 7 exit
  criteria met (verdicts in the task file). TLS e2e-coverage caveat
  above stands.
- **Task 137 — Log Export** (2026-09-06): all four phases landed
  (`task137-templates` → `task137-export-dialog` → `task137-loggers`
  → `task137-file-grid`); all 6 exit criteria met (verdicts in the
  task file). Caveats: live 500 MB split unit-tested only; open §2
  items above.
- **Task 135 — Plot Math Functions** (2026-09-06): all three phases
  landed (`task135-engine` → `task135-editor` → `task135-surfaces`);
  exit-criteria verdicts in the task file — 7 of 8 met clean,
  criterion 2 met in-session with the owner-flagged session-scoped-
  pyramid deviation (§ 3) as the one open ruling. Task-final full CI
  matrix green (3348 frontend / 1913 workspace tests).
- **Task 139 — Units and Scaling for Math Signals** (2026-09-07): all
  phases landed (`task139-units` → `task139-editor` → `task139-panel`
  → `task139-derive` → `task139-apply`); all 17 exit criteria met
  (verdicts in the task file). Task-final full CI matrix green on
  139-6 (re-run after the 2026-09-08 bench fixes: 3444 frontend /
  1233 host lib). § Blockers carries the two FYI behaviour notes (untargeted integrations read `A·s` not `coulomb`; a like-kind
  mixed set now converts — `1 A + 500 mA` reads 1.5, per exit
  criterion).
- **Task 144 — cannet-client CLI** (2026-09-18): both phases landed
  (the `clients/` move absorbed into `task136-core-bus`;
  `task144-client-cli` inserted above `task136-clock-detect`); all 5
  exit criteria met (verdicts in the task file). 138/1 client tests,
  python-only diff. Pinned-but-down refusal confirmed 2026-09-21.
- **Task 140 — Project State Items** (2026-09-08): single phase landed
  (`task140-controls`); all 5 exit criteria met (verdicts in the task
  file). Frontend-only diff; scoped lanes green (3447 frontend).
- **Task 147 — Collapse Database Items Under a Filter** (2026-09-20):
  single phase landed (`task147-collapse-under-filter`); all 6 exit
  criteria met (verdicts in the task file). Frontend-only diff; scoped
  lanes green. Review fix folded in: the auto-expand seed no longer
  refires on the RBS value poll.
- **Task 148 — Connect With a Bus Set to No Interface** (2026-09-20):
  single phase landed (`task148-no-interface-binding`); all 6 exit
  criteria met. Schema v8. Review fixes folded in: project-graph
  phantom node, bus-health wording, ev-zonal bump.
- **Task 145 — An Explicit Wire Protocol Version** (2026-09-20): both
  phases landed (`task145-server-info` below `task136-core-bus`;
  amendments to `task136-core-bus` and `task144-client-cli`); all 5
  exit criteria met. Full CI matrix green at the tip after the
  restack, `buf breaking` and gencode-drift jobs proven to bite.
  § 3 carries the per-service token gate and the `grpcio-tools` pin.
- **Task 142 — Fzf Filter in the Trace Panel** (2026-09-20): both
  phases landed (`task142-host-fuzzy` → `task142-trace-filter-panel`);
  all 7 exit criteria met (verdicts in the task file). Golden vectors
  pin identical order and scores against the TS `fzf`. Diacritic
  boundary accepted 2026-09-21.
- **Task 146 — A Round of Plot Fixes** (2026-09-20): four phases
  landed as five branches (`task146-lane-investigation` →
  `task146-markers-host` → `task146-markers` → `task146-gutters` →
  `task146-panel-plumbing`); all 8 exit criteria met, the perf number
  from the single tip reading (31/31 gated metrics passed; task file
  § Status log). § 1 carries the tile layering, the `Points: auto`
  lane exemption, the ~1.5-column held-code boundary and the wide ΔH
  clip. Two fix branches followed (2026-09-21): `fix-plot-hover-overlay`
  and `fix-plot-square-markers`, after the owner reported `Points: On`
  unusable on a long trace; owner verified the pair on that project the
  same day (detail: 0146 § Status log, 2026-09-21).

- **Task 150 — The Project Caches List Names Its Projects**
  (2026-09-21): both phases landed (`task150-settings-refresh` →
  `task150-cache-rows`); all 8 exit criteria met (verdicts in the task
  file). Task-final full CI green (3608 frontend, workspace host). § 1
  carries the badge-tooltip scope question; the owner's hands-on check
  of scroll, re-measure and Save As is still owed.

## 5. Housekeeping owed at close-out

- Perf series review + baseline fold-in (owner ruling 2026-09-06:
  collect during the campaign, never gate; judge the series at
  close-out). Watch `tx_late_ms_max` in that read: it straddles its
  55.7 ms limit on an unchanged 139-6 build (six runs, 9.5–85 ms)
  the diff can't reach.
- **Review the tiered-verification scheme** (owner, 2026-09-06): the
  `implement-phase` § 3 rewrite — scoped per-phase checks, full
  matrix once per task — gets reviewed at this campaign's close-out:
  did anything slip through a scoped phase to the task-final run, and
  is the tier split right?
- **Re-apply the parked ev-zonal layout autosave** on the stack tip:
  `git apply <scratchpad>/ev-zonal-autosave.patch` (a full copy of the
  file is beside it). Overseer holds the path; it is the owner's
  undispositioned edit, not part of any branch.
- **Re-lock the sidecar and client lockfiles** after the `grpcio-tools`
  pin (0145): `servers/cannet-local-sidecar/uv.lock` and
  `clients/cannet-python-client/uv.lock` still carry the wire package's
  old `>=1.80` `requires-dist`; a plain `uv run` re-locks the sidecar
  one (one line). Belongs on `task136-core-bus` as an amend + restack;
  CI's `uv sync --frozen` does not catch it. Patch parked in the
  overseer's scratchpad.
- **Retire tasks 142, 145, 146, 147, 148 from the roadmap** once
  accepted (§ 4), and dispose of the tip perf report
  `docs/performance-measurements/frontend/2026-09-20-25ffdf9e-feedback-tip-run1.json`
  (fold into the series review above or delete).
- **0146's phase-4 status log** carries the tip perf reading
  (uncommitted edit on the tip, for the close-out planning commit).

