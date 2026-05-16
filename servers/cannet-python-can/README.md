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
└── LICENSING.md                # LGPL diligence (see also ../LICENSING.md)
```

## Run locally (developer)

From the repo root, with [`uv`](https://docs.astral.sh/uv/) on `PATH`:

```sh
uv --directory servers/cannet-python-can run cannet-python-can --bind 127.0.0.1:50061
```

The sidecar prints one tab-separated banner line per discovered
interface, then serves the `cannet.v1.CannetServer` gRPC service on
the given address. With **no hardware and no `python-can` installed**
the process still boots and reports zero interfaces — the GUI uses
this as the "no vendor hardware plugged in" state, not as a failure.

The banner is intentionally machine-readable:

```
sidecar    version       0.1.0
sidecar    interfaces    0
sidecar    listening     127.0.0.1:50061
```

`interface\t<id>\t<display_name>\t<fd?>` lines appear before
`sidecar\tlistening\t...` when there is hardware to enumerate.

## Swap the driver library

`driver.py` defines a small adapter protocol (`list_channels`,
`open`, `recv`, `send`, `close`); the default implementation in
`driver_python_can.py` wraps `python-can`. To use something else:

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
