# cannet-python-can — licensing diligence

The sidecar keeps the CAN driver libraries' LGPL surface in one process
and one folder — off the GUI/Rust binary. This records the compliance
posture.

Two distribution models:

- **Dev** — runs from source in a `uv` venv; redistributes nothing.
- **End-user** — ships as a frozen PyInstaller **onedir** binary in the
  installer ([ADR 0036](../../docs/adr/0036-frozen-python-can-sidecar.md)),
  **embedding** the deps below. Here cannet *is* a redistributor.

| Component               | License                       | End-user distribution       |
|-------------------------|-------------------------------|-----------------------------|
| `python-can`            | LGPL-3.0-only                 | frozen into the onedir      |
| `grpcio`                | Apache-2.0                    | frozen into the onedir      |
| `protobuf`              | BSD-3-Clause                  | frozen into the onedir      |
| CPython                 | PSF-2.0                       | frozen into the onedir      |
| PyInstaller             | GPL-2.0-or-later w/ exception | build tool only             |
| Vector/Kvaser/PEAK SDKs | proprietary                   | user-installed, not bundled |

**Permissive deps** (`grpcio`, `protobuf`, CPython) only need their
notices retained in a `THIRD-PARTY-LICENSES` file shipped with the
installer. **PyInstaller**'s bootloader exception lets us ship the
frozen output under any license; it imposes nothing.

**`python-can` (LGPL-3.0)** — freezing it in makes the installer a
Combined Work under LGPL §4, which LGPL permits under any license
(cannet stays MIT). Compliance is cheap because it's pure Python:

- **§4d relink** — satisfied by the onedir itself: `python-can` lands as
  editable modules under `_internal/can/`; a user swaps in a modified
  copy in place (no separate relink for an import-linked library). The
  build keeps it as collected files (`--collect-submodules can`).
- **Source** — public and unmodified at the `uv.lock`-pinned version
  (`github.com/hardbyte/python-can`); ship the LGPL-3.0 + GPL-3.0 texts
  and a pointer.
- **Notices (§4a–c)** — the `THIRD-PARTY-LICENSES` file (and, later, an
  about-box) name `python-can` as LGPL-covered.
- **No tivoization** — the onedir is left user-modifiable.

**Vendor SDKs** are loaded via `ctypes` from the user's own hardware-SDK
install; never frozen in.

## Swapping `python-can`

- **Frozen:** replace the modules under `_internal/can/` with an
  interface-compatible version — no cannet rebuild.
- **Dev:** swap the dep in `pyproject.toml`, expose a `Driver` callable
  matching `driver.Driver`, set `CANNET_DRIVER_MODULE`, `uv sync`.
