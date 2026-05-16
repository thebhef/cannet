# cannet-python-can — licensing diligence

The sidecar exists, in part, to keep the LGPL surface area of vendor
driver libraries off the rest of the codebase. This file records the
analysis behind the layout so the rationale isn't lost.

## Summary

- The sidecar is its own process, communicating with `cannet-gui`
  exclusively over the [`cannet-wire`](../../crates/cannet-wire) gRPC
  protocol — a public, documented IPC boundary.
- The sidecar's venv is **user-replaceable**. `python-can` is the
  default driver library, but the adapter in `driver.py` lets a user
  install a different library (or write their own) with no changes to
  any other crate or app in this repository.
- Therefore: even where the underlying SDK is LGPL or proprietary,
  the rest of the cannet codebase neither links to nor distributes
  the SDK; the user opts in to the SDK on their own machine when they
  plug in hardware.

## Components

| Component        | License            | Distribution                            |
|------------------|--------------------|-----------------------------------------|
| `python-can`     | LGPL-3.0           | installed at runtime via `uv sync`      |
| `grpcio`         | Apache-2.0         | installed at runtime via `uv sync`      |
| `protobuf`       | BSD-3-Clause       | installed at runtime via `uv sync`      |
| Vector XL Driver | proprietary        | user-installed, not bundled             |
| Kvaser CANlib    | proprietary        | user-installed, not bundled             |
| PEAK PCAN-Basic  | proprietary        | user-installed, not bundled             |

`python-can` is LGPL-3.0. The cannet sidecar uses `python-can` from a
separate, replaceable Python venv — the binding is by `import`, not by
static link, and `python-can`'s LGPL allows that kind of use without
infecting the importing program's license. The cannet codebase ships
no `python-can` binary; the user's `uv sync` step fetches it from
PyPI under its own license.

The vendor SDKs (Vector / Kvaser / PEAK) are proprietary but freely
redistributable for use with the corresponding hardware. We do not
bundle them; users install them per the vendor's documentation. The
adapter just `import`s the vendor's Python module if it is present.

## Swap procedure

A user who wants to avoid `python-can` entirely (LGPL avoidance, a
preferred alternative driver, or in-house code) can:

1. Edit `pyproject.toml`: replace the `python-can>=4.3` line with the
   alternative package (or remove it).
2. Implement a module exposing a `Driver` callable matching
   `driver.Driver` from this package.
3. Set `CANNET_DRIVER_MODULE=<your_module>` before the GUI launches
   the sidecar (the GUI passes the env through).
4. Run `uv sync` to materialise the new venv.

The wire surface and the rest of the cannet codebase are unaffected.
