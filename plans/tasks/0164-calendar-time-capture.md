# Task 164 — A Calendar-Time Capture: Append, Add, Reload

> **Opened 2026-10-06** from the owner's concept, groomed the same day
> (rulings below). Not started.

## Why

> New concept: calendar-time-based global buffer. Allow continuing the
> global buffer from a previous session — allows us to disconnect/
> connect or tolerate a crash or reboot. Allow loading of timestamped
> timeseries data into the session buffer via import. Multiselect in
> the logger view; context menu → reload all, attempt to load all
> using timestamps. — owner, 2026-10-06

The capture already lives on one calendar axis: every frame carries
absolute epoch nanoseconds, the session has one wall-clock origin
(`session_start_ns`, ADR 0024), and the scratch survives a crash or
relaunch and comes back as a stopped capture (ADR 0002 DS-7). What is
missing is every way of *adding* to that axis once it exists:

- **Connect** always wipes — `clear_trace_store_now` runs on Connect,
  Open and Clear alike — so a disconnect, a crash or a reboot ends the
  capture even though the frames are still on disk.
- **Import** always replaces: the first frame calls `start_session`,
  which empties the buffer and the scratch (ADR 0046's one ingest
  pathway has one mode).
- The **logger grid** multi-selects already (ADR 0044 gridview) but
  every action takes one file; its context menu has *Import* and
  *Reveal* only.

## Rulings (2026-10-06)

| # | Question | Ruling |
|---|---|---|
| 1 | Ordering / overlap model | **Origin = min(oldest file loaded, capture start).** An added file is ingested through the one ingest pathway like live traffic: arrival order in the store, calendar placement on the time axis. No runs/segments, no duplicate detection. |
| 1a | Pyramid feasibility | Per-bus **coverage** gates every add: a bus's series must stay non-decreasing in `t` ([signal_cache.rs `partition_by_t`](../../apps/gui/src-tauri/src/signal_cache.rs) rests on "one bus's frames arrive in order"), so an added file's frames for a bus are admitted only at or after that bus's covered max. Keeps store, by-id, anchor index and pyramids append-only. Alternatives rejected: per-import runs (weeks; every frame-index consumer becomes run-aware), rebuild-on-out-of-order (minutes per add, sort memory). |
| 2 | *Reload all* | **Clear capture, then load every file in that logger's folder oldest-first** through the add path; files still being written are skipped; one progress/cancel like today's import, cancel keeps what landed. Multi-select gets *Import selected* (add, no clear, same coverage check, refusals reported per file). Under 1a this is the only shape that recovers a crash's lost flush tail — a restored scratch would trim every overlapping file to nothing new. |
| 3 | Formats | **BLF only** for add. MDF4 add → backlog. File-backed signal series need rework before they can be added (their key is `(group number, signal)` and a series is "filled once, completely"); the owner's note: *ideally the architecture wouldn't force us to decide* — key the series by source file so the question never arises. Backlogged with that shape. |
| 4 | Connect chip | **No menu.** Disconnected: plain click = *Connect* (fresh capture, as today); **Ctrl/Cmd+click = *Append*** (continue the capture: keep store, origin, `capture_id`, pyramids; append after the gap). Connected: click = *Disconnect*. Both as command-palette commands. A **timeline event** at every continuation (ADR 0035). A **setting** *Connect appends by default*, off, swaps which action the plain click takes. |
| 5 | Partial overlap | **The incoming file is trimmed** to each bus's admissible range (frames at or after that bus's covered max); the census reports what was trimmed per bus. No override, no pre-set range dialog. |
| 6 | Task 79 | Untouched. 79 §1 (restore → import leaves the view empty) is not fixed here; this task must not regress it. |

## The rule

**A capture is one calendar axis. Anything with a timestamp can join
it, at or after what its bus already holds.**

- **Coverage** is per bus: the `[min, max]` timestamp the capture holds
  for that bus, maintained on append and persisted with the derived
  state so a restored scratch knows it.
- An **add** (an added file, or live frames after *Append*) lowers the
  origin before ingest when it starts earlier than the origin (ADR
  0024: `append` drops pre-origin frames, so the origin moves first —
  `settle_import_origin` already does this for the replace path), and
  admits a bus's frames only at `ts ≥ covered max`.
- An add or an *Append* **never mints a new `capture_id`** — ADR 0047's
  global gate would otherwise discard every pyramid.
- The origin never rises; Clear and a fresh Connect are the only ways
  to start over.

## Scope

1. **Add to capture** — `trace.import` becomes a split chip: *Import…*
   (replace, as today) and *Add to capture…* (BLF). The census dialog
   shows, per bus, what the coverage rule trims.
2. **Append on connect** — Ctrl/Cmd+click the connect chip (and the
   `connection.append` command): connect without clearing. Covers an
   in-process Disconnect → Append, a restored scratch after a relaunch
   or crash, and a capture just assembled by *Reload all*. A
   continuation timeline event per resume. Setting *Connect appends by
   default* (off).
3. **Logger grid** — *Import selected* on the multi-selection (add, no
   clear); context-menu *Reload all* (Clear, then every file in the
   folder oldest-first).
4. **Docs** — an ADR for the rule above (amending ADR 0024's origin
   sentence, ADR 0046's single import mode, ADR 0047's `capture_id`
   gate and ADR 0002 DS-7's "reloaded as a stopped trace"); CONTEXT.md
   terms *Add to capture*, *Append*, *Coverage*, *Reload all* (added at
   grooming); README's import/connect lines. Docs land with the phase
   that changes the behaviour, not as a phase of their own.

### Not in scope

- MDF4 add-to-capture; file-backed series keyed per source file
  (backlog, ruling 3).
- Duplicate detection; any override of the trim (ruling 5).
- Task 79 §1 (ruling 6).
- A webview reload rejoining the session — task 143.

## Known limitation (to state in the ADR)

The anchor index answers "first row at or after `t`" over the global
arrival order (`anchor.rs`). After adding an *older* file for a bus the
capture did not hold yet (admissible: that bus was empty), a `t`
inside the added range resolves to the first row of the *other* buses'
newer data. Per-bus series are unaffected (the plot is calendar-true);
timeline-event anchoring and trace-from-plot navigation into such a
block land late. Accepted under ruling 1; the trace shows load order.

## Phases

Layer, then consumers. One branch each; the pre-commit hook and the
shared tree per `implement-phase`. Perf reading after phases 1 and 2
(both touch the data path); nothing here needs an hours-long run —
crash tolerance is "kill the process mid-capture, relaunch, Append",
minutes; the long-capture regime comes from a generated BLF.

1. **Coverage and the add mode (host)** — Opus. `TraceStore` tracks
   per-bus coverage (on append; in `DerivedState`; restored by
   `try_reload`). `open_log` gains an *add* mode: no `start_session`,
   keeps `capture_id`, lowers the origin from the census range, trims
   each bus's frames to `ts ≥ covered max` and reports the trim per
   bus. The ADR. Tests: add into an empty capture; add after live
   frames (older bus-less-covered file lowers the origin; same-bus
   overlap trims); every affected pyramid still non-decreasing after
   an add (ADR 0047's precondition, asserted); restore → add keeps
   `capture_id` and the pyramids; the replace path unchanged.
2. **Append on connect (host + chip)** — Opus. A connect that keeps the
   store: skips `clear_trace_store_now`, keeps origin and `capture_id`,
   waits on `restorePendingRef` like Connect does today, writes the
   continuation event. Frontend: `connection.append` command, the
   chip's modifier click (`StatusChip` gains the event), tooltip naming
   both, the setting (machine-local, ADR 0032) that swaps the plain
   click. Tests: Disconnect → Append keeps the row count and origin;
   fresh Connect still wipes; the event lands at the first appended
   frame; the setting swaps the actions.
3. **Add to capture (frontend)** — Sonnet. The split import chip; the
   census dialog's per-bus trim report; MDF4 greyed in add mode with
   the reason. Tests on the dialog's trim presentation and the
   command routing.
4. **Logger grid: Import selected, Reload all** — Sonnet. Both actions
   over the ADR 0044 selection model; *Reload all* = Clear, then the
   folder's files oldest-first by `startNs`, skipping `writing`;
   progress and cancel through the existing import reporter. Tests:
   ordering, skip-while-writing, cancel keeps what landed, per-file
   refusal report.

## Exit criteria

- [ ] *Add to capture…* loads a BLF into a non-empty capture without
      clearing it; the origin is the earliest of all sources; per-bus
      overlap is trimmed and reported; `capture_id` and the pyramids
      survive.
- [ ] Ctrl/Cmd+click on the connect chip (and `connection.append`)
      continues a stopped or restored capture — live frames append
      after the gap, a continuation event marks it — while plain click
      still starts fresh; the setting swaps the two.
- [ ] Kill the process mid-capture, relaunch, Append: the capture
      continues on the same axis with at most the flush tail missing.
- [ ] *Reload all* on a logger rebuilds the capture from its folder
      oldest-first; *Import selected* adds the selection.
- [ ] Every pyramid on every bus is non-decreasing in `t` after any
      sequence of adds (asserted by test).
- [ ] ADR written; ADR 0024 / 0046 / 0047 / 0002 amended; CONTEXT.md
      and README current.
- [ ] Six-row CI table per phase; perf readings after phases 1 and 2
      recorded, none judged until the chain ends.

## Status

(none yet)
