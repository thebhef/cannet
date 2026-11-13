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

Grouped by area. Everything below is on `main` (stack merged
2026-11-07; earlier tiers 2026-09-23, 10-04, 10-14). Each entry lists
what to look for when checking it.

### CAN drivers

#### python-can sidecar (all vendors)

- **Task 163 — python-can usage review and fault model**
  (`task163-fault-measure` … `task163-recovery-docs`, ADR 0060).
  - Pull a cable on a live bus: one event per bus per pull; the fault
    shows within about 1 s; recovery shows within about 2 s of
    plugging back in.
  - Error frames never count toward the frames/s figure.
  - Bus-off, error-passive and a stuck transmit queue each recover
    with no reconnect (bench 3/3 each on PEAK, 2026-10-06).
  - Known: a channel in an ack storm hears everything 6–16 s late
    (§ 3).

#### PEAK

- **Task 121 — the trace tells the truth about the wire**
  (`task121-echo-row`, `fix-pcan-counters-decay`; bench-confirmed
  2026-10-03).
  - Pull the cable while transmitting: the transmit panel and the
    trace stop reporting frames as sent within one health poll.
  - A Tx row appears only when the driver echoes the frame. A refused
    send gives no row at all, in any view or count (#557).
  - Open: the bridge drops the Tx frames it pulls from the far side
    (§ 2).
- **Task 161 — a bus-off controller comes back**
  (`task161-bus-off-recovery`, `fix-pcan-counters-decay`,
  `fix-pcan-busoff-visible`).
  - Short the bus until the controller goes bus-off: it returns to
    active on its own, within the backstop, no reconnect.
  - Hold the fault for a long pull: same result (closed by 163's bench
    2026-10-07; the recovery path on `main` is 163's close-before-open).
  - Vector and Kvaser not checked on hardware.
  - Known: after a reopen, a stale error-passive stays shown until the
    first poll (§ 3).

#### Kvaser

- **Task 155 — Kvaser timer wrap and loud drops**
  (`task155-kvaser-unwrap` → `task155-drops-loud` →
  `task155-logger-clamp`).
  - A capture running past the Kvaser timer wrap shows continuous
    timestamps, no jump; one warning per wrap naming the channel.
  - A frame stamped before the session start: one warning naming bus,
    stamp and distance; repeats at most one line per 10 s; a closing
    line with the total.
  - A logger fed frames from before its anchor logs the same clamp
    warning at finish and at each split.
  - Owner confirmed on a 12 h+ capture 2026-10-02.

### Plot

- **Task 169 — plot y scale** (`fix-plot-y-scale`, #574).
  - Pause, then zoom: the y range holds. Fit Y: min/max of what is on
    screen. Follow-live: unchanged, all-time extent.
  - Type a min and a max: the axis pins exactly, also in per-unit mode
    with more than ten signals and with the SNA spike present. Click
    away from the menu: the bound stays.
  - The axis menu lists max above min.
  - "Ignore manual y bounds" chip on: every axis automatic, bounds not
    cleared. Off: the bounds return.
  - The menu clears one bound or both; clearing turns the chip off.
- **Task 166 — plot panel fixes** (#561 → #564).
  - One disclosure per axis head, leftmost, also in unified mode; no
    whole-area collapse.
  - Narrow the column: a long `bus · ecu · message` label shrinks step
    by step and never disappears whole.
  - Alt-drag on macOS, Ctrl-drag on Windows and Linux copies a plot
    area; the pointer shows copy while held; works within one panel.
  - A series on a mixed-rate axis: a straight line between its own
    samples, nothing bent by a neighbouring series.
  - Perf reading owed (§ 5).
- **Task 146 — a round of plot fixes** (`task146-lane-investigation` →
  `task146-panel-plumbing`, `fix-plot-hover-overlay`,
  `fix-plot-square-markers`).
  - Points: On gives every sample a marker, including on a long trace
    (owner verified 2026-09-21).
  - Enum lane: markers sit on the value and read over the tile; a
    state held wider than the window is one tile; a code held one
    column or longer keeps its code at every zoom; a narrower change
    leaves a one-pixel tick (#571).
  - Event label chips in a top gutter, one or two lines tall; A, Δt
    and B chips between the plot box and the x ticks; nothing drawn
    inside a plot box; collapsing the anchoring axis moves them, not
    loses them; chips row up when they collide and their precision
    follows zoom (#555).
  - An empty plot area shows the x grid, ticks and clickable A/B
    cursors; a panel with only an empty area shows the session span
    and follows live.
  - An empty area beside a populated one keeps the event markers.
  - Toolbar: an Events chip with a checklist that hides bus markers;
    no checklist in the right-click menu.
- **Task 158 — bus-error markers** (`task158-error-series` →
  `task158-events-merged`).
  - Unplug a dongle for 20 s on a live bus: the plot shows one marker
    for the outage, styled like an authored event, with its extent,
    without zooming in and out first.
  - Events panel: one chronological list of authored events and
    bus-error episodes; an episode row selects but does not edit; no
    separate bus-error section.
  - Settings: episode gap default 5 s, minimum 1 s; changing it
    regroups the list.
  - Hover the time of any event or episode row: the same local date
    and time a message row shows; no tooltip without a wall-clock
    origin.
  - Thousands of episodes: all appear at the zoom where they resolve.
  - Relaunch over the capture: episodes keep kinds, directions and
    counters (#551).
- **Task 135 — plot math functions** (`task135-engine` →
  `task135-surfaces`).
  - Database view → Computed branch: create a math signal; each
    function computes (sum, difference, product, scale, expfilter,
    hline, integration, duty cycle, frequency, min/max/average/median/
    range of a set, statistic, rms).
  - Expanding the row opens an in-place editor in the Database panel,
    signal panels and the plot side list: no dialog, no Save or
    Cancel; edits commit on blur; undo/redo works; delete is two-stage
    in the Database view.
  - A set over a pattern picks up a new matching signal by itself.
  - A math series drags to plots and signal views like any signal; bus
    chips per contributing bus, "Math - Multiple Busses" when several;
    statistic draws as a flat line; hline draws solid.
  - MDF export carries math series; BLF does not.
  - Pyramids are session-scoped; task 159 persists them (ruled
    2026-10-02).

### Trace

- **Task 142 — fzf filter in the trace panel** (`task142-host-fuzzy` →
  `task142-trace-filter-panel`, `fix-trace-filter-feedback`).
  - Filter box in the trace toolbar; Mod+F focuses it; works in both
    modes.
  - A bus name, message name or id, signal name or enum label finds
    the right frames; clearing restores everything.
  - While it works: `searching…` after the box, then the host's match
    count; nothing with the box empty.
  - Composes with the sources filter, show-events and
    collapse-error-frames; event rows narrow too.
  - Survives a restart; does not dirty the project.
  - A long capture scrolls normally with a query active.
- **Task 153 — enum values in the trace filter** (`task153-host-gate`
  → `task153-panel`).
  - Type a fault enum's label: chronological mode shows exactly the
    frames carrying that value over the whole history; by-id mode
    shows the message whose value list holds it, whatever it reads
    now.
  - Type a signal name: the frames of the messages carrying it; a
    message matching only weakly on its own name drops out.
  - A signal or value match opens the matching rows' signal
    disclosure to only the matching signals; a message match or a
    cleared query leaves disclosure as you had it. Known: a row you
    force-open under such a match shows its full expand only once the
    match reverts.
  - Speed: § 2.

### Time display

- **Task 165 — one date/time pattern** (`task165-date-pattern`,
  `task165-date-setting`, `fix-logger-now-per-file`, ADR 0062).
  - Settings → General → Date/time pattern: live preview; an invalid
    pattern cannot be saved.
  - Every date and time shown follows it; export From and To are
    unchanged.
  - In templates `{start:yyyy-MM-dd}` works; `{start:%Y-%m-%d}` shows
    an error in the preview and at write time; bare `{start}` is ISO
    basic.
  - Logger: each file of a run takes `{now}` from its own creation
    time; `{start}` is the capture start; the preview ticks.
- **Task 167 — calendar time in every view** (#565 → #567,
  `task167-fractions-round`).
  - Settings → General → Time display (elapsed or calendar), or the
    palette's Toggle calendar time.
  - Trace, By-ID, Events and Signals time cells show calendar time;
    hover shows elapsed; the same frame reads the same in all four.
  - Plot x ticks, the axis title ("Time on …"), hover label, A/B chips
    and panel readouts show calendar time; Δt stays a duration.
  - A timeline with no wall-clock origin stays elapsed.
  - Fractions round half-up and end in the same digit as the elapsed
    column (#572).
  - Perf reading owed (§ 5).

### Project and startup

- **Task 170 — startup restore feedback**
  (`fix-startup-restore-feedback`, #575). Needs a build of `main`.
  - Relaunch over a project with a large prior capture: the status
    bar shows "Restoring prior capture…" with a determinate bar, from
    the first mapped file until the frames land.
  - Three stages in order: `capture index n / N files`, `capture
    frames`, `signal caches`; each ends at N of N.
  - Open a project with no prior capture: no chip.
  - `cannet.log` `restored … in X ms` matches before within noise.
- **Task 156 — restore from cache does not crash**
  (`task156-restore-crash-investigation` → `task156-closing-cue`).
  - Open a project whose cache another cannet holds: refused with a
    message naming the holder; close that one and the open succeeds.
  - Close the window during a long shutdown flush: a closing state
    stays visible until the host exits; relaunching meanwhile is
    refused, no crash (owner saw it 2026-10-02).
  - Known: the closing cue says it is writing the capture on every
    exit (§ 2).
- **Task 152 — nothing heavy in the foreground** (`task152-shape-a` →
  `task152-listing-and-mirror`).
  - Delete or clear a multi-GB project cache: the UI stays responsive
    and no "frontend unresponsive" warning fires.
  - The logger file list appears at once with dimmed `…` cells that
    fill in (accepted 2026-10-07).
  - A manual send onto a full outbound queue is refused, not waited
    on (accepted 2026-10-07).
  - Perf reading owed (§ 5).
- **Task 168 — duplicate a project element** (#568 → #569).
  - Project panel → element row → Duplicate: a copy named
    `<original> (copy)` right after the original; one undo removes it.
  - Edit the copy: the original does not change, plot areas included.
  - Duplicate a transmit element: each owns its frames; remove one,
    the other's frames stay.
  - A Duplicate that fails warns in the system log and marks the frame
    (#573).
- **Task 140 — project state items** (`task140-controls`).
  - Element rows: a trash icon removes in one click (undoable); an
    enter icon focuses or opens the element's panel; no text buttons.
  - Bus and DBC Remove and the interfaces' Discover are icons (trash,
    refresh).
  - RBS and Logger rows: the play/stop toggle mirrors the panel's
    enabled state both ways; green running, amber armed, no text.
- **Task 147 — collapse database items under a filter**
  (`task147-collapse-under-filter`).
  - Database panel and RBS panel: typing a query opens the path to
    every match.
  - With the query still there: chevron or ArrowLeft collapses a row
    and hides its subtree; ArrowRight or chevron reopens; ArrowLeft on
    a collapsed row goes to its parent.
  - Editing the query opens the new matches' paths and nothing else;
    clearing it leaves expansion alone.
- **Task 148 — connect with a bus set to no interface**
  (`task148-no-interface-binding`).
  - The bus interface combo offers "— no interface —"; it survives
    save and reopen.
  - Two buses, one bound and one no-interface: connect works; the
    bound bus goes live, the other reads "unbound"; the chip reads
    `1 / 1` and names the no-interface bus in its tooltip.
  - A bus with no interface row at all is still refused with the
    existing message.
  - All buses no-interface: no connect action, with the reason shown.
  - Older project files open unchanged.

### Units

- **Task 139 — units and scaling for math signals** (`task139-units` →
  `task139-apply`).
  - A set over members with mixed units (mA beside A) computes in the
    target unit; changing a unit customization rescales on the next
    serve.
  - Gain and offset work with no units anywhere; a source-unit
    override fixes a mislabelled operand.
  - Members that cannot convert pass through unscaled and the editor
    marks which.
  - °C, °F and K convert correctly.
  - Integration: A → Ah, mA → Ah, W → kWh. Derivative: an Ah counter
    per s reads Ah/s and converts to A on request.
  - A product of A and s reads `A·s`, not coulomb; `1 A + 500 mA`
    reads 1.5; a set mixing dimensions shows a badge and no unit.
  - Integration and derivative unit pickers offer only the composed
    dimension; View signals reassigns any unit with no scaling.
  - Signal mapping flags every DBC unit string the project cannot
    place, names it, points at Settings → Units, filters to those
    rows; adding the customization clears the flag without reopening.
  - Older project files load unchanged.

### Settings

- **Task 151 — the settings view's grids are gridviews**
  (`task151-units-gridview` → `task151-servers-section`).
  - Settings → Units is a tree: dimensions as branches, opening
    collapsed; units as leaves; it scrolls in its own space, not the
    whole settings page.
  - Units filter, composition entry, mapping rows and the ratio column
    work as before.
  - The project caches list is a gridview with the same rows and
    controls.
  - Servers is a section of the settings view, reachable from the
    command palette; trust, token, forget and add-by-hand work there
    (the Show servers command is gone, accepted 2026-10-07).
  - Known: mV, V, kV, MV listed as separate units (§ 2).

### Export and loggers

- **Task 137 — log export** (`task137-templates` → `task137-file-grid`).
  - Save Capture opens the export dialog: name template with live
    preview; range picker (timeline, comboboxes, events, presets); then
    the OS picker seeded with the name, last folder and last format.
    Folder, format and template are remembered across projects.
  - Export runs in the background: a status-bar chip with name,
    percent and cancel; cancel removes the partial file; views keep
    working.
  - A logger is a project element with its own panel (folder, file,
    preview, format); writes exactly while enabled and connected;
    controls lock while writing; BLF splits at the size cap (default
    500 MB, `-00N` suffix); the enabled flag saves with the project.
  - Logger file list: folders as branches; name, size, start, end,
    duration, count, modified; the file being written shows live;
    import by button, context menu or Space, with a range.
  - Changed since the 2026-10-02 check: templates are TR35 (a
    strftime template saved before 165 errors until retyped) and
    `{now}` is per file, so a split's file names differ from what was
    seen then (#558, #560).
  - Known: the idle file list has no filesystem watch
    (`plans/backlog.md`).

- **Task 172 — the logger reads only what it shows**
  (`logger-reads-only-what-it-shows`, #577, open).
  - Point a logger at a OneDrive-synced folder with offloaded files and
    leave its panel in a background tab: no download activity.
  - Settings › Logging › scan file headers off, panel shown: no
    download activity; start, end, duration and messages read `—`;
    files already scanned still show their values.
  - Hiding the panel, changing its folder, or turning the setting off
    stops a scan that is running.

### Clients and wire protocol

- **Task 136 — python-can cannet client** (`task136-core-bus` →
  `task136-clock-detect`).
  - `can.Bus(interface="cannet", server=..., channel=...)` against a
    trusted server: recv, iteration, Listener/Notifier, send, shutdown
    and state work.
  - Timestamps are corrected to the client's clock; a server that
    answers no probes falls back to raw stamps without blocking.
  - `can.detect_available_configs()` lists one config per interface
    per reachable trusted server.
  - TLS: a pinned connect works; a wrong pin is refused at the
    handshake (test landed 2026-10-02).
- **Task 144 — cannet-client CLI** (`task144-client-cli`).
  - `cannet-client list`: browse and trust store merged, trust state
    and presence per row; a known but silent server still appears.
  - `cannet-client connect`: all four paths with their prompts; a pin
    mismatch is refused; success is verified with an authenticated
    RPC; the GUI reads the stored entry unchanged. A pinned server
    that is down is refused (confirmed 2026-09-21).
  - `cannet-client forget` removes the entry; the next connect is
    trust-on-first-use again.
- **Task 145 — an explicit wire protocol version**
  (`task145-server-info`, ADR amending 0051).
  - `ServerInfo` answers on both servers with no token: packages
    served, build version, instance name.
  - Rust client, GUI, python client and CLI each refuse a server that
    does not serve `cannet.v1` with "serves <pkgs>; this client speaks
    cannet.v1"; the GUI no longer retries an UNIMPLEMENTED.
  - The Servers section greys out a row whose `proto=` lacks
    `cannet.v1` before any connect; `cannet-client list` shows a
    protocol column.
  - Against a server older than `ServerInfo`: the GUI says the server
    is older than the client, not that the token was refused; the
    server logs connections and refusals (#576).
  - Lockfile re-lock owed (§ 5).

### Diagnostics and logs

- **Task 173 — a frontend log that survives a hang**
  (`frontend-log-survives-a-hang`, #578, open). Diagnoses the next
  bench-PC hang; does not fix it. Its exit criteria are still open.
  - An uncaught frontend error or unhandled rejection shows in
    `cannet.log` as a warn line from source `frontend`; a burst is
    capped at 5 per kind per minute.
  - After a hang and a kill, the next launch writes `frontend.log`
    beside `cannet.log` with the stall's start, its end or "ended by
    kill", the commands still outstanding by name, and whether the host
    was answering the heartbeat.
  - A host-side stall (`ack-lost`) and a renderer-side stall
    (`stall-start`) read differently in that file.
  - Window resize bursts, scale-factor changes and visibility changes
    appear in `cannet.log` at debug.
  - Still unverified: a Task Manager kill on Windows; a live
    renderer-side stall; the recorder's cost at ~200 plots. macOS
    host-blocked case verified 2026-11-11.

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

