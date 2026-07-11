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
- `Body::InterfaceState { interface_id, state, tec, rec }` is
  pushed: a snapshot on each `Subscribe`, plus a fresh push whenever
  the controller's fault-confinement state or its TEC / REC
  counters change. python-can's `Bus.state` is polled at ~2 Hz;
  TEC / REC are reported as 0 on backends that don't expose them.

## Swap the driver library

`driver.py` defines a small adapter protocol (`list_channels`,
`open`, `recv`, `send`, `state`, `close`); the default implementation
in `driver_python_can.py` wraps `python-can`. To use something else:

1. `uv pip install <your-driver>` into the sidecar's venv (or edit
   `pyproject.toml` and re-run `uv sync`).
2. Write a new module exposing a top-level callable named `Driver`
   that returns a struct shaped like `driver.Driver`.
3. Point `CANNET_DRIVER_MODULE` at it before launching the sidecar.

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
