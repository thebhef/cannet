# Task 167 — Calendar Time in Every View

> **Opened 2026-10-13** from feedback item 17; groomed 2026-10-14 (Q1,
> Q2 ruled). All three phases landed 2026-10-14; awaiting the owner's
> acceptance.

## Why

> global toggle to show real time in all views — signals, plots, traces
> — owner, 2026-10-13

## Survey (2026-10-13)

No view has a relative/calendar toggle. Every timeline view renders
elapsed time (`format.ts::formatTimestamp` / `formatElapsed`) as its
text; calendar time (`formatCalendarTime` through `date_time_pattern`,
ADR 0062) is hover-only in the trace, By-ID and event time cells and on
the plot's x ticks and A/B chips, and absent from the Signals panel's
time column, the plot x-axis label and the panel cursor readouts. ADR
0024's invariant — "rendered time is `frame.timestamp − session_start`,
everywhere" — is what a toggle amends. A host setting is one
`settings.rs` field + one `settings_descriptor.rs` spec +
`hostSettings.ts` mirror; no command palette command toggles a setting
today (it would be the first). Without a wall-clock anchor
(`hasWallClockAnchor`) the toggle has nothing to show.

## Grooming (2026-10-14)

Proposed design, standing unless ruled otherwise: one host setting
`time_display` = `elapsed` (default) | `calendar`, user-overridable
like `can_id_format`, with a settings-panel control and a command
palette command "Toggle calendar time" (the first command to write a
setting; `updateSettings` exists). Trace, By-ID, Events and Signals
time cells, the plot's x ticks, x-axis hover label, A/B chips and the
panel cursor readouts switch together; Δt stays a duration. No
wall-clock anchor (`hasWallClockAnchor` false): everything stays
elapsed and the settings control says why. Logger grid, System
Messages, BLF modal, export From/To syntax and file-name templates are
untouched (ADR 0062 § 5). ADR 0024 rule 2 is amended to "one timeline,
one instant, two readings chosen app-wide".

**Q1 — plot x ticks in calendar mode. Ruling (owner, 2026-10-14):**
option A — ticks read time-of-day, fraction digits from the span
(`fracDigitsForSpan`), leading fields the whole window shares dropped;
the **date lives in the x-axis time string**, which adapts to how many
dates the window shows:

> "Time on <date>"; "Time on <date1> and <date2>"; "Time between
> <start date>, <end date>". — owner

One date → `Time on <date>`; two → `Time on <d1> and <d2>`; more →
`Time between <d1>, <d2>`. The hover tooltip keeps the full
`date_time_pattern`.

**Q2 — a table time cell (trace, By-ID, Events, Signals) in calendar
mode. Ruling (owner, 2026-10-14):** "Put the whole date string in and
append the .ffff precision." The cell renders the full
`date_time_pattern` and appends the fraction the elapsed column shows
today (`.ffff`, the same digits). Overseer's reading, to confirm in the
phase: a pattern that already carries `S…` fraction fields is not given
a second one. The hover swaps to elapsed time.

## Phases

Branches beneath `doc-closeout-2`, sequential in the shared tree.

1. The setting and the formatters — `time_display` host setting,
   palette command, `format.ts::formatCalendarCell` /
   `calendarWindow`, ADR 0024 amended — Opus, `task167-time-display`.
2. Table consumers — trace, By-ID, Events, Signals time cells read
   `formatCalendarCell` in calendar mode; hover swaps to elapsed;
   Signals gains the hover — Sonnet, `task167-tables`.
3. Plot consumers — x ticks, the x-axis title, hover label, A/B chips,
   panel cursor readouts via `calendarWindow`; Δt stays a duration —
   Sonnet, `task167-plot`.

## Exit criteria

- [x] `time_display` setting (elapsed | calendar), settings-panel
      control, palette command "Toggle calendar time"; a relative
      timeline stays elapsed under either value. (phase 1, f02433f4)
- [x] `formatCalendarCell` and `calendarWindow` in `format.ts`, exact
      vectors; ADR 0024 rule 2 amended, CONTEXT.md **Time display**.
      (phase 1, f02433f4)
- [x] Trace, By-ID, Events and Signals time cells read calendar time
      under the setting, the hover shows elapsed; same frame, same
      string, in all four. (phase 2, 3f042314 — one shared cell)
- [x] Plot x ticks, x-axis title ("Time on …"), hover label, A/B chips
      and panel readouts read calendar time under the setting; Δt stays
      a duration; the README's settings entry no longer says "none
      reads it yet". (phase 3, eaa65a22)
- [x] Each phase: six-job local CI green, `comment-references` grep
      clean. (Rust lanes on phases 1 and 3, frontend on all; Python,
      proto, oracle and freeze lanes unreachable by every diff)

## Status log

- **2026-10-14 — Phase 1 landed on `task167-time-display` @ f02433f4**
  (single commit; c395825b before the trailer amend). Setting
  `time_display` (`elapsed` | `calendar`, user-overridable) declared
  like `can_id_format` — SCOPES, field, default, validation, an
  Enum/General/Behaviour descriptor rendered by the generic select, the
  `hostSettings.ts` mirror; Rust test for default / refused / accepted.
  Palette command `view.toggleCalendarTime` flips it through
  `updateSettings` (the first command to write a setting); jsdom test
  on the real `useCommands`. Formatters in `format.ts` with 15
  exact-string vectors (UTC and Asia/Tokyo): `formatCalendarCell` —
  whole pattern plus truncated `.ffff`, none appended when the pattern
  has an `S` field (Q2 reading confirmed against the parser);
  `calendarWindow` — tick pattern `mm:ss` within one local hour (same
  offset, DST-safe) else `HH:mm:ss`, plus `fracDigitsForSpan` digits;
  title "Time on <d>" / "Time on <d1> and <d2>" / "Time between <first>,
  <last>" with dates through the pattern's date part (`yMdE` run,
  literals kept only between two date fields, `yyyy-MM-dd` fallback).
  Both `null` without a wall-clock anchor. Ticks are always 24-hour
  `HH`, even for an `h a` pattern. Instants rounded to the microsecond
  (float64's resolution at epoch magnitude) — 7–9 tick digits read
  `000`; a phase 3 concern only if sub-ms ticks matter. ADR 0024 rule 2
  and first invariant amended; ADR 0062 status lists the formatters;
  CONTEXT.md **Time display**; README settings entry (says no view
  reads it yet). No view touched. Vitest 3903/3903, build, `cargo test
  -p cannet-gui` 1450 passed, clippy, fmt, rustdoc clean; Python, wire,
  MDF-oracle and freeze lanes unreachable. 12 files, +491/−13. Two
  readings queued for the owner (§ 1): the appended fraction after a
  pattern whose last field is not `ss`; calendar cells truncate while
  `formatElapsed` rounds.

- **2026-10-14 — Phase 2 landed on `task167-tables` @ 3f042314**
  (single commit). Trace, By-ID, Events and Signals time cells share
  one `TraceTimeCell` (`traceTable.tsx`), which reads
  `date_time_pattern` and `time_display` itself through `useSetting`
  (re-renders through the memoised rows; no row component carries them
  as props — the `datePattern` plumbing in TraceView, EventRow and
  ByIdTable is gone). Under `calendar` it renders
  `formatCalendarCell(seconds, base, pattern, ELAPSED_FRAC_DIGITS)`,
  falling back to elapsed on a relative timeline; the hover swaps
  (elapsed over a calendar cell, calendar over an elapsed one; no
  tooltip without an anchor). `cellContent`'s `time` case returns
  null (only the two row renderers call it). The Signals panel gains
  the cell and with it the hover. `ELAPSED_FRAC_DIGITS = 4` exported
  from `format.ts`, the default of `formatElapsed`. README settings
  entry: tables read it, plot follows. ADR 0024 unchanged. Tests
  written after the code (not red-first): `traceTimeTooltip.dom` block
  for trace/By-ID/events in both modes and the relative fallback;
  `SignalsPanel.dom` both modes. Vitest 3911/3911, build, grep 0
  hits; Rust/Python/oracle/freeze lanes unreachable. 8 files,
  +164/−68. Prettier warned on the touched files; it is neither a CI
  job nor a hook here, so not a gate.

- **2026-10-14 — Phase 3 landed on `task167-plot` @ eaa65a22** (single
  commit). Under `calendar` with a wall-clock anchor: x ticks read
  `formatCalendarCell` with `calendarWindow(...).tickPattern`, resolved
  once per draw by `xTickLabels` (the tick-spacing width function uses
  the same labels); the axis title is `calendarWindow(...).title` in
  the existing overlay-drawn x-axis label slot (ADR 0026) — no new
  chrome — with the hover appending the time of day; A/B chips and the
  panel cursor readouts go through one `plotTimeText` (the calendar
  cell at the ticks' digits), Δt stays `formatDurationSeconds`;
  `timeHoverTooltip` takes a `timeDisplay` argument and returns elapsed
  in calendar mode (the tables' swap). `calendarAxis(base, mode,
  pattern)` is `null` in elapsed mode or without an anchor, so those
  paths are unchanged and the old tests passed untouched. The reading
  is a ref read by the uPlot closures; an effect on base and pattern
  re-labels (`redraw(false, true)`) and repaints the overlay. Tests
  red-first in `PlotArea.draw.test.ts` (ticks + fallback, title for
  one- and two-day windows with and without hover, relative fallback,
  chips with Δt unchanged, `plotTimeText`, tooltip swap);
  `PlotPanel.fmtPos` not dom-tested (a one-line call to the tested
  helper). README Time display entry covers the plot; one CONTEXT.md
  line under **Date/time pattern**. ADR 0024 unchanged. Task-final CI:
  vitest 3920/3920, build, `cargo test --workspace` 2289 passed,
  clippy `-D warnings`, fmt, rustdoc clean, grep 0 hits; Python, buf,
  gencode-drift, MDF-oracle and freeze lanes unreachable by the task's
  whole diff. 5 files, +276/−25. Overseer note: the title and tick
  labels re-resolve `calendarWindow` (a pattern parse) per pointer-move
  repaint — small, on the overlay path; the owed perf reading is the
  check.

- 2026-10-19 — **Owner ruling (queue § 1): the appended fraction stays
  exactly as Q2 specced** — the whole pattern, then `.ffff`, whatever
  the pattern's last field is; no override of the pattern the user set
  ("I didn't spec that"). The recommendation to drop the fraction after
  a non-seconds pattern is withdrawn. The rounding question (elapsed
  rounds, calendar truncates) is re-put in plain words.

- 2026-10-19 — **Owner ruling (queue § 1): elapsed and calendar both
  round.** "I'm inclined to 'both round' instead of 'both truncate'.
  should be consistent though." Go given the same day. Phase 4: ADR 0062
  § 1 amended (fractions round), the `format.ts` calendar formatter and
  the host's `date_pattern.rs` round the instant to the fraction's
  digits before splitting fields (a carry into the next second, minute
  or day must be right); `formatElapsed` unchanged (it rounds already).
  Tests at the carry boundaries in both languages.

## Blockers / side effects

- **Perf reading owed (2026-10-14).** Phase 3 touched the plot's
  overlay and tick paths; no ADR 0031 reading (dongles + release host).
  Shares task 166's owed reading at the next cycle boundary.
- **FYI:** in calendar mode the A/B chips carry the whole pattern plus
  `.ffff` (Q2 applied to every table-like reading), so they are wide.
- **FYI:** ticks are always 24-hour `HH`, even under an `h a` pattern.
- Rounding ruled 2026-10-19 (both round) → phase 4.
