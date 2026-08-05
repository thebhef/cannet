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

- The System Messages panel no longer has a restart button; sidecar
  restart lives only in Connection Management.
- Startup splashscreen with the safety disclaimer ships (wording and
  acknowledge behavior decided and documented).
- ~~The light-theme request is linked to a groomed token-layer
  task.~~ Done 2026-08-05 — promoted to
  [task 53](0053-theme-token-layer-light-theme.md).
- Connect/disconnect/configure feedback improvements are scoped into
  concrete changes and shipped.
- The sidecar writes a rolling logfile detailed enough that a
  per-channel connect failure (the VN17xx ch2 case) leaves a
  diagnosable trail; log location documented.
- Float readouts and y-axis ticks follow item 6's magnitude rule
  through one shared helper, thresholds and mantissa width read from
  settings, with tests pinning the boundaries (threshold edges, zero,
  log-mode).
