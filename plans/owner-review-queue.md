# Owner review queue

An index for the owner to walk when time allows — detail stays in the
task files' status logs; this points at it. A resolved item is
**deleted** (record the ruling in the task file first; git history
keeps the queue's copy). This file shrinks every time it is walked.

## 1. Behaviour changes needing a yes or no

(none)

## 2. Fix on this stack (owner-ordered 2026-09-16)

Owner rulings 2026-10-07 (queue walk) — each ordered fixed on this stack:

- **160 phase 2: the virtual bus behaves like a physical bus** — the
  bridge carries the `Tx` frames it pulls from the far side instead of
  dropping them. "This obviously breaks our expected behavior. Needs to
  get fixed." (0121 § Blockers → 0160 § Status log, 2026-10-07.)
- **146: an enum transition must survive zooming out** — done 2026-10-19
  on `fix-enum-transitions-zoomed-out` (2aef8efc): the serve decimates
  by time column and refines gaps from finer pyramid levels, so a code
  held one column or longer keeps its code at every zoom, and a narrower
  change leaves a one-pixel tick within a column of where it happened.
  Serve +6 %, pyramid unchanged, perf 31/31. Your check: a lane with a
  brief code inside a long hold, zoomed all the way out. Delete on
  acceptance. (0146 § Status log, 2026-10-19.)
- **151 follow-on: the units collection relies on SI prefixes** — the
  owner sees `mV, V, kV, MV` listed as separate units in the Units
  section; one base unit with prefixes is wanted. (0151 § Status log,
  2026-10-07.) Needs grooming (task 149's library is the surface).
- **153: iterate on search/filtering** — works as the owner wants in the
  Database and trace views "but is slow, and maybe could yield some
  results early." The haystack change itself is kept. (0153 § Status
  log, 2026-10-07.) Needs grooming.
- **The ruff 0.16 uplift** — done 2026-10-19 on `fix-ruff-default-rules`
  (eb744f6b, above the stack): ruff's own default applies under the
  `>=0.16,<0.17` pin, 379 findings fixed, no `ignore`, no `noqa` (the
  41 catch-alls log their traceback instead; module loggers renamed
  `_log` → `_logger`). Delete on acceptance. (0136 §
  Post-completion notes.)
- **A failed manual send is reported** — done 2026-10-19 on
  `task160-failed-send-feedback` (fa96488d): a system-log warn row on a
  refused manual send, refused periodic batch, or failed Duplicate; a
  warning mark on the frame's row in the transmit panel until its next
  accepted send. Your check: send once on a frame whose bus is not
  connected. Delete on acceptance. (0160 § Status log.)
- **The closing window says it is writing the capture on every exit**,
  even when the project was opened from its cache and nothing was
  captured (owner, captured by hand). `closing.rs::run_shutdown` flushes
  unconditionally unless *Clear scratch cache on exit* is on; no
  "nothing changed since load" check exists. Not started.

## 3. Fix later

- **A PEAK channel in an ack storm hears everything 6–16 s late**
  (163 phase 9b, 2026-10-06, trials 4–12): ~80 k error frames queue in the
  PEAK driver during a pull, the rx pump reads ~2.5 k/s, so the channel's
  delivery runs behind wall clock by the backlog until it drains. ADR
  0060 capped error *rows*, not frames *read*. Candidate: the Vector
  precedent at the driver — `PCAN_ALLOW_ERROR_FRAMES` off once an episode
  passes the row cap, on again when the controller leaves passive/bus-off.
  Awaits the owner: groom as a 163 phase, or a later task.

- **A reopen does not reset the published state** (bus-off backstop and
  queue-full reopen alike): a stale error-passive stays shown until the
  fresh channel's first poll (0161, 2026-10-04).

- **Possible flaky test** — `PlotPanel.dom` "moves the crosshair and
  places a cursor without one series repaint" failed once in a scoped
  run during 166 phase 2 (2026-10-14) and passed on re-run with no
  related change; two full-suite runs the same day were green. Not
  investigated. Awaits the owner: chase it (repeat-run under load) or
  watch.

## 4. Finished tasks awaiting acceptance

- **169 plot y scale** — `fix-plot-y-scale` 4797c8a3, beneath
  `doc-closeout-2`: a paused axis holds its range until Fit Y, Fit Data
  or a manual bound; Fit Y skips pinned axes; an "ignore manual y
  bounds" chip makes every axis automatic without clearing a bound,
  and the axis menu clears bounds or applies them again; a bound left
  by clicking away is kept; max listed above min.
  Follow-live unchanged (ruling 2026-10-20). Your check on the repro:
  pause, zoom — the axis stays; pin the axis, Fit Y — it stays; chip on
  — it fits with the rest; chip off — the bounds return.
- **Task 168 — Duplicate a Project Element** — #568 →
  #569 (ADR 0027 and ADR
  0050 amended; new host command `clone_transmit_frames`). Project
  panel → element row → Duplicate. All 4 exit criteria met 2026-10-14
  (0168 § Exit criteria). ADR 0050 sentence accepted 2026-10-19;
  the silent failure is § 2's reporting item.
- **Task 167 — Calendar Time in Every View** — #565 →
  #566 → #567 → `task167-fractions-round` 3869d814 (ADR
  0024 rule 2 amended; ADR 0062 status, then § 1 fractions round). Settings → General → *Time
  display*, or the palette's *Toggle calendar time*. All 5 exit
  criteria met 2026-10-14 (0167 § Exit criteria). The fraction stays
  as specced (2026-10-19); § 1 carries the rounding question; perf
  reading owed with 166's.
- **Task 166 — Plot Panel Fixes** — #561 → #562 →
  #563 → #564 (ADR 0026 and ADR 0045 amended).
  All 5 exit criteria met 2026-10-14 (0166 § Exit criteria). Your run
  is the check for three things jsdom cannot see: the label ellipsis in
  a real browser, the macOS Alt-drag copy and its cursor, and the
  straight line between samples on a mixed-rate axis. A perf reading is
  owed at the next cycle boundary (0166 § Blockers).
- **Task 165 — One Date/Time Pattern** — `task165-date-pattern`
  c0550d9d + `task165-date-setting` fb08a95c + `fix-logger-now-per-file`
  d7ec157a (ADR 0062; ADR 0024 rule 4 amended; logger `{now}` per file). Settings → General → *Date/time pattern*; the `{start:…}`
  tokens now take TR35 (`{start:yyyy-MM-dd}`), a saved strftime template
  reports an error until retyped. Exit criteria walked 2026-10-07, all
  met (0165 § Status).
- **Task 163 — python-can Usage Review and a Fault Model That Holds** —
  `task163-fault-measure` … `task163-recovery-docs` (12 branches, ADR 0060,
  ADR 0039 amended). Owner's bench failed 2026-10-05 (PEAK bus-off reset
  `PCAN_ERROR_INITIALIZE`); phases 9a–9c added the fault-recovery bench
  and close-before-open recovery, **bench-confirmed on PEAK 2026-10-06**:
  bus-off recovered 3/3, error-passive 3/3, stuck queue flushed (0163
  § Status, phase 9b). Phase 9d (verdict table, ADR wording, README,
  bench timeline) in progress; then PR checks after the owner's `gt ss`.
  Task 161's retest closes on the same runs.
- **Task 121 — The Trace Tells the Truth About the Wire** — `task121-echo-row`
  + the PEAK echo gate in `fix-pcan-counters-decay`; bench-confirmed
  2026-10-03. Open § 1 items (refused row's reach, bridge `Tx` drop) are
  160's, not blockers to acceptance.
- **Task 161 — A Bus-Off Controller Comes Back** — `task161-bus-off-recovery`
  + `fix-pcan-counters-decay` + `fix-pcan-busoff-visible`; bench-confirmed
  on PEAK 2026-10-03 for a short pull, then a long pull did not recover
  (fixed 2026-10-04, retest pending); Vector and Kvaser paths unverified
  on hardware.
- **142 — trace fzf filter**, reopened 2026-10-02 for owner feedback
  (the box gave no feedback while the host walked the index); phase 3
  landed 2026-10-03 on `fix-trace-filter-feedback` (`82693c13`):
  `searching…` then the host's match count, both modes; criterion 8
  met. Back to awaiting acceptance.

- **158 — bus-error markers page** (`task158-error-series` →
  `task158-plot-markers` → `task158-events-section` →
  `task158-episodes` → `task158-event-wall-time`; 5 phases): 9/9 met;
  **reopened 2026-10-02**; phase 6 landed the same day on
  `task158-plot-episodes` (`e7006038`, criterion 10 met: one plot marker
  per episode). Phase 7 (episodes join the Events list) to groom. Two
  § 1 items (the rate's burst gap; the episode extent at rest).

- **156 — Restore From Cache Does Not Crash on a Mapped Segment.**
  Three phases on `task156-restore-crash-investigation` →
  `task156-cache-lock` → `task156-closing-cue` (`3c39d590`), full CI
  matrix green (`wire-breaking` skipped as for 155). Your runtime
  check of the close path: done 2026-10-02. Diagnostic logging for
  growth failures groomed into task 157 on your order. Two behaviour
  changes from phase 2 are in § 1.
  Verdicts: 0156 § Exit criteria.

- **155 — The Kvaser Timer Wraps Without Losing Frames, and Drops Are
  Loud.** Three phases on `task155-kvaser-unwrap` → `task155-drops-loud`
  → `task155-logger-clamp` (`229f9ca6`), full CI matrix green (one lane
  skipped, `wire-breaking`: proto untouched, `buf` not installed). The
  live Kvaser confirmation: owner 2026-10-02, tested and fine. Verdicts:
  0155 § Exit criteria.

- **151 — the settings view's grids are gridviews** (3 phases,
  `task151-units-gridview` → `task151-caches-gridview` →
  `task151-servers-section`): 6/6 exit criteria met. `column-defaults`
  (a fixed ordering editor, not a view onto data) deliberately not
  converted. Two § 1 items (collapsed default, *Show servers*).

- **153 — enum values in the trace filter** (2 phases,
  `task153-host-gate` → `task153-panel`): 6/6 exit criteria met. The
  haystack change is a § 1 item. One reading for the record: a click
  on a row force-open under a signal or value winner records a full
  manual expand that shows only once the winner reverts (0153 § Status
  log, phase 2).

- **152 — nothing heavy in the foreground** (3 phases, `task152-shape-a`
  → `task152-listing-and-mirror`): 7/7 exit criteria met. Perf reading
  on the tip measured an idle bus (fps 0) — see 0152 § Blockers; one
  usable reading still owed at the stack tip.

- **Task 136 — python-can Cannet Client** (2026-09-06): both phases
  landed (`task136-core-bus` → `task136-clock-detect`); all 7 exit
  criteria met (verdicts in the task file). TLS integration test
  landed 2026-10-02 in `fix-fit-data-test-bound` (`1fd2136f`).
- **Task 137 — Log Export** (2026-09-06): all four phases landed
  (`task137-templates` → `task137-export-dialog` → `task137-loggers`
  → `task137-file-grid`); all 6 exit criteria met (verdicts in the
  task file). The live split: owner 2026-10-02, seen rolling over. Owner
  2026-09-22: manual BLF export works; the logger's listing defect
  (§ 3) is open against this task.
- **Task 135 — Plot Math Functions** (2026-09-06): all three phases
  landed (`task135-engine` → `task135-editor` → `task135-surfaces`);
  exit-criteria verdicts in the task file — 7 of 8 met clean,
  criterion 2's session-scoped-pyramid deviation ruled 2026-10-02:
  rationale rejected, task 159 persists them. Task-final full CI
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

## 5. Housekeeping owed at close-out

- Perf reports at the tip (2026-10-03, `60ee06cf`, four 60 s ev-zonal
  captures in `docs/performance-measurements/frontend/`): warm runs
  green on all 31 gated metrics; `tx_late_ms_max` sits at 33–59 ms vs
  a 15 ms stored baseline, but the same-day `main` control reads 31–35,
  so it is the machine, not the stack. Fold into `baseline.json` or
  delete at close-out; never promote without the owner.
- Perf reports at the new tip (2026-10-03, `e04f9087`, four 60 s
  ev-zonal captures, same files): all 31 gated metrics green on all
  four. Two shifts worth reading, both from 121 (the wire writes the
  Tx row): `tx_late_ms_max` **fell** 33–72 → 4–5 ms and `flush_ms_max`
  13–65 → 8 ms (the scheduler thread no longer appends a row per
  frame); `lag_ms_max` **rose** 2–6 → 7–17 ms warm (limit 40.8) and the
  host now ingests twice the frames (`hardware-peak ingest_fps`
  999 → 1999: each transmit comes back as an echo row). Memory flat
  (host 65 MB, renderer ~325 MB, tree ~750 MB). `tx_fps` 1603–1606
  measured from echoes — the PEAK echo arrives at full rate. Below the
  owner's stop threshold (not >10 ms across all runs); recorded, not
  acted on.

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
- **Dispose of the tip perf report**
  `docs/performance-measurements/frontend/2026-09-20-25ffdf9e-feedback-tip-run1.json`
  (fold into the series review above or delete).
- **0146's phase-4 status log** carries the tip perf reading
  (uncommitted edit on the tip, for the close-out planning commit).

