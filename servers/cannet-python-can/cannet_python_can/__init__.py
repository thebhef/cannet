"""Auto-launched python-can sidecar for the cannet wire protocol.

The package exposes a gRPC server that speaks the same `.proto` as
`cannet-server` (the BLF replay fixture) and `cannet-client` (the
Rust gRPC client used by the Tauri host). One sidecar process covers
all three Phase-8 vendors (Vector, Kvaser, PEAK) through one
`python-can` install; a user can swap that out for an alternative
driver library by replacing the module behind the
``CANNET_DRIVER_MODULE`` env var (see :mod:`cannet_python_can.driver`).

Importing this package does not start a server and does not touch
hardware; both happen inside :func:`cannet_python_can.__main__.main`.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
