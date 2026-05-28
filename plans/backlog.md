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
Tasks" list is split across **Phase 11** (transmit signals,
shipped), **Phase 12** (DBC view + drag/drop), **Phase 14** (show
points), and **Phase 15** (hotkey framework) in
`phased-implementation.md`; the `ui-architecture-backlog.md` item
is left in `ui-architecture-backlog.md` and absorbed into Phase 16.

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

- `[feat]` `cannet-gui` plot panel: enum rendering for multi-signal /
  mixed areas. Phase 5 only switches to stepped + symbolic when an
  area shows exactly one signal with a `VAL_` table — that's the
  realistic single-state-channel case. Multiple enum signals on one
  area (each on its own symbolic strip), or one enum + numeric on
  the same axis, both want a different layout (multiple y-axes /
  per-signal step overlays). Pick this up alongside the per-trace
  y offset / gain work, which already needs the same plumbing.

### Transmit panel

- `[bug]` `cannet-gui` transmit panel / host TX path: a periodic
  transmit configured at a 1 ms tick is observed at ~20–40 msg/s on
  both the sending and receiving interfaces, not the requested
  ~1000 msg/s. The cap looks like roughly one transmit per UI tick /
  event-loop turn rather than a true 1 kHz scheduler. Investigate
  where the rate is being throttled — JS-side `setInterval` / rAF in
  [TransmitPanel.tsx](apps/gui/src/TransmitPanel.tsx), the Tauri
  command round-trip, or the host-side scheduler — and move the
  periodic loop fully host-side so the requested tick is honoured
  independent of UI frame rate. Reproduced with TX on one interface,
  RX on a second; both show the same ~20–40 msg/s ceiling.
- `[bug]` `cannet-gui` transmit panel: edits to a periodic message
  (payload, signal values, period, …) don't take effect on the
  in-flight transmit — the user has to Stop and Start the periodic
  for the new values to be sent. Apply edits live to the running
  periodic instead. Likely lands as part of the host-side periodic
  scheduler work in the TX-rate bug above.
- `[bug]` `cannet-gui` transmit panel: the signals view inside the
  panel doesn't refresh reliably when the underlying message / DBC
  state changes. May be obviated by the planned transmit-panel
  refactor (host-side periodic scheduler + signal-to-bytes encoding
  in `cannet-dbc`); revisit after that lands and drop this item if
  the refactor covers it.

### Cursors and markers

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
- `[ui]` `cannet-gui`: **bus bitrate is not surfaced in the GUI.** A
  user on an unfamiliar bus has no way to see what bitrate (or FD
  data bitrate) a bus is configured at — there's no readout on the
  bus node in the project / graph view, nor in any panel. Today the
  bus speed lives in host-side per-interface config and travels with
  subscribe calls (see the related `[wire]` `Subscribe`
  per-interface bitrate item below); expose the configured
  `bitrate_bps` / `data_bitrate_bps` / `fd` on the bus element so it
  reads in the project panel and graph node, and once it's editable
  from the GUI, make it settable there too.
- `[ui]` `cannet-gui`: a global UI frame-rate / responsiveness readout
  (rAF-based FPS, maybe long-task / dropped-frame counts) — the plot
  panel shows its own re-sample rate now; generalise that to a small
  always-available indicator so other panels' costs are visible too.
  Useful while tuning the trace virtualizer and any future heavy view.
- `[ui]` GUI-wide visual restyle: adopt the dark "scope" visual
  language from `plans/plot-panel-reference.html` (the prototype's colour
  variables, monospace type scale, panel chrome, control styling) across
  the toolbar, trace panels, project panel, etc. — currently each panel
  has its own ad-hoc styling in `apps/gui/src/index.css`. Approved in
  principle; do it as one deliberate pass once the plot panel's own
  styling has settled, not piecemeal.

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

- `[perf]` `cannet-core`: revisit `CanFramePayload::Classic`/`Fd` to share
  a fixed-size inline buffer instead of `Vec<u8>` once the trace store /
  benchmark in Phase 20 shows allocator pressure.
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
- `[feat]` Linux `vcan` via socketcan as a writable CAN source. Phase 5
  ships an in-memory loopback bus in `cannet-core` and a
  `cannet-server --loopback` mode that covers demo and test; an actual
  local virtual-bus device on Linux is the honest follow-up. Reconsider
  alongside or after Phase 8 hardware work — PEAK's Linux kernel driver
  path could go via socketcan too.

### Packaging and naming

- `[naming]` `sidecar.rs` internal identifiers `LaunchPath::BundledUv`
  and `bundled_uv_path()` predate the "fetched, not bundled" decision
  and should be renamed (e.g. `LocalUv` / `local_uv_path`) for
  consistency. User-facing strings and module docs are already
  updated; this is a code-only follow-up.
