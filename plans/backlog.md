# Backlog

Short, prunable list of things noticed in passing that don't belong in the
current step. Add an entry instead of doing drive-by work, then revisit this
file when planning the next step or phase to decide whether each item should
fold into upcoming work or be dropped.

Keep this file small. A growing backlog is a signal to either schedule the
work or admit it isn't going to happen and delete it.

## Conventions

- One bullet per item. Include enough context (file path, symbol, or short
  description) that the next reader can act on it without spelunking.
- Optionally tag with a category in brackets, e.g. `[cleanup]`, `[perf]`,
  `[docs]`, `[idea]`.
- When an item is picked up, remove it from this file in the same commit
  that addresses it (or that schedules it into a phase).
- Group items by the surface they touch (trace view, plot panel, host
  crates, …) so the next pass on that surface can absorb them as one
  piece. Cross-cutting items go in **GUI chrome and cross-cutting**.

## Items

### High priority

Near-term work — fold these into a phase before picking up the
lower-priority follow-ups below. The original "Minimum Usability
Tasks" list shipped across **Task 11** (transmit signals),
**Task 12** (DBC view + drag/drop), **Task 15** (plot
refinements), and **Task 16** (hotkey framework).

- takes a long time to exit gracefully

#### Other near-term work

- `[feat]` **Settings panel — first entry: `clear scratch cache on exit`.**
  Per [ADR 0002 DS-7](../docs/adr/0002-disk-spill-store.md), the
  disk-spill scratch (raw store + indexes + pyramids + session-authored
  markers/events) lives in `$XDG_CACHE_HOME/cannet/current/` and is
  wiped only when the session buffer is — on Clear, or on Start of a
  new capture — never on exit or crash. That makes the launch-loads-
  prior-as-stopped behavior mechanically free, but means a user who
  quits without Clearing/Starting leaves the prior session on disk
  indefinitely. A settings panel needs to exist; its first setting is
  an opt-in `clear scratch cache on exit` toggle (default off) that
  wipes `current/` on clean shutdown. Other settings will land here
  as they come up; spec the panel itself when picking this up.
- `[test-fixtures]` **Vendor python-can BLF fixtures under
  `crates/cannet-blf/tests/fixtures/python-can/`.** Phase 10 Step 1
  listed this as the first of four test sources but
  deferred actual vendoring; today the step's coverage is
  synthetic-bytes per-module tests + the vector_blf oracle
  cross-check (gated behind `vector-blf-oracle`). Adding the
  python-can-written files would give us a third-party-writer
  cross-check that runs without C++ toolchain. ~30 KB binary
  per file, expect ~5 files covering classic / FD / error / mixed
  channels / big payloads.

### CI / checks

Static and automated checks we'd like running on the repo to catch a
class of bug before it ships, rather than relying on the next user to
trip over it.

- `[ci]` **Verify the release workflow produces installable bundles.**
  Task 26 stood up `release.yml` (manual `workflow_dispatch` → draft
  pre-release with macOS arm64 `.dmg` + Windows x64 `.msi`/NSIS), but
  it has never been dispatched — its "produces installers" and
  "version shows in the title bar" exit criteria are unverified. Run
  it once and confirm the artifacts install and launch before relying
  on it for the alpha.

- `[ci]` **Typed Tauri command bindings via `tauri-specta`.** The
  `invoke<T>(cmd, args)` signature types only the return value; `args`
  is `unknown`, so a snake_case/camelCase wire-name mismatch between a
  JS payload and the Rust struct's `#[serde(rename_all = ...)]` is a
  silent runtime error (recent example: `TransmitPanel.tsx` sent
  `bus_id` against a `camelCase` `TransmitRequest`, surfacing only as
  Tauri's deserialization error string in the panel toolbar). Derive
  `specta::Type` on each command's arg structs, run the build step to
  emit a generated `commands.ts`, and call `commands.transmitFrame({
  request: { busId: ... } })` from the frontend so `tsc` rejects the
  wrong-case key. Evaluate properly (and land in
  [technology-inventory.md](technology-inventory.md)) before adopting.

- `[ci]` **Server-implementation conformance check.** Every server
  that speaks `cannet-wire` (today: `cannet-server`'s BLF replay and
  virtual-bus modes, `cannet-python-can`; tomorrow: other vendor
  sidecars) is expected to honour the same envelope semantics —
  `ConfigureBus` on the bus / interface they own, exhaustive matches
  on the full envelope set, error-frame round-trip, the response
  shapes `ListInterfaces` / `WatchInterfaces` promise, etc. Today
  this is policed by reading code and remembering. Want a single
  conformance suite (Rust integration test using `cannet-client`)
  that drives a generic checklist against any server endpoint —
  spin the suite against each shipping server in CI so a divergence
  shows up as a test failure rather than at runtime in the GUI.

### Trace view

- `[ui]` by-ID view (`useByIdView.ts`): while *running*, the live refresh
  re-pages page 0, so a by-ID view scrolled into a later page is yanked
  back to the top each tick. Only reachable with an unusually large id
  space (the by-ID set is id-space-bounded, so it almost always fits one
  page); the common case is unaffected. Fix when it bites: re-page the
  *current* page on the live tick instead of page 0 (needs the windowed
  primitive to expose "refresh the loaded window" distinct from
  follow-live's "re-page the tail").
- `[ui]` `cannet-gui`: **bitfield message visualizer**. Render a CAN
  message as its raw bits laid out as a grid (8×N cells, one per bit),
  coloured / lit by current value, with DBC-derived signal overlays
  showing which bits belong to which signal and named flag labels for
  single-bit booleans. Most natural as a row-expansion mode in the
  trace view (toggle between the decoded-signal grid and a bit grid),
  or as a small standalone panel for watching one ID's status flags.
  Useful for messages that pack many flags into a byte where the bare
  decoded-signal list is harder to read at a glance.
- `[ui]` trace view (`TraceView.tsx`): under a fast (unlimited-rate)
  stream, scrolling up doesn't reliably leave auto-scroll and a parked
  panel can be yanked back to the live tail — the auto-scroll re-pin
  effect races the async `onAutoScrollDisabled`. Fix: a synchronous
  "user took control" ref that gates the re-pin / pin-to-tail effects
  until the parent's `autoScroll` flips. (Surfaced during Windows
  stress testing; macOS at moderate rates is fine.)
- `[ui]` trace panel (`TracePanel.tsx` / `TraceView.tsx`): the
  scaled-scrollbar virtualizer's interaction model needs a rework — the
  per-pixel resolution gets coarse on huge traces, the wheel-notch
  handling is fiddly, and the auto-scroll re-pin race (separate entry
  above) is a symptom. Decide between a real windowed virtualizer with a
  synthetic-height spacer vs. the current scaled approach, and settle the
  scroll/auto-scroll ownership story, before piling more on it. (Flagged
  while planning Phase 4; doesn't block plotting.)

### Plot panel

- `[bug]` `cannet-gui` plot panel: **uncaught uPlot TypeError after
  dev reload while streaming.** Seen during the rename-lockup
  investigation: `Uncaught TypeError: object null is not iterable` at
  `drawAxesGrid` (uPlot `_commit`) right after a dev-server reload
  mid-capture, alongside Tauri "couldn't find callback" warnings.
  Looks like a draw on a destroyed / rebuilt instance. Reproduce and
  guard (likely a `uplotRef.current` staleness window in
  `PlotPanel.tsx`'s create/destroy effect).

### DBC view

- `[feat]` `cannet-gui` DBC view: **ECU view mode** — group the message
  tree by transmitting node (ECU) instead of flat by message, mirroring
  the per-ECU grouping the RBS panel uses. (Surfaced while designing
  the RBS `.cannet_rbs` schema.)

### Transmit panel

- `[perf]` `cannet-gui` `run_transmit_scheduler`: per-bus
  `FrameBatch` batching. The scheduler currently fires each due
  message through `transmit_frame_inner` individually (one
  trace-append + one wire `FrameBatch` of one frame each). When many
  messages on the same bus come due in the same tick they could be
  coalesced into one `FrameBatch` (the wire protocol's
  `FrameBatch.frames` is already a `Vec`) and one bulk trace append —
  cutting per-frame gRPC encode/framing overhead at high aggregate
  rates. Deferred: the `bench_tx_*` numbers (≈828k frames/s
  single-threaded) show this isn't needed to hit the current target
  (arbitrarily many 5–10 ms messages across buses). Pick up if a
  future use case pushes aggregate rates toward bus saturation.

### Cursors and markers

These are the general event surface governed by the timeline-event model
([ADR 0035](../docs/adr/0035-timeline-event-model.md)) — markers across
every timeseries view, persisted, exported, navigable, eventually a
singleton panel. The disk-spill truncation marker (task 0018) wires the
first non-note kind; the items below are the rest.

- `[ui/feat]` cursor + marker rework.
  - Each cursor-created marker carries an editable description; the
    list UI gets an expand-to-show body on the row, collapsed by
    default, plus a per-marker colour picker.
  - Cursors / markers grow into their own top-level view (they are
    global, not per-panel; their lifecycle is similar to project
    view, graph view, system messages). The view shows both BLF
    record types — `GLOBAL_MARKER` and `EVENT_COMMENT` — with
    filtering by record type and by the user-defined event tag (below).
  - Add a "create marker from message" flow: emit an `EVENT_COMMENT`
    whose `commentedEventType` matches the source message
    (`can` / `can-fd`) and whose object timestamp equals the source
    message's, so it tracks with the message per the BLF spec. The
    text field is prefixed `cannet:event:<user-string>\n` to enable
    filtering; the UI strips the prefix and renders just `<user-string>`.
    `<user-string>` is configurable in the UI. Use cases: fault
    detections, contactor open/close, specific commands sent. UI
    design needed for picking the source message and authoring the
    rendered text.
  - `EVENT_COMMENT` markers should be rendered in the graph view,
    when enabled in the filter
  - `GLOBAL_MARKER` and `EVENT_COMMENT` items should appear in 
    historical-mode trace views

### GUI chrome and cross-cutting

- `[ui]` `cannet-gui` status line (`renderStatus` in `App.tsx`): a global
  `state.kind === "error"` is **sticky** — once set, the top-left status
  shows `Error: …` forever, even after the session recovers and is
  streaming fine. Observed under `tauri dev --connect-on-start`: a
  transient connect-time error left the error label up for the whole
  run, while a clean relaunch showed the normal "Streaming … N frames"
  line. A live remote session masks it (`remoteSessions.size > 0` takes
  priority in `renderStatus`), but an error that lands while no remote
  session is registered persists. Clear the error state when a session
  starts/recovers (or expire it) so a recovered app stops reading as
  broken.
- `[feat]` `cannet-gui` Save Capture: **time-range export.** Phase 9's
  Save Capture writes the entire session buffer to a `.blf`. Add the
  ability to pick a start and end time (or start/end frame index) on
  the Save Capture dialog so the user can export just a slice rather
  than the whole capture. Cursor pairs in plot or trace panels are a
  natural source for the range — "Save range as BLF…" alongside the
  existing "Save Capture…" action. Frames outside the chosen range
  are skipped; `GLOBAL_MARKER` and `EVENT_COMMENT` records whose
  timestamps fall inside the range come along; the written
  `FileStatistics.measurement_start_time` is the chosen start, not
  the session start.
- `[ui]` `cannet-gui`: a global UI frame-rate / responsiveness readout
  (rAF-based FPS, maybe long-task / dropped-frame counts) — the plot
  panel shows its own re-sample rate now; generalise that to a small
  always-available indicator so other panels' costs are visible too.
  Useful while tuning the trace virtualizer and any future heavy view.
- `[feat]` **Configurable log volume / verbosity.** Logging volume is
  fixed today — the host System Messages bus, the python-can sidecar,
  and the frontend `diag` stream each emit at a hard-coded level with no
  user control. We'll want a way to configure how much is logged: a
  minimum level (and ideally per-source filtering) plus volume guards
  (rate limiting / retention or ring-buffer caps) so a chatty source
  can't drown the panel or grow unbounded. Natural home is the Settings
  panel (see the `clear scratch cache on exit` item) once it exists.
  Surfaced while building the frontend perf capture, which adds
  yet another log/metric stream.
- `[perf]` Interaction-driven render capture. The self-driving perf flags
  capture the render tier *at rest* — they never scroll the heavy views,
  so the interaction-triggered cost (the O(buffer) filtered / by-id scan
  starving the UI thread, the plot over-render under active panning) goes
  unmeasured, and the frontend baseline only gates "clean → clean." Add a
  synthetic-scroll step to the orchestrator (no WebDriver, per ADR 0031)
  that drives the heavy views during a capture; input→paint latency rides
  along for free via the Event Timing API (`PerformanceObserver` `event`).
  Skipped panel time-to-first-render — one-shot startup number, not the
  sustained saturation that's the actual cost.
- `[ui]` GUI-wide visual restyle: adopt the dark "scope" visual
  language from `plans/plot-panel-reference.html` (the prototype's colour
  variables, monospace type scale, panel chrome, control styling) across
  the toolbar, trace panels, project panel, etc. — currently each panel
  has its own ad-hoc styling in `apps/gui/src/index.css`. Approved in
  principle; do it as one deliberate pass once the plot panel's own
  styling has settled, not piecemeal.
- `[ui]` `cannet-gui` project panel: **DBC-to-bus association should
  read as an include list.** Today an empty `DbcRef.buses` means "all
  buses" — the row shows "all buses" with no checkboxes ticked, which
  reads as "this DBC is assigned to nothing." Surface it as an
  explicit include list (all checkboxes ticked = all buses; tick a
  subset to scope down; untick all = decode for no bus). Note: this
  is specific to DBC scoping; it does **not** imply changing the
  other surfaces that default to "every bus" via a wildcard
  (sink/source selectors, transmit fan-out, etc.).

### Graph view (and bus topology)

Items surfaced during the Phase-6.5 default-receive-all / graph-view follow-up
work that haven't been closed out yet. Group them together so the
next pass on this surface can address them as one piece.

- `[ui]` **Bus-like graph topology layout.** Same-lane stacking
  (plot/trace sharing a row counter) is fixed, but the lane scheme
  isn't the bus-rail layout the user wants — gateway at one end of
  each bus, the bus running long horizontally, consumers branching
  off alongside. Reach for a real auto-layout (dagre / elkjs) or a
  hand-rolled "rail per bus" pass; today's `LANE_X`/`LANE_Y_OFFSET`
  in [graphNodeLayout.ts](apps/gui/src/graphNodeLayout.ts)
  is a workable pipeline layout but doesn't read as a bus topology.
- `[ui]` **Plot panel signal catalog scoped by `sources`.** The
  per-bus signal model and the message picker work end-to-end, but
  the catalog dropdown still shows every signal from every loaded
  DBC across every bus — even ones the plot's `sources` exclude.
  Filter `catalogOptions` in PlotPanel.tsx by the consumer's
  effective `sources` so the picker only offers signals it can
  actually sample.
- `[ui]` **Drag-to-wire from anywhere on a node body.** Drag-from-
  handle works (xyflow `onConnect` is wired to `addEdgeToRegistry`),
  but the user has to land on the small handle dots. Long-term,
  dragging from a producer node anywhere onto a consumer (no need
  to land on a handle) would be more discoverable.

### Host crates, wire, and sidecar

- `[idea]` `cannet-gui` disk-spill eviction (task 0018 Step 6): **pin
  note-bearing regions against eviction.** The windowed-ring cap drops the
  oldest frames purely by age; a section the user annotated with a note is
  evicted like any other. Preserve a window around each user note — don't
  drop segments within `±N` seconds of a note's timestamp — so the frames a
  marker refers to survive even as older unannotated history is trimmed.
  Needs the eviction mark computation to consult the (timestamp-keyed) note
  set and skip / fragment the trimmed range around pinned spans; the mark
  stops being a single monotonic floor (it becomes a set of live ranges),
  so weigh that complexity against the benefit. Deferred from Step 6 — the
  base cap evicts by age only; notes are kept but may dangle below the floor.
- `[bug]` `cannet-gui` disk-spill scratch: **two app instances share and
  stomp one `current/` dir.** The scratch lives at a single fixed path
  (`<OS cache>/cannet/current/`), and nothing arbitrates exclusive
  ownership. [ADR 0002 DS-7](../docs/adr/0002-disk-spill-store.md)'s
  `project_id` identity gate decides what a launch *reloads*, but it does
  not stop a second concurrent instance from opening the same dir and
  appending/clearing into the same segment files as the first — mutual
  corruption (and a second instance's capture silently destroys the
  first's reloadable session). Options: an OS advisory lock / lockfile in
  `current/` taken at boot (second instance falls back to a per-pid
  scratch dir, or refuses, or runs RAM-only), or a per-instance scratch
  subdir keyed by pid with the identity gate scanning siblings. Decide
  the contract (single-instance-wins vs. multi-instance-isolated) when
  picking up. Surfaced while wiring 5.3c reload.
  reductions.** The per-tick O(session length) rescan is fixed — the
  follow-live tail now resumes from an incremental count checkpoint and
  scans only *backward* from the tip for its page (`fetch_filtered_trace`
  fast path + `useFilteredTrace` cursor), so a filtered panel parked at the
  tail costs O(Δ + page span) per tick, not O(buffer). Two residual pieces
  remain, sharing one invalidation story (filter edited / DBC set changed):
  - *Positioned deep-scroll fetch.* A non-tail page (the user scrolled into
    history) still scans from `scan_start` to place itself by match-index —
    O(offset), but on the scroll, not the live tick. A per-filter match
    index (like `by_id`, remembering matched indices) would make it
    O(log + page); only worth it if deep-scrolling a filtered view on a
    huge buffer proves janky.
  - *Cached candidate sets.* `decode_candidate_ids` re-runs the
    name/signal resolution against every loaded DBC on every fetch
    (4 Hz+ per filtered panel), though it's a pure function of
    (predicate, loaded DBCs) and both have change events. Cache keyed
    by predicate + a databases generation counter; the risky part is
    auditing every `state.databases` mutation site (load, remove,
    reload-all, watcher reload, bus-rescope) for the bump — a missed
    invalidation is a wrong-results bug, which is why this wasn't done
    inline with the gate itself.
- `[ui]` `cannet-python-can` sidecar: **suppress the `xlReceive failed
  (XL_ERROR)` warning emitted on normal close.** Closing a Vector
  channel while `_rx_pump` is blocked in `ch.recv` surfaces as a
  WARN-level `rx for <id> failed: xlReceive failed (XL_ERROR) [Error
  Code 255]` System Message on every disconnect — teardown noise, not
  a fault. Detect the closed/closing state in the pump (or close the
  channel only after the pump exits) so a clean unsubscribe doesn't
  log a scary error.
- `[perf]` `cannet-core`: revisit `CanFramePayload::Classic`/`Fd` to share
  a fixed-size inline buffer instead of `Vec<u8>` once the trace store /
  perf benchmark shows allocator pressure.
- `[feat]` `cannet-server` (Phase 2+): multi-client support. Phase 2 is
  single-client per server; a second connection is rejected with
  `Error::BUSY`. Lift this when there's a real use case (e.g. a second
  GUI session or a CI watcher tailing alongside a developer): server
  fans out received frames to all connected clients, and arbitrates /
  interleaves transmits on the same interface from multiple clients.
- `[wire]` `cannet-wire` `Subscribe`: per-interface bus speed / FD
  config (`bitrate_bps`, `data_bitrate_bps`, `fd`, `listen_only`)
  travelling with the subscription. Phase 8 ships the sidecar adapter
  with a typed `open(bitrate, fd)` slot but the wire `Subscribe`
  envelope still carries only `interface_id` — the host applies a
  per-interface configuration locally before subscribing. Promote
  these to the wire so a transmit on a listen-only interface can
  surface `TX_REJECTED` from the sidecar without a round-trip
  config call, and so the BLF replay server can advertise the
  bitrate the BLF was captured at. Additive proto change.
- `[feat]` `cannet-gui` host: bridge wire-level `LogMessage` envelopes
  from an active sidecar Session stream into the System Messages bus.
  Phase 8 delivers the process-level sidecar lifecycle bridge (stdout
  / stderr / exit-code → System Messages tagged `sidecar:python-can`);
  once the GUI opens a Session against the sidecar it should also
  forward in-band `LogMessage` envelopes through the same tag so a
  vendor SDK warning surfaced mid-session reaches the user without
  the sidecar having to also `print` it.
- `[feat]` Linux `vcan` via socketcan as a writable CAN source. An
  actual local virtual-bus device on Linux is the honest follow-up to
  the in-process virtual bus. Reconsider alongside future hardware
  work — PEAK's Linux kernel driver path could go via socketcan too.

- `[ui]` `cannet-python-can` sidecar: **demote python-can backend "driver
  not installed" WARNINGs to INFO.** On startup the sidecar's enumeration
  triggers python-can's hardware backends to import their native vendor
  libs; when the lib isn't present each backend emits a `WARNING` via its
  module logger that the host promotes to a Warn-level System Message
  (e.g. `can.interfaces.vector.canlib Could not import vxlapi: Vector XL
  library not found: vxlapi64`; `can.interfaces.kvaser.canlib Kvaser
  canlib is unavailable.`, confirmed by direct import). Expected on any
  workstation that doesn't have every CAN vendor installed — not
  actionable, but trips the panel's default Warn filter. Add a
  `logging.Filter` in
  [`__main__.py`](../servers/cannet-python-can/cannet_python_can/__main__.py)
  installed on the root handler after `basicConfig` that rewrites
  `levelno=WARNING → INFO` (and `levelname`) for records whose `name`
  starts with `can.interfaces.vector` or `can.interfaces.kvaser`. Other
  loggers untouched. Result: line still surfaces at Info level (via
  `classify_stderr_line` → `LogLevel::Info`), preserving the breadcrumb
  without raising the panel. Test the filter directly with synthesized
  `LogRecord`s in a new sidecar test.

- `[bug]` `cannet-python-can` server: **frame timestamps fall back to
  `time.monotonic_ns()`** when `msg.timestamp` is absent
  ([driver_python_can.py:444](servers/cannet-python-can/cannet_python_can/driver_python_can.py#L444),
  and `_now_ns()` for TX echoes / synthesized frames at
  [server.py:79](servers/cannet-python-can/cannet_python_can/server.py#L79)).
  `monotonic_ns` is a third clock alongside wall-clock `msg.timestamp`
  and the GUI's wall-clock stamps — a capture that mixes them
  reproduces the same "trace shows rows, plot is empty" bug the vbus
  had (the plot anchors its x-axis on the first frame's timestamp, so a
  series on a divergent clock lands off-canvas). The vbus was fixed by
  stamping wall clock everywhere; the server should do the same
  (prefer wall clock, only fall back to monotonic when truly nothing
  else is available — and if so, normalize it host-side).

- `[test]` **Phase 13 live / hardware sign-off (deferred from the Phase 13
  exit criteria).** The virtual-bus + bridge surface is code-complete and
  covered by unit / integration tests, but three exit criteria need a live
  run and were deferred here for an ad-hoc verify-and-bugfix pass rather
  than blocking the phase:
  - **Bridge configs end-to-end** via
    [`servers/cannet-python-can/SMOKE.md`](../servers/cannet-python-can/SMOKE.md):
    passive monitor (physical Rx on allocated participants, allocated TX
    not forwarded), full bidirectional bridge against real hardware, and
    the cross-server / CAN-over-IP gateway (Server A bridges Server B's
    `virtual:bus0` factory).
  - **Two GUIs, one virtual-bus server**: each subscribes, receives a
    distinct allocated id, and sees the other's transmissions as Rx.
  - **Frame timing**: a 500 kbps bus measurably staggers sustained
    fan-out by the computed frame duration (back-to-back frames don't
    collapse to one timestamp).
  Fold into the CI server-conformance suite above, or run as a focused
  pass, once a rig is available.
  - **Observed: periodic message-rate dips under PCAN loopback.**
    With calculated-field periodics running, the plot view shows the
    message rate sagging periodically. Suspected loopback / driver
    queueing rather than the scheduler (the fixed-grid scheduler
    absorbs work time and never bursts), but confirm against the
    perf-harness profiling counters during the hardware pass and rule out
    a fire-path stall (registry lock contention at high aggregate
    rates).
  - **Task 14 RBS test matrix, live legs.** The RBS exit criteria's
    send matrix (Tx rows with fields filled in over `local-virtual-bus`,
    hardware (sidecar) interfaces, and FD frames) is covered at the
    model layer by `rbs.rs` / `transmit_frames.rs` unit tests; the
    hardware-interface leg and an end-to-end FD-on-wire run need the
    same rig as the rest of this sign-off pass.

### Packaging and naming

- `[naming]` `sidecar.rs` internal identifiers `LaunchPath::BundledUv`
  and `bundled_uv_path()` predate the "fetched, not bundled" decision
  and should be renamed (e.g. `LocalUv` / `local_uv_path`) for
  consistency. User-facing strings and module docs are already
  updated; this is a code-only follow-up.

- `[dev]` **Dev server port is fixed, blocking concurrent `tauri dev`
  instances.** The Vite dev port lives in two places that must agree:
  [`apps/gui/vite.config.ts`](apps/gui/vite.config.ts) pins
  `port: 5173, strictPort: true` (hard-fails on a busy port rather than
  moving up) and [`apps/gui/src-tauri/tauri.conf.json`](apps/gui/src-tauri/tauri.conf.json)
  `devUrl` is statically `http://localhost:5173`. So a stale Vite
  server wedges dev, and two `tauri dev` sessions can't coexist (the
  symptom that surfaced this: a leaked `node.exe` holding 5173). Make
  the port env-driven across both sides — Vite reads
  `CANNET_DEV_PORT` (default 5173), plus a `dev:alt` script that runs a
  second instance on another port with a matching `tauri dev --config`
  `devUrl` override. Dev-mode only: the built app loads bundled assets
  (no 5173), so production multi-instance is unaffected — the real
  multi-instance blocker there is the shared `current/` scratch dir
  (see the disk-spill scratch item under *Host crates*). Lower
  priority: `cannet-server`'s `--bind` default
  `127.0.0.1:50051` is a fixed *default* (already overridable by flag);
  consider an ephemeral default so two standalone servers don't collide
  out of the box.
