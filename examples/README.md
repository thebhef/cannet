# Demo trace fixture

A small but feature-complete CAN log for exercising `cannet-blf`,
`cannet-dbc`, and the GUI end-to-end. Open `cannet-demo.blf` in the
GUI and attach `cannet-demo.dbc` as the database.

## Files

| File | Purpose |
|---|---|
| `cannet-demo.dbc` | DBC database — message and signal definitions. |
| `cannet-demo.blf` | 10 s of generated CAN/CAN FD traffic, 1810 frames. |
| `generate_blf.py` | Deterministic generator for the BLF (seeded RNG). |

## What the trace covers

| Message | ID | Frame | Period | Notes |
|---|---|---|---|---|
| `VehicleState` | `0x100` (std) | classic CAN | 50 ms (20 Hz) | Unsigned ints with factor; 3-bit enum + `VAL_` table; periodic + Gaussian noise. |
| `BatteryDiag` | `0x18FF40E5` (ext) | classic CAN | 100 ms (10 Hz) | Signed ints with factor and offset (`BattTemp` factor 0.1 / offset −40). |
| `SensorMux` | `0x200` (std) | classic CAN | 20 ms (50 Hz) | Multiplexed: selector cycles 0..3, four signal sets share the same 16-bit slot. |
| `GpsPosition` | `0x18FF6C12` (ext) | **CAN FD** (16 B) | 1 s (1 Hz) | True IEEE-754 32-bit floats (`SIG_VALTYPE_ ... 1`) plus a scaled signed 32-bit altitude. |
| `AdasState` | `0x300` (std) | **CAN FD** (32 B) | 10 ms (100 Hz) | Eight signed 16-bit distance signals with factor 0.01. |

Coverage checklist:

- [x] Standard 11-bit and extended 29-bit IDs.
- [x] Classic CAN (≤ 8 B) and CAN FD (16 B and 32 B payloads).
- [x] Unsigned int, signed int, and IEEE float signal types.
- [x] Factor and offset on multiple signals (e.g. `BattTemp` is `int16 * 0.1 + (-40)`).
- [x] Multiplexed signal block.
- [x] Value tables (`VAL_`) for `GearLever` and `SensorId`.
- [x] Mix of unitless and unit-bearing signals.
- [x] Mix of clean periodic, periodic-plus-noise, and discrete waveforms.
- [x] Five distinct cadences from 10 ms to 1 s.

## Regenerating

```sh
pip install python-can cantools
python3 examples/generate_blf.py
```

The script seeds its RNG so the BLF is byte-identical across runs.

## Verifying

```sh
cargo run --example verify_decode -p cannet-dbc
```

Reads `cannet-demo.blf` through `cannet-blf::BlfCanFrameSource`, decodes
each frame against `cannet-demo.dbc` with `cannet-dbc::Database`, and
prints per-ID counts plus the first two decoded frames for each ID.
