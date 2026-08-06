# Task 52 — Usage-Feedback Round: Startup, Sidecar, Connections

Feedback captured 2026-08-05 from real usage. A grab-bag in the task-25
style: concrete, independently-shippable items rather than one feature.
Each item below either ships from here or gets groomed into its own
task when it turns out to need design work.

## Items

### 1. Sidecar restart button doesn't belong in System Messages

The System Messages panel carries a "Restart sidecar" button
([SystemMessagesPanel.tsx:198](../../apps/gui/src/SystemMessagesPanel.tsx#L198)).
The project panel's "Local interfaces" row already has an
unconditional Restart button (`LocalInterfacesRow`,
[ConnectionManagement.tsx:695](../../apps/gui/src/ConnectionManagement.tsx#L695)),
so nothing is lost.

**Groomed 2026-08-05:** pure deletion — no tooltip migration (the
crash-budget wording is more than an end user will parse). Also fix
the stale `LocalInterfacesRow` doc-comment, which claims Restart only
renders when the sidecar isn't ready; it renders unconditionally.

### 2. Startup splashscreen with safety disclaimer

Show a splashscreen at startup carrying a usage/safety disclaimer,
approximately:

> Make sure the system you are connecting to is in a safe state to
> have its CAN traffic disrupted. Cannet can make unsafe changes to
> network traffic.

**Groomed 2026-08-05:**

- Shows **every launch**; no acknowledge-once state, no click-through
  gate.
- Doubles as the loading screen: auto-dismisses at
  `max(5 s, scratch-capture restore complete)`. The DS-7
  `restore_scratch_capture` step is the gate (it settles last, inside
  the project-apply flow, and scales with capture size) — the splash
  drops only when the app is interactive with restored data.
- Implementation: **in-app full-window overlay** rendered by React,
  not a second Tauri window. Gating on the restore is then a plain
  frontend state transition, testable in vitest; the sub-second blank
  flash before WebView boot is accepted.

### 3. Light theme requested

A user asked for a light theme. **Groomed 2026-08-05:** promoted to
[task 53](0053-theme-token-layer-light-theme.md) (theme token layer
first, then the light theme setting). The backlog's former light-mode
entry was split: the theme half moved into task 53; UI density stays
in the backlog. Nothing further to do under this task.

### 4. CAN connections: richer connect/disconnect/configure feedback

Users want more feedback around connecting, disconnecting, and
configuring CAN connections — clearer in-progress / success / failure
states.

**Groomed 2026-08-05** (feedback-giver is technical; session included
joint log-reading that found the logs useless for troubleshooting).
Three confirmed gaps plus one observation:

- **(a) No in-place connect/disconnect response.** Clicking
  Connect/Disconnect shows nothing at the point of action; outcomes
  are only discoverable in System Messages.
- **(b) Per-interface/channel state is invisible.** Can't tell which
  of a device's channels are actually up (see item 5's VN17xx ch2
  incident).
- **(c) Configure is unacknowledged.** Bitrate/FD changes apply with
  no confirmation of what actually took effect.
- **Observation to investigate:** several bitrate-adjust attempts in
  the UI produced only *one* command in the logs. Either the frontend
  swallows repeat attempts (e.g. a no-change guard misfiring) or the
  command path under-logs. Root-cause before designing (c)'s
  confirmation — the fix may be in the pipeline, not the UI.

UI shape: **inline in the project panel** — each binding row grows a
state (`connecting… / connected / error: <short reason>`), configure
echoes the values the driver actually applied (from the response, not
the request), and each logical bus row gets a connection-state marker
mirroring its binding's state (`unbound / connecting / connected /
error` — a project bus has at most one binding, so no aggregation).
No new panel.

The command-level observability half (log every UI-initiated
connect/configure/disconnect with intent and result) overlaps item 5;
the sidecar logfile is where the detail should land.

### 5. Python sidecar: its own detailed rolling logfile

The python-can sidecar should write its own more detailed rolling
logfile, separate from the host log, so hardware-level failures are
diagnosable after the fact.

Motivating incident: on a single 4-channel Vector VN17xx, channels 1,
3, and 4 connected fine but channel 2 refused to connect. Current
logging wasn't detailed enough to say why.

**Groomed 2026-08-05:**

- **Path from supervisor:** new `--log-file <path>` flag; the GUI
  host (and later the cannet server, task 41) passes
  `<app_log_dir>/sidecar-python-can.log` — same directory as the
  host's rolling `cannet.log` (`crash.rs` precedent). No flag → no
  file; standalone `uv run` behavior unchanged.
- **Rotation:** stdlib `RotatingFileHandler`, ~5 MB total budget
  (e.g. 1 MB × 5 generations). No new dependency.
- **Levels split:** the file always logs at **debug** — every gRPC
  command with args and result, python-can / vendor-backend errors
  with full tracebacks (what the VN17xx case needed). stderr keeps
  the existing `--log-level` behavior, so System Messages don't get
  noisier.
- **Discoverability:** the startup banner (and/or a System Message)
  states the logfile path.

### 6. Float readouts: fix the exponential cutover rule

Task 50 item 10 (git history) replaced the plot's float formatting
with a "plain unless it needs more than 5 decimals" rule
(`fmtSigFigs` / `MAX_PLAIN_DECIMALS` in
[plotPanelConfig.ts](../../apps/gui/src/plotPanelConfig.ts)). The
rule interacts badly with the sig-fig budget: any value in (0, 1)
carrying a full 6-significant-digit mantissa needs ≥ 6 decimals, so
`0.123456` renders `1.23456e-1` — real float signals almost always
have full mantissas, so effectively everything below 1.0 reads
exponential.

**Groomed 2026-08-05:**

- **When: a pure magnitude rule, the same in every view.**
  Exponential iff `|v| < 1e-4` or `|v| >= 1e6`; `0` always plain
  (never `0.00000e+0`); plain otherwise at the view's sig-fig
  budget, no padding. `0.0001` stays plain, `0.00001` goes
  exponential; worst plain case is nine decimals of real digits
  (`0.000123456`). (For reference: before task 50 the readouts
  switched below `1e-6` via `toPrecision(6)` and the ticks below
  `1e-3` — one too lax, the other too eager.)
- **Mantissa: exactly 5 decimals in exponential form**, one shared
  helper for every view — `1.23457e-4`, and literally exactly:
  `1.00000e-6`, not the current trailing-zero-trimmed `1e-6`.
- **User-configurable:** the two magnitude thresholds and the
  mantissa decimal count are settings, with the values above as
  defaults.
- **Scope:** value readouts and y-axis tick labels through the common
  helper; the x (time) axis keeps its existing formatting. A
  **log-scaled y-axis always labels exponentially**, regardless of
  magnitude.

Tests updated with the rule, pinning the threshold edges and zero.

## Exit criteria

- ~~The System Messages panel no longer has a restart button; sidecar
  restart lives only in Connection Management.~~ Done 2026-08-06 —
  `ca0c337`.
- ~~Startup splashscreen with the safety disclaimer ships (wording and
  acknowledge behavior decided and documented).~~ Done 2026-08-06 —
  `cd19690`.
- ~~The light-theme request is linked to a groomed token-layer
  task.~~ Done 2026-08-05 — promoted to
  [task 53](0053-theme-token-layer-light-theme.md).
- ~~Connect/disconnect/configure feedback improvements are scoped into
  concrete changes and shipped.~~ Done 2026-08-06 — `10f9ee0`,
  `bb82ad3`, `2b2e30f`.
- ~~The sidecar writes a rolling logfile detailed enough that a
  per-channel connect failure (the VN17xx ch2 case) leaves a
  diagnosable trail; log location documented.~~ Done 2026-08-06 —
  `f9103b9`, `17d57dc`, `8bf8c59`.
- Float readouts and y-axis ticks follow item 6's magnitude rule
  through one shared helper, thresholds and mantissa width read from
  settings, with tests pinning the boundaries (threshold edges, zero,
  log-mode).

## Status log

### 2026-08-06 — item 1: sidecar restart button deleted (`ca0c337`)

Pure deletion, as groomed. `SystemMessagesPanel.tsx` lost the button,
its `restartSidecar` handler, its crash-budget tooltip, and its now-
unused `invoke` import; no tooltip text migrated anywhere. The project
panel's `LocalInterfacesRow` Restart is untouched and is now the only
restart in the app.

Its stale doc-comment ("when the sidecar isn't ready, the row surfaces
… a Restart button") now says what is true: the state indicator reads
ready/starting/offline and Restart is always available.

No test asserted the deleted button, so no DOM test changed. Docs in
the same commit: README ×2 and `servers/cannet-python-can/SMOKE.md`
each named "Restart sidecar" as a clickable thing; they now point at
the project panel's **Local interfaces → Restart**.

Suite after: 1413 tests / 121 files, green; `pnpm --dir apps/gui build`
green. No host code touched.

### 2026-08-06 — item 2: startup splash (`cd19690`)

In-app full-window React overlay (`SplashOverlay.tsx`), rendered last
inside `main.app` above the modal layer (`z-index: 1000`). Carries the
existing (previously unused) `src/assets/logo.svg`, the app name, the
approved disclaimer verbatim under a **Warning:** lead-in, and a
"Starting up…" line. No new asset, no acknowledge state, nothing
persisted, no click-through.

Dismissal is `max(5 s, boot settled)` via `useSplashVisible(bootSettled)`
— a floor timer started at mount, ANDed with a `bootSettled` flag. The
flag is set in `App.tsx`'s boot open IIFE (the one behind
`bootOpenRanRef`) right after the `open_project` → `applyProject`
block, whose last step is the DS-7 `restore_scratch_capture`. All three
outcomes reach it: project applied, no project to open, or the
open/apply `catch`. **No host-side change was needed** — the restore
already settles inside a frontend-awaited call, so nothing new is
observable from the host and no Tauri command was added.

Tests (+5): `SplashOverlay.dom.test.tsx` — three fake-timer cases
pinning the max (settles first / settles late / settles mid-floor) plus
a render assertion on the disclaimer text; `App.splash.dom.test.tsx` —
boots the whole App with `restore_scratch_capture` rejecting and
asserts the overlay is up at first paint and gone afterwards, which is
the "never hangs on a failure path" guard. Suite after: 1418 tests /
123 files, green; build green.

README § Running gained the splash paragraph (wording, no-acknowledge
behavior, and the loading-screen role).

### 2026-08-06 — item 5: sidecar rolling logfile (`f9103b9`, `17d57dc`, `8bf8c59`)

Three commits, each green.

**`f9103b9` — the sink.** `--log-file <path>` on the sidecar, backed by
a stdlib `RotatingFileHandler` at 1 MiB × 5 generations (~5 MB on
disk). **No new dependency** — nothing was added to `pyproject.toml`.
The level split is the whole point and works like this: the root
logger drops to `DEBUG` so the file handler sees everything, and
`--log-level` moves onto the *stderr handler*, which is what keeps
System Messages at exactly the verbosity they had. The banner tree
(`propagate=False`) gets the file handler attached directly, so
enumeration results and the bound address are in the file too. No
flag → no file, so standalone `uv run` is untouched; an unopenable
path warns and continues rather than failing the boot. The path is
announced on a new `sidecar\tlogfile\t<path>` banner line.

**`17d57dc` — the content.** Every command now leaves a debug record
with args and outcome: `ListInterfaces` ids (not just the count),
`Subscribe` with interface id and ok / unknown / open-failed,
`Unsubscribe`, `ConfigureBus` with the requested wire values *and* the
`OpenConfig` the driver was handed, `Session` open/close naming the
interfaces released, `WatchInterfaces` stream lifecycle, and channel
open / reopen / close in `shared_interface`. Failures carry
`exc_info=True`. **Debug, not warning, deliberately** — the records
exist for the file, and promoting any of them would have made the
panel noisier, which the groomed spec forbids. `reconfigure`'s
pre-existing warning is untouched; its traceback goes to the debug
sink alongside it.

**Streaming-path boundary (the decision asked for):** *lifecycle and
faults, never per-frame or per-batch content.* `_handle_tx` logs
nothing at all — not per frame, not per batch — and says why in its
docstring; TX rejections already reach the client as `TX_REJECTED`
envelopes. What *is* logged on the frame paths: channel open /
reconfigure / close with the config, pump crashes, unencodable-frame
drops (already first-only), and the existing 2 s periodic rx/tx rate
lines. A saturated bus reaches `_handle_tx` thousands of times a
second; a record there would rotate the whole 5 MB away in seconds
and put a logging call on the hot path for it. A regression test
transmits 64 frames and asserts none of their CAN ids appear in the
log.

**`8bf8c59` — the supervisor.** The host resolves
`<app_log_dir>/sidecar-python-can.log` (via `crash::log_dir()`, so it
is literally the same directory as `cannet.log`), creates it, and
passes `--log-file` through `apply_sidecar_settings` — which every
launch flavour including the frozen binary already routes through. A
log directory that can't be created costs the logfile, not the
sidecar. `classify_stdout_line` learns the `logfile` banner at Info
(like `listening`): it answers "which file do I attach to the bug
report", so it must be readable at the panel's default filter.

**Would it have explained the VN17xx?** Verified end-to-end against
real hardware (2 PCAN FD channels on this machine): the file carried
the banner + enumeration, python-can's own
`can.interfaces.vector.canlib` warning about the missing `vxlapi64`,
and `can.interface.detect_available_configs` at debug — i.e. the
vendor layer's own account of what it found. On the ch2 path a
refused open now writes the driver traceback with the vendor error
text intact, which is exactly what was missing.

**Docs, same commits:** the top-level README's Phase-8 section gained
a "Detailed sidecar logfile" paragraph (per-OS path, always-debug,
5 MB rotation, the streaming boundary, "no flag → no file" for
hand-runs); the sidecar's own README gained a "Logging: two sinks"
section; `__main__.py`'s module docstring documents the two-sink model
and the boundary, and `service.py`'s and `sidecar.rs`'s docstrings
restate it where the code lives.

**Tests.** Python: +13 (`tests/test_log_file.py` ×6 — default,
no-file, the debug/stderr split, rotation budget, banner mirroring,
unopenable path; `tests/test_command_logging.py` ×7 — enumeration
ids, subscribe outcome, the refused-channel traceback, unknown
interface, configure requested-vs-applied, open/close, and the
no-per-frame boundary). Sidecar suite 89 → **102 passed**; ruff +
mypy clean. Rust: +3 in `sidecar.rs` (`--log-file` on every launcher,
`None` → no flag at all, the banner's level and path);
`cargo test -p cannet-gui` **465 passed**, `cargo clippy -p cannet-gui
--all-targets` clean. Frontend untouched (zero files changed under
`apps/gui/src`): `pnpm --dir apps/gui test` ran 1418 tests / 123 files
with one flake — see below.

### 2026-08-06 — item 4, STEP 0: the under-logging observation, root-caused

Both recorded hypotheses are **falsified**. The cause is a third thing
neither of them named.

**Observation (raw).** During the joint log-reading session, several
bitrate-adjust attempts in the UI produced exactly one `ConfigureBus`
record in the sidecar logfile.

**Hypothesis A** — the frontend swallows repeat attempts (a no-change
guard misfiring). **Hypothesis B** — the command path under-logs.

**Experiment 1 (falsifies B).** Enumerate every `ConfigureBus`
send-site in the tree:
`grep -rn "ConfigureBus\|configure_bus" --include=*.rs --include=*.py
--include=*.proto --include=*.ts --include=*.tsx .`

**Data.** The only sender is
[`cannet-client/src/lib.rs:588`](../../crates/cannet-client/src/lib.rs#L588)
— `run_session`'s pre-subscribe loop, which walks `subscriptions` once
at session establishment and emits one `ConfigureBus` per subscription
that carries a `PreSubscribeConfig`. The public
`SessionTransmitter::configure_bus` (same file, line 467) exists and
is documented, but `grep` over `apps/gui/src-tauri/src/` and
`crates/` finds **zero call sites** outside the crate's own tests.
So every `ConfigureBus` that can reach the sidecar is already logged
by 52.B's `_handle_configure` record. Nothing is under-logged.

**Experiment 2 (falsifies A).** Trace the UI edit path:
`BusHardwareConfig`'s bitrate input → `onSetSpeed` →
`p.onUpdateBus(bus.id, { speed_bps })` → `handleUpdateBus` in
`App.tsx`.

**Data.** `handleUpdateBus` mutates the project's `buses` array and
nothing else — no `invoke`, no debounce, no guard. The bus's
`speed_bps` / `fd` / `fd_data_speed_bps` are read exactly once, in
`handleConnect`, where they become the `bindings` payload of
`connect_remote_server`; the host turns them into
`PreSubscribeConfig` via `presubscribe_config_from`
([session.rs:212](../../apps/gui/src-tauri/src/session.rs#L212)).
There is no guard to misfire: an edit while connected issues no
command of any kind.

**Conclusion (the third thing).** *There is no configure-while-
connected path at all.* A hardware-config edit is a project-model
edit; the value reaches the wire only as a pre-subscribe envelope on
the next connect. N edits followed by one connect therefore produce
exactly one `ConfigureBus` — which is what the log showed. Two
corollaries fall out of the same read:

- `presubscribe_config_from` returns `None` when **both** `speed_bps`
  and `fd` are unset, so a bus left on the placeholder ("500 kbit/s"
  greyed in the input) sends **no `ConfigureBus` whatsoever** and runs
  on the driver's own default. The UI gives no hint that the number
  it is showing was never sent.
- The only existing acknowledgement is the `pending` chip on the bus
  row (`busesWithPendingHwConfig`), which says "reconnect to apply"
  but not *what is live now*.

**Not a code defect; a missing capability.** No failing test was
landed for the observation itself, because nothing in the shipped code
does the wrong thing — it does nothing, by construction. What item 4
lands instead is the display that makes the construction visible (see
the item-4 entry below), and the real defect found while tracing the
same path (silently-dropped bindings) *does* get a failing test first.

### 2026-08-06 — item 4: connect/disconnect/configure feedback (`bb82ad3`, `2b2e30f`)

Two code commits after the STEP-0 doc commit above. Inline in the
project panel, as groomed — no new panel.

**The model is host-side.** New `connection_state.rs`: a
`ConnectionStates` singleton keyed by **bus id**, because a project bus
has at most one binding (ADR 0023) — one binding, one state, nothing to
aggregate. `BusConnState` is `connecting | connected { applied } |
error { reason }`; a bus with no entry has no session. The frontend
hydrates once through `get_connection_states` and then follows the
`connection-states-changed` event — the same pull-then-follow shape as
`useSidecarStatus` and the interface cache (ADR 0016), so nothing polls
and nothing accumulates. `useConnectionStates` renders it and derives
exactly one thing itself: "this bus has no binding", which is a project
fact, not a connection fact.

**(a) In-place response, on the real outcome.** Every transition is
driven by something that actually happened, never by "the request was
dispatched": the buses go to `connecting…` before `list_interfaces`,
and leave it on the list result, the subscribe result, the
session-register result, the pump-spawn result, the pump's exit, or the
disconnect. `disconnect_remote_server` retires the rows from the
ending sessions' own `channel_to_bus` rather than racing the pumps'
cleanup for them.

**(b) Per-interface state — and the real defect.** Tracing the same
path turned up a silent failure worth its own failing test: bindings
whose interface the server's enumeration doesn't carry were dropped by
the subscription `filter_map`, so that bus never received a frame while
the panel read "connected" — precisely the VN17xx ch2 symptom. They now
warn on the system log and take an `error: not exposed by <address>`
state of their own; the rest of the card still connects.
`split_by_availability` is the seam, and
`a_binding_the_server_does_not_expose_is_reported_not_dropped` is the
regression guard. On the UI side each bound interface row under
*Connection* carries its bus's state, so ch1/3/4 connected + ch2 error
reads at a glance.

**(c) Configure acknowledged — honestly.** A connected bus row grows a
`live:` line with the configuration the host **actually put on the
wire**, which differs from the input fields in exactly the two places
the fields can't show: nothing pinned means no `ConfigureBus` was sent
at all (the row says `driver default (nothing sent)` instead of
echoing the greyed 500 kbit/s placeholder), and an FD bus with a blank
data rate rides the nominal rate. It is *not* "what the driver
applied" — see Blockers; that value does not exist anywhere in this
stack.

**Bus-row marker.** `unbound` / `not connected` / `connecting…` /
`connected` / `error: <reason>`, in the same `project-bus-state` idiom
the sidecar and remote-server rows already use. "not connected" is the
fifth state the groomed list didn't name: a bus that *is* bound but has
no session is neither unbound nor errored.

**Tests.** Rust +12 (`connection_state` ×6 — the transitions, the
independent-per-bus VN17xx shape, the no-op suppression that keeps
redundant events off the WebView, and the serialized wire shape;
`session::connect_outcome_tests` ×6 — the availability split and all
four applied-config normalisations). `cargo test -p cannet-gui` 465 →
**477**; clippy `--all-targets` and `cargo fmt --check` clean.
Frontend +16 in `ProjectPanel.connectionState.dom.test.tsx` (the two
pure formatters, the bus-row marker incl. unbound and the reason text,
the applied echo appearing only when connected, the change event
updating without a refetch, and the four-channel device rendering four
independent binding states). `pnpm --dir apps/gui test` 1418 →
**1434** / 124 files, `pnpm --dir apps/gui build` green.

**Docs, same commits:** README § Phase 6 gained a *Connection
feedback* subsection (the five markers, where the state comes from,
the applied-vs-requested distinction and why it is "sent" not
"applied"); `connection_state.rs`'s module docs carry the same
reasoning where the code lives.

### Blockers / side effects

- **"What the driver actually applied" does not exist in this stack.**
  Item 4(c) was groomed as "echo the values the driver applied, from
  the response". There is no response: ADR 0022 makes `ConfigureBus`
  deliberately fire-and-forget, the proto has no acknowledgement
  message, and `_handle_configure` only *logs* requested-vs-applied
  (52.B) — it sends nothing back. One layer down it is the same story:
  the sidecar's `OpenConfig` is an input to `Driver.open`, and no
  `OpenChannel` reports the timing registers the controller settled
  on. So the deepest available truth is "the configuration the host put
  on the wire", which is what shipped and what the UI labels it as. A
  true applied-echo would need a new server→client envelope (or a
  bidirectional `ConfigureBus`), a `cannet-client` side-channel to
  surface it — the rx loop currently *drops* inbound `ConfigureBus`,
  `Log` and `InterfaceState` — and a driver-protocol addition. That is
  a wire-model decision, so it wants an ADR, not a drive-by.
- **Editing a bitrate while connected still applies nothing.** The
  STEP-0 finding, left as-is: `SessionTransmitter::configure_bus`
  exists with zero callers, and no Tauri command reaches it. The row's
  `pending` chip plus the new `live:` line now make the situation
  legible ("you typed 250k; 500k is what is running; reconnect to
  apply") rather than silent, but a live configure path is a separate
  change — it needs the acknowledgement question above answered first,
  which is exactly why the groomed note said to root-cause before
  designing (c).
- **`cannet-client`'s rx-loop comment is stale.** It says wire `Log`
  / `InterfaceState` / `ConfigureBus` envelopes "have no consumer in
  this crate; the GUI host bridges them into its own surfaces". The
  host does not — they are dropped in `run_session`. The sidecar's
  per-channel error text reaches System Messages via its *stderr*,
  not via the wire. Left alone: it is a comment in a crate this phase
  didn't otherwise touch, and correcting it properly is part of the
  side-channel work above.
- **`is_per_frame_error_code` treats `UNKNOWN_INTERFACE` as fatal.**
  A sidecar that refuses one channel replies `CODE_UNKNOWN_INTERFACE`,
  which ends the whole rx loop — so one dead channel can still take
  its siblings down *if the refusal happens at subscribe time on the
  server*. The host-side fix in this phase covers the case the server
  never advertised the interface at all (the enumeration gap); it does
  not change the wire's fatality classification. Noticed, not fixed —
  changing it is a `cannet-client` behaviour change outside item 4.
- **Item 4 was not verified in a running window.** `cargo test` +
  `clippy` + `pnpm test` + `pnpm build` are green; the new markers were
  not eyeballed against real hardware in a `tauri dev` launch this
  session.
- **One `PlotPanel.dom.test.tsx` case flaked under full-suite load**
  (1 failed / 1417 passed, inside `withSizedCanvas` at
  `PlotPanel.dom.test.tsx:2722`). Re-running that file alone passes
  all 76 of its tests, and this branch changes zero files under
  `apps/gui/src`, so it is load-dependent timing in the plot suite,
  not a regression from item 5. Left alone rather than chased — it is
  neither in scope nor reproducible in isolation.
- **`_handle_subscribe` only catches `KeyError` and `OSError`.** The
  default driver wraps every open failure in `OSError`
  (`driver_python_can.open`), so the real path is covered — but a
  replacement driver module (`CANNET_DRIVER_MODULE`) that lets a
  `can.CanInitializationError` escape would take down the whole
  session through `request_pump`'s broad handler, not just the one
  channel. Noticed while adding the traceback log; **not fixed**, as
  changing the catch is a behaviour change outside item 5's scope.
- **The debug file inherits third-party debug records.** Root at
  `DEBUG` means `can.*` and `grpc.*` debug output lands in the file
  too. Checked before committing to it: python-can debug-logs only on
  the open/enumerate paths (three call sites across `bus.py` and the
  Vector `canlib.py`) and grpc's Python layer has none per call, so
  there is no per-frame amplification. This is a feature — the
  vendor layer's own account is what a hardware post-mortem wants —
  but a future python-can that logs per message would land inside the
  budget silently.
- **The App-level splash test costs ~5.2 s of wall clock.** The floor
  is a module constant, and driving the whole App boot under fake
  timers risks dockview/ResizeObserver interactions, so the test waits
  the real 5 s. The suite went 31.8 s → 31.7 s (it runs in parallel
  with the slower plot files), so nothing was actually lost — but the
  file is the slowest single test in the frontend suite.
- **The overlay covers self-driving perf runs (ADR 0031) for their
  first ≥ 5 s.** `perfInteract` dispatches DOM events at elements
  directly rather than hit-testing, so the overlay cannot swallow a
  gesture, and the harness brackets its measurement after a warm-up —
  but a run whose capture window starts within 5 s of boot now paints
  one extra full-window layer. Left in deliberately: the groomed spec
  says "every launch", and suppressing it under automation would be a
  second code path with nothing testing it.
- **Not verified in a running window.** `pnpm test` + `pnpm build` are
  green; the splash's actual look was not eyeballed in a `tauri dev`
  launch this session.
