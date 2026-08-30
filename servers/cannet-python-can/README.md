# cannet-python-can

Auto-launched Python sidecar that exposes Vector, Kvaser, and PEAK
hardware channels over the [`cannet-wire`](../../crates/cannet-wire)
gRPC protocol — the same wire the in-tree BLF replay server speaks.

The GUI host (`cannet-gui`) starts this process at launch via the
bundled [`uv`](https://docs.astral.sh/uv/) binary. End users do not
run anything in this directory by hand.

## Layout

```
cannet-python-can/
├── pyproject.toml              # uv-managed environment
├── cannet_python_can/
│   ├── __init__.py
│   ├── __main__.py             # `uv run cannet-python-can` entry
│   ├── server.py               # gRPC service implementation
│   ├── driver.py               # internal driver-adapter interface
│   ├── driver_python_can.py    # default python-can-backed adapter
│   └── _proto/                 # checked-in proto + grpc stubs
├── scripts/
│   └── regen_proto.sh          # regenerate stubs from ../../crates/cannet-wire/proto
├── tests/                      # pytest, hardware-free
├── SMOKE.md                    # per-vendor manual smoke procedures
└── LICENSING.md                # LGPL diligence for vendor driver libraries
```

## Run locally (developer)

From the repo root, with [`uv`](https://docs.astral.sh/uv/) on `PATH`:

```sh
uv --directory servers/cannet-python-can run cannet-python-can
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
  fd_data_speed_bps?, fd_enabled }` updates the interface's open
  config. If the interface is currently open the underlying bus is
  closed and reopened with the new config. Conflict semantics under
  concurrent clients are deliberately whatever python-can does
  (ADR 0022 § Known unknowns).
- `Body::InterfaceState { interface_id, state, tec, rec,
  rx_overruns? }` is pushed: a snapshot on each `Subscribe`, plus a
  fresh push whenever any of them changes. The controller is read at
  ~2 Hz. On PEAK the state comes from the error counters its error
  frames carry, on Vector from the chip-state events its XL driver
  reports (both floored by the vendor's own status word, neither able
  to talk the other down); everything else falls back to python-can's
  `Bus.state`, which most backends do not implement. TEC / REC are
  reported as 0 wherever they are not exposed. The Vector path has
  not been run against Vector hardware.

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
- `Body::ClockProbe { t1 }` is answered with
  `Body::ClockReply { t1, t2, t3 }` — the sidecar's own wall-clock
  receive and send stamps, from the same `time.time_ns()` clock that
  goes onto every hardware frame. That is why the *sidecar* answers
  and a proxy in front of it relays: the clock worth measuring is the
  one that stamps the frames. Neither the probe nor the reply is
  logged (they recur for the life of a session).

## Swap the driver library

`driver.py` defines a small adapter protocol (`list_channels`,
`open`, `recv`, `send`, `state`, `rx_loss`, `close`); the default
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

The wire-level code (`server.py`) does not change. See
[`LICENSING.md`](LICENSING.md) for the LGPL analysis that motivates
this layout.

## Regenerate proto stubs

The `cannet_python_can/_proto/` directory holds stubs generated from
[`crates/cannet-wire/proto/cannet.proto`](../../crates/cannet-wire/proto/cannet.proto).
They are checked in so end users do not need `protoc`. To regenerate
after a proto change:

```sh
uv --directory servers/cannet-python-can run --extra dev \
    bash scripts/regen_proto.sh
```

## Per-vendor smoke tests

Hardware-required procedures (Vector, Kvaser, PEAK) live in
[`SMOKE.md`](SMOKE.md). CI cannot run them; the in-tree `pytest`
suite only covers the import + zero-interfaces case.
