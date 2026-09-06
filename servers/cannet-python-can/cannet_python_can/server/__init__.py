"""cannet-python-can gRPC sidecar — package facade (ADR 0022).

The hardware-server wire model is split across four modules:

- :mod:`.helpers` — stateless conversions, envelope builders, driver
  resolution.
- :mod:`.shared_interface` — the reference-counted per-interface channel
  and its rx / pack / state / tx pump threads.
- :mod:`.enumeration` — interface enumeration and the ``WatchInterfaces``
  subscription.
- :mod:`.service` — the gRPC servicer (:class:`CannetServerService`) and
  the :func:`serve` / bind bootstrap.
- :mod:`.info` — the unversioned ``ServerInfo`` RPC every cannet server
  answers, stating the protocol packages it serves (ADR 0059).

This module re-exports the public surface (and the private names the test
suite drives) so ``from cannet_python_can import server`` keeps working
unchanged.
"""

from __future__ import annotations

from .helpers import (
    DEFAULT_DRIVER_MODULE,
    DRIVER_MODULE_ENV,
    WIRE_SOURCE,
    load_driver,
)
from .helpers import _clock_reply_envelope as _clock_reply_envelope
from .helpers import _configure_to_open_config as _configure_to_open_config
from .helpers import _log_envelope as _log_envelope
from .info import ServerInfoService
from .service import CannetServerService, bind_with_retry, serve
from .service import _split_address as _split_address
from .shared_interface import _BATCH_MAX_FRAMES as _BATCH_MAX_FRAMES
from .shared_interface import _InterfaceRegistry as _InterfaceRegistry
from .shared_interface import _SharedInterface as _SharedInterface

__all__ = [
    "CannetServerService",
    "DEFAULT_DRIVER_MODULE",
    "DRIVER_MODULE_ENV",
    "ServerInfoService",
    "WIRE_SOURCE",
    "bind_with_retry",
    "load_driver",
    "serve",
]
