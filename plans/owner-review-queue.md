# Owner review queue

An index for the owner to walk when time allows — detail stays in the
task files' status logs; this points at it. A resolved item is
**deleted** (record the ruling in the task file first; git history
keeps the queue's copy). This file shrinks every time it is walked.

## 1. Behaviour changes needing a yes or no

- **The ruff locks aligned DOWN to 0.15.16**, not up to 0.16.x: ruff
  0.16 *changed* its default rule set, and the uplift is ~200
  mechanical fixes plus two judgment calls (50 deliberate `noqa`s it
  would delete; 5 silent teardown paths it wants logging). Divergence
  is gone either way. Want the 0.16 uplift — plus a `[tool.ruff.lint]
  select` stanza pinning the rule set so defaults can't drift again —
  as its own task? Detail: 0136 § Status log, 2026-09-16.

- **`cannet-client connect` refuses a pinned server that is down**
  rather than offering it in the clear — the task text read
  "endpoint not speaking TLS → ask", but the GUI only asks on first
  contact, and asking here would make "server down" a route to
  dropping a server's protection. Mirrored the GUI; confirm or
  reverse. Detail: 0144 § Status log, 2026-09-18.

- **The Rust fzf port skips the package's diacritic folding**
  (`normalize: true`). Reproducing it needs either a new crate — which
  the no-new-crate ruling forbids — or ~700 lines of generated table.
  The reachable haystack (DBC identifiers, id spellings, ECU names) is
  ASCII; only a bus name with a diacritic would rank differently
  between the host matcher and the frontend's event matcher. Accept
  the boundary, or reopen the ruling? Detail: 0142 § Blockers,
  2026-09-20.

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
  python-only diff, §1 pinned-but-down item is the one open ruling.
- **Task 140 — Project State Items** (2026-09-08): single phase landed
  (`task140-controls`); all 5 exit criteria met (verdicts in the task
  file). Frontend-only diff; scoped lanes green (3447 frontend).

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
