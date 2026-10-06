# cannet-local-sidecar

Auto-launched Python sidecar that exposes Vector, Kvaser, and PEAK
hardware channels over the [`cannet-wire`](../../crates/cannet-wire)
gRPC protocol — the same wire the in-tree BLF replay server speaks.

The GUI host (`cannet-gui`) starts this process at launch via the
bundled [`uv`](https://docs.astral.sh/uv/) binary. End users do not
run anything in this directory by hand.

## Layout

```
cannet-local-sidecar/
├── pyproject.toml              # uv-managed environment
├── cannet_local_sidecar/
│   ├── __init__.py
│   ├── __main__.py             # `uv run cannet-local-sidecar` entry
│   ├── server/                 # gRPC service implementation
│   │   ├── service.py          #   the servicer, the Session stream
│   │   ├── shared_interface.py #   one shared channel + its pump threads
│   │   ├── outbox.py           #   a session's control and data lanes
│   │   └── episodes.py         #   bus-error episodes and the row cap
│   ├── bench/                  # fault-recovery bench (not shipped)
│   ├── driver.py               # internal driver-adapter interface
│   └── driver_python_can.py    # default python-can-backed adapter
├── tests/                      # pytest, hardware-free
├── SMOKE.md                    # per-vendor manual smoke procedures
└── LICENSING.md                # LGPL diligence for vendor driver libraries
```

## Run locally (developer)

From the repo root, with [`uv`](https://docs.astral.sh/uv/) on `PATH`:

```sh
uv --directory servers/cannet-local-sidecar run cannet-local-sidecar
```

The default `--bind` is `127.0.0.1:0` — the OS picks any free
ephemeral port and the sidecar prints the actual address on the
`sidecar\tlistening\t<addr>` banner line, which is what the GUI host
reads to discover the port. Pinning a specific port still works
(`--bind 127.0.0.1:50061`); if that port is in use, the sidecar
logs a warning and falls back to a random port rather than refusing
to start, so a developer can never wedge themselves out of the
sidecar by leaving a stale instance behind.

With **no hardware and no `python-can` installed** the process still
boots and reports zero interfaces — the GUI uses this as the "no
vendor hardware plugged in" state, not as a failure.

The banner is intentionally machine-readable:

```
sidecar    version       0.1.0
sidecar    interfaces    0
sidecar    listening     127.0.0.1:49725
```

`interface\t<id>\t<display_name>\t<fd?>` lines appear before
`sidecar\tlistening\t...` when there is hardware to enumerate. The
port in `listening` is the OS-assigned one when `--bind` was left at
its default — never a hard-coded value.

## Logging: two sinks

`--log-level` (default `info`) governs **stderr only**. The GUI host
turns each stderr line into a System Message, so this is the knob for
how much the sidecar contributes to what a user sees.

`--log-file <path>` adds a second sink that **always records at
debug**, whatever `--log-level` says: every gRPC command with its
arguments and outcome, and every driver traceback. It rotates at 1 MB
across five generations (~5 MB of disk, stdlib `RotatingFileHandler`,
no extra dependency), and the path is echoed on a
`sidecar\tlogfile\t<path>` banner line. There is no default — no
flag, no file — so a developer running the sidecar by hand gets
exactly the behaviour they always did. The GUI host passes
`<app_log_dir>/sidecar-python-can.log`, next to its own `cannet.log`.

The frame streams are the deliberate exception to "log every
command": transmit and receive log their lifecycle and faults
(channel open / reconfigure / close, rejections, pump crashes, plus
the existing periodic rx/tx rate lines) but never per-frame content.
A record per frame would rotate the whole budget away in seconds on a
busy bus and put a logging call on the hot path. The same boundary is
enforced on bundled python-can interfaces that log per frame
internally: PCAN's backend (`can.pcan`) logs two debug records per
transmitted frame inside its own `send()`, so it is capped at `info`
in the file — otherwise design-load traffic through the file handler
throttles the very transmit path the file exists to diagnose.

## Wire model

The sidecar implements the **hardware-server wire model** described in
[ADR 0022](../../docs/adr/0022-hardware-server-model.md):

- `ListInterfaces` / `WatchInterfaces` enumerate the driver's
  channels (ADR 0016). Enumeration runs on subscribe (the
  `WatchInterfaces` seed) and on each explicit `ListInterfaces` pull —
  **not** on a timer: on PCAN the global channel-enumeration call
  serialises against `CAN_Write`, so periodic re-enumeration stalled
  active transmits. A hot-plug while connected is picked up by the
  next `ListInterfaces` (the GUI's "Discover" button), which ADR 0016
  leaves to the server's discretion.

  Each listed `Interface` carries optional **adapter identity** —
  `driver_name`, `driver_version`, `firmware_version`,
  `serial_number` — filled with what the vendor's enumeration exposes
  and **left unset everywhere it does not**. PEAK reports the
  PCAN-Basic API version and the device firmware version (PCAN-Basic
  has no hardware-serial parameter; the PCAN-View device id in the
  channel's `uid:` is not one). Vector reports the XL driver library's
  version and the card serial. Kvaser and the virtual bus report none
  of it, and encode exactly as they did before the fields existed. No
  field is ever substituted with a placeholder: a reader renders absent
  as absent.
- A physical channel is **opened once and shared** across every
  subscribed session. A reference count on `Subscribe` /
  `Unsubscribe` drives start / stop; the first subscriber opens the
  python-can `Bus`, the last unsubscriber closes it.
- Multi-client is the python-can backend's native behaviour:
  multiple sessions can subscribe to the same interface
  concurrently; rx fans out to every subscriber, and any subscriber
  can tx.
- `Body::ConfigureBus { interface_id, speed_bps,
  fd_data_speed_bps?, fd_enabled, error_row_cap? }` updates the
  interface's open config. If the interface is currently open **and**
  the open-configuration fields (bitrate, FD, listen-only) actually
  change, the underlying bus is closed and reopened with the new
  config; a `ConfigureBus` that leaves them unchanged — e.g. one that
  only carries a new `error_row_cap` — applies without reopening a
  live bus (ADR 0060). Conflict semantics under concurrent clients are
  deliberately whatever python-can does (ADR 0022 § Known unknowns).
  `error_row_cap` sets the error-row cap (see *Bus faults*); unset is
  the default, 16.
- `Body::InterfaceState { interface_id, state, tec, rec,
  rx_overruns?, as_of_ns }` is pushed: a snapshot on each `Subscribe`,
  a fresh push whenever any of them changes, and a heartbeat every
  second regardless, each stamped with when it was read (`as_of_ns`,
  the frames' wall clock) so a reading that stopped arriving is
  visibly stale. The controller is read every 250 ms. A PEAK `recv`
  that fails because PCAN-Basic answered the read with bus-off or
  error-passive is a fault reading, published as that state — never
  `unavailable`, which is for an adapter that has gone. On PEAK the
  state comes from the error counters its error
  frames carry (cleared to 0/0 when a whole poll passes with no error
  frame and a status word reporting no bus error), on Vector from the
  chip-state events its XL driver reports (both floored by the vendor's own status word, neither able
  to talk the other down); everything else falls back to python-can's
  `Bus.state`, which most backends do not implement. TEC / REC are
  reported as 0 wherever they are not exposed. The Vector path has
  not been run against Vector hardware.
- **An echo from an error-passive transmitter is withheld.** PEAK's
  echo of our own frame fires when the frame goes onto the wire, not
  when a node acknowledges it, so with the cable pulled a PEAK
  transmitter retransmits forever and echoes every attempt. While the
  channel's TEC is above 127 (error-passive, which 16 consecutive
  failed transmissions reach) an echo (`is_rx` false) is dropped in
  `recv` and produces no `Tx` frame. Vector gets the same gate as a
  precaution — its documentation does not say whether a transmit
  receipt waits for the acknowledge; Kvaser does not, because CANlib
  documents its echo as a successful transmission. The running total
  is the `echoes_dropped=` field of the periodic `rx stats` line.

  `rx_overruns` counts occasions on which the driver reported that
  received frames were lost before reaching the sidecar — **reports,
  not frames**: PEAK sets two bits in its channel status word and
  Vector sets a queue-overflow flag on an event, and neither says how
  many went missing. PEAK counts an episode per rising edge of those
  bits, since they stay set for as long as the condition lasts; Vector
  counts each flagged event on the classic queue, and reports *nothing*
  on an FD channel because the FD event's overflow flag is not among
  python-can's own definitions. The field is **omitted entirely** for a
  backend that does not watch for receive loss, which is a different
  answer from zero: zero is the reading that says a capture is the
  whole of what the bus sent.
- **A stuck controller is brought back by the state poll.** A
  controller read bus-off for a second is reset — in place on Vector
  and Kvaser, by closing and reopening the channel with its current
  config elsewhere, PEAK included (the channel is opened without
  `PCAN_BUSOFF_AUTORESET`, which would reset it unseen inside the
  poll's own status read and leave a full transmit queue stalled).
  Sends the driver refuses as bus-off (PEAK's `PCAN_ERROR_BUSOFF` text)
  count as a bus-off reading whatever the state read says. Every
  reopen — this one, the ones below, and a `ConfigureBus` — closes the
  old channel **before** opening the fresh one: PCAN-Basic refuses
  `CAN_Initialize` on a handle the process still holds. If the open
  then fails, the interface has no channel: it reads `unavailable`,
  sends are refused (`closed`, naming the open's error), and the open
  is retried every poll until it succeeds. A
  channel that is not bus-off and whose driver has refused every send
  as queue-full for a second, with none accepted, has its **transmit
  queue flushed**, whether or not frames are arriving — PEAK through
  `CAN_Reset` (python-can's `PcanBus.reset`, which also empties the
  receive queue), Kvaser through `canIOCTL_FLUSH_TX_BUFFER`, Vector
  through `xlCanFlushTransmitQueue` (never python-can's
  `VectorBus.flush_tx_buffer`, which transmits a frame of its own),
  and by a reopen where the device or driver has no such flush. The
  check repeats at most once a second while the queue stays stuck. A
  channel refusing queue-full while nothing at all — data, echo or
  error frame — has been received for two seconds is reopened: a
  controller that neither transmits nor errors needs re-initialising,
  which a flush does not do. Each reset or reopen logs one INFO line,
  as does the first flush of a run (the rest go to the debug sink);
  ADR 0039 and ADR 0060 have the rules.
- **Receive timestamps are the backend's, with one correction.** A
  frame's `timestamp_ns` is whatever the vendor driver stamped it
  with, converted to Unix-epoch nanoseconds — except on **Kvaser**,
  where the driver unwraps a rollover before the frame reaches the
  wire. `canReadWait` reports arrival as a 32-bit count of 10 µs
  ticks, and python-can (4.6.1, and `main` as of 2026-09-23) returns
  `ticks × 10 µs + offset` with no rollover handling, so every stamp
  after `2**32` ticks — 42,949.67296 s, just under 11 h 56 m — is
  that much earlier than the one before it. On a long capture that
  reads downstream as frames arriving before the session began, and
  they are dropped. The sidecar keeps the last raw stamp per open
  channel and counts a rollover when a new one falls more than half a
  period behind (ordinary receive-queue reordering is microseconds
  wide, not hours); each rollover adds one period to every later
  stamp and emits one WARNING `LogMessage` naming the interface, so
  the operator's system log records that it happened. The count
  restarts at zero on each open, because python-can re-derives its
  offset from the live timer every time the bus is opened. No other
  backend is touched — a hardware stamp that is right is left alone.
  The defect is worked around here in the sidecar; cannet does not
  modify or petition its python-can dependency, so no upstream change
  is pursued.
- `Body::ClockProbe { t1 }` is answered with
  `Body::ClockReply { t1, t2, t3 }` — the sidecar's own wall-clock
  receive and send stamps, from the same `time.time_ns()` clock that
  goes onto every hardware frame. That is why the *sidecar* answers
  and a proxy in front of it relays: the clock worth measuring is the
  one that stamps the frames. Neither the probe nor the reply is
  logged (they recur for the life of a session).

## Bus faults

The sidecar reports a bus fault as **counts, episodes and state**, not
as a row per error frame or an envelope per refused send
([ADR 0060](../../docs/adr/0060-a-bus-fault-is-an-episode-the-sidecar-reports.md)).

- **Bus-error episodes.** Every error frame is folded into its
  interface's episode: it opens at an error frame and closes after one
  second without one (by the frames' own hardware stamps, or a second
  since the last error was read, whichever comes first). The sidecar
  publishes `BusErrorEpisode { interface_id, seq, first_ns, last_ns,
  count, count_by_kind, tx_count, rx_count, tec, rec, open }` when an
  episode opens, at every 250 ms state poll while it is open, and once
  when it closes. The kind is the vendor's: PEAK decodes it from the
  error frame's ID (bit, form, stuff, other) and bit position (an error
  in the acknowledge slot or delimiter is `ack`), with the direction
  from payload byte 0 and REC/TEC from bytes 2/3 — an ID-0 frame is a
  counter update, which updates the counters and is not counted. Vector
  CAN FD error events (`XL_CAN_EV_TAG_RX_ERROR` / `TX_ERROR`, which
  python-can turns into no message of its own) are consumed through the
  `handle_canfd_event` hook and classified by `errorCode`. Vector
  classic and Kvaser report no kind, so their errors count as
  `unknown`, with the counters the state poll reads.
- **Error-row cap.** Only the first N error frames of each episode go
  on to the host as trace rows; the rest are counted. N is per
  interface, `ConfigureBus.error_row_cap`, default 16 (Vector's NACK
  error-frame filter keeps the same number). A new cap applies from the
  next episode, and every episode gets its own first N.
- **Two lanes per session, control first.** A session's stream is a
  **control lane** — `InterfaceState`, `BusErrorEpisode`, `TxRefusals`,
  `FramesDropped`, `ClockReply`, `Log`, `Error` — bounded by key, latest
  wins (a backed-up closed episode folds into its successor; refusal
  and drop counts are summed; `Log`/`Error` are a 64-entry FIFO whose
  overflow the next log line reports), and a **data lane** of
  `FrameBatch` only, bounded at 10 000 frames per interface. The
  session drains control before data, so a fault, a refusal or a
  recovery reaches the host however far behind the frames are. On data
  overflow the **oldest whole batches** are dropped and `FramesDropped
  { interface_id, count, first_ns, last_ns }` says which.
- **Refusals are summarised.** A refused transmit is counted into
  `TxRefusals { interface_id, reason, count, first_ns, last_ns,
  last_message, flush_count, last_flush_ns }` for the session that
  sent it — published at once for the first refusal, then at most
  every 250 ms per (interface, reason) while refusals continue, and
  once more after they stop. `reason` is `queue_full` (PEAK by
  PCAN-Basic's text for `QXMTFULL` and `XMTFULL`, Kvaser by
  `canERR_TXBUFOFL` -13, Vector by `XL_ERR_QUEUE_IS_FULL` 11, and the
  sidecar's own per-interface queue), `closed`, `listen_only`,
  `incompatible` (an undecodable frame, FD on a classic bus, a payload
  or DLC the bus cannot carry) or `other`. No refused transmit
  produces an `Error` envelope; `Error` is left for a failed subscribe.
  Flushes ride the `queue_full` summary as `flush_count` and
  `last_flush_ns`.
- **One interface never holds back another.** A send for an interface
  whose transmit queue is full is refused at once, so the one thread
  that reads a session's transmit requests never waits on any single
  interface.
- **The stats lines say what the fault looked like.** Every two
  seconds per active interface: `rx stats <id>: read=…/s total=…
  queue=… errors=…/s echoes=…/s [echoes_dropped=…]` and `tx stats
  <id>: queued_to_driver=…/s total=… offered=…/s refused=…/s
  max_send=… ms max_gap=… ms` — `offered` is every send the host
  asked for, `queued_to_driver` the ones the driver accepted.

## Fault recovery bench

`cannet_local_sidecar/bench/` answers one question with data: does a
bus-off recovery bring a channel back? It runs the sidecar
**in-process** (the real `service` / `shared_interface` pipeline,
loopback only, nothing advertised), drives it as a `cannet.v1` client
the way cannet does — `ConfigureBus` and `Subscribe` for two channels
on one wire, transmits both ways, reading `InterfaceState`,
`BusErrorEpisode`, `TxRefusals` and frames — and before the channels
open swaps the sidecar's bus-off recovery (the channel `reset` the
state poll calls, ADR 0039) for the strategy under test. Nothing
experimental ships: no flag, no proto change, and the server never
imports the bench.

```sh
cd servers/cannet-local-sidecar
uv run python -m cannet_local_sidecar.bench.fault_recovery run     --under-test <id> --partner <id> --strategy close_then_open --no-timeout
uv run python -m cannet_local_sidecar.bench.fault_recovery wait found     # another shell
uv run python -m cannet_local_sidecar.bench.fault_recovery run     --driver fake --scenario bus_off --strategy close_then_open
```

- **Traffic.** `--rate` frames/s each way (default 800), both channels
  sending and receiving, at the longest payload the bus takes (8 B
  classic, 64 B FD; with FD on, every other frame is classic-format),
  each carrying its direction's sequence number and send time. The bus
  defaults to ev-zonal's — FD, 500 kbit/s nominal, 2 Mbit/s data;
  `--classic`, `--bitrate`, `--data-bitrate` change it.
- **Found / bus back / recovered.** Found is the first of the channel
  under test reading `state() != active` or a send on it refused; both
  are recorded with the gap between them. Bus back is the first frame
  the channel under test receives from the partner once it reads
  `active` with its own bus-error episode closed — a reopened channel
  has no backlog, so this is close to live. Recovered is the partner
  receiving the bench's frames count for count for a second after the
  fault was found: contiguous sequence numbers, none stale (older than
  250 ms on arrival), none repeated, keeping up with the sends — a
  stale queue replaying after a reset is a failure. Recovered can lag
  bus back well behind: the partner's own receive path may still be
  draining a backlog the under-test side never had.
- **Timeline.** The verdict prints and records an adapter-clock
  timeline: each channel's pull (`BusErrorEpisode.first_ns`), the first
  bus-off reading (`InterfaceState.as_of_ns`), the first reopen, bus
  back (the later of the two channels' last-episode `last_ns`) and
  recovered, each as UTC and as seconds after found, plus how far
  behind wall clock the slower channel's last error report arrived at
  bus back. `table.md` carries it under the row table; a stage the run
  never reached is omitted.
- **Timeouts.** `run`'s own waits are for `found` and `recovered`
  only — 10 s each (`--timeout` changes both), or forever with
  `--no-timeout`, for a run with someone at the cable. Exit 0
  recovered, 1 not, 2 refused to start. `wait <event>` blocks until the
  event (`found`, `bus_back`, `recovered`, `verdict`, …) appears in the
  newest run's events file, or the one `--run` names, and prints it —
  start it after `run` has printed its run directory, or pass that
  directory. It is a separate process with its own `--timeout`
  (default: forever), not `run`'s: watching for `bus_back` from another
  shell needs its own, shorter one if the run itself is bounded.
- **Record.** Each run writes `perf/bus-recovery/<UTC>-<strategy>/`
  at the repository root (`--out` moves it): `events.jsonl`, every
  reading as it arrived plus the sidecar's own log lines and the
  strategy's calls, and `table.md`, a row per 250 ms while the fault
  lasts and per second otherwise, then a verdict line. The columns are
  raw and side by side, never merged: `t | state() | status word | TEC
  | REC | sent/s | accepted/s | refused (reason) | partner rx/s | seq
  gap | strategy event` — `state()`/TEC/REC from the sidecar's
  `InterfaceState`, the status word from the backend's own read
  (`CAN_GetStatus` on PEAK, which with auto-reset on is where the
  driver resets the controller), accepted from the driver's queue,
  refused from `TxRefusals`, partner rx from what arrived. Runs are
  transient: committed while the recovery work is open, removed at its close.
- **Strategies** (`bench/strategies.py`), each docstring saying what
  the backend call does: `sidecar` (control — the shipped recovery),
  `state_active` (`bus.state = BusState.ACTIVE`), `bus_reset`
  (`bus.reset()`), `close_then_open` (`shutdown()`, then the sidecar's
  reopen), and PEAK-only `auto_reset` (`PCAN_BUSOFF_AUTORESET` at open)
  and `uninit_init_same_handle` (`CAN_Uninitialize` + `CAN_Initialize`
  on the held handle).
- **Scenarios** (`bench/fake.py`, `--driver fake`): a PEAK-shaped fake
  under the real `PythonCanChannel` — `bus_off`, `error_passive`,
  `stuck_tx_queue`, `refusal_storm`, `reopen_fails` (the next open
  fails `PCAN_ERROR_INITIALIZE` once) and
  `status_word_clears_while_writes_refuse` (the status word reads OK
  while writes still refuse bus-off). The fake refuses a second
  `CAN_Initialize` on a handle the process holds, as PEAK did on the
  owner's bench. `tests/test_fault_recovery_bench.py` runs each in the
  default suite. Its `hardware` test (deselected
  by default; `-m hardware`) runs a PEAK pair named by
  `CANNET_BENCH_UNDER_TEST` / `CANNET_BENCH_PARTNER`.
- **Exclusive handles.** PCAN handles are exclusive per process: close
  both channels in cannet first. The bench refuses to start, naming
  the driver's error, when a channel does not open.

**What the PEAK runs showed.** `state_active` and `bus_reset` do
nothing to a bus-off controller — PCAN-Basic documents the first as a
stored value the getter echoes back and the second as a queue flush,
neither touching the fault — so both left it bus-off every pull.
`close_then_open` recovered every pull, active within about 1.6 s of
bus-off (ADR 0039's amendment has the table): PCAN-Basic refuses
`CAN_Initialize` on a handle the process still holds, so a reopen must
close first. The shipped recovery is that order, made the sidecar's
own.

## Swap the driver library

`driver.py` defines a small adapter protocol (`list_channels`,
`open`, `recv`, `send`, `state`, `rx_loss`, `timer_wraps`,
`echoes_dropped`, `reset`, `classify_error`, `flush_tx`, `close`);
`rx_loss`, `timer_wraps`, `echoes_dropped`, `reset`, `classify_error`
and `flush_tx` are optional — a driver that omits them is read as one
that does not watch for receive loss, one whose backends' timestamps
never roll over, one that withholds no echoes, one whose bus-off
controllers are reopened rather than reset in place, one whose error
frames are all of kind `unknown`, and one whose stuck transmit queue is
reopened rather than flushed. A `send` that fails should raise
`TxRejected(..., reason=...)` with one of the `REFUSAL_*` reasons
(`queue_full=True` is still accepted for `queue_full`); without
`queue_full` the stuck-queue flush and the silent-queue reopen never
fire. `bus_off=True` on a refusal says the controller is bus-off and
arms the bus-off reset. The default
implementation in `driver_python_can.py` wraps `python-can`. To use
something else:

1. `uv pip install <your-driver>` into the sidecar's venv (or edit
   `pyproject.toml` and re-run `uv sync`).
2. Write a new module exposing a top-level callable named `Driver`
   that returns a struct shaped like `driver.Driver`.
3. Point `CANNET_DRIVER_MODULE` at it before launching the sidecar.
   Launched from the GUI, the **Driver module** setting is the same
   thing: the host forwards it as this variable, and a variable already
   in the environment wins for that run.

The wire-level code (`server/`) does not change. See
[`LICENSING.md`](LICENSING.md) for the LGPL analysis that motivates
this layout.

## The wire encoding

The gRPC stubs, the `Frame` this sidecar's driver protocol passes
around, and the mappers either side of it are not here: they are
[`libs/cannet-python-wire`](../../libs/cannet-python-wire/), a path
dependency shared with the python-can client, so there is exactly one
encoding of the wire in the repository. Regenerating the stubs after a
`.proto` change is that package's job — see its README.

## Per-vendor smoke tests

Hardware-required procedures (Vector, Kvaser, PEAK) live in
[`SMOKE.md`](SMOKE.md). CI cannot run them; the in-tree `pytest`
suite only covers the import + zero-interfaces case.
