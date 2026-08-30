# Demo trace fixture

A small but feature-complete CAN log for exercising `cannet-blf`,
`cannet-mdf`, `cannet-dbc`, and the GUI end-to-end. Open
`cannet-demo.blf` (or `cannet-demo.mf4` — the same traffic in the other
format) in the GUI and attach `cannet-demo.dbc` as the database.

Three example *projects* live alongside this trace fixture:

- [`ev-demo/`](ev-demo/README.md) — a small, realistic EV model; the
  reproducible workload the `cannet-perf-measurement` harness runs.
- [`ev-zonal/`](ev-zonal/README.md) — a deliberately large two-DBC
  fixture (150+ messages each, one message with 600 multiplexed
  signals) for exercising DBC-view search and scaling. Both projects
  also carry the DBC long-name extension and over-long `VAL_` labels.
- [`common-scale/`](common-scale/README.md) — a 10 s capture and project
  that deterministically reproduce task 98's defect (a -200..0 A signal
  rendered as -1.5..0 on a common y scale) on a pre-fix build, and show
  the one-axis-one-scale behaviour on a fixed one.
- [`extrapolation/`](extrapolation/README.md) — a 20 s synthetic capture
  and its project, carrying one series per *extrapolated* shape a plot
  can draw (ADR 0026): a dashed tail, a dashed interior stall, a
  one-sample hline, and enum lanes striped where their state is held
  rather than read.

- [`capture-features/`](capture-features/README.md) — everything a
  capture file can carry beyond ordinary traffic: coloured and
  uncoloured events, a message-bound comment, a `cannet-event/1` block
  from a later schema version, error and remote frames, file-backed and
  coded signal series, a descending master, and two files left by a
  capture that was killed mid-run. Its project runs on an
  in-process virtual bus, so it demos with no hardware attached.
- [`colliding-dbcs/`](colliding-dbcs/README.md) — two databases assigned
  to one bus that disagree about arbitration id `0x100` in every way two
  databases can: name, scale, unit, enum vocabulary, which signal owns a
  byte, and whether a counter and CRC exist at all.
- [`mapping-repair/`](mapping-repair/README.md) — a project with
  nothing mapped (a database assigned to nothing, plot series with no
  bus, a persisted `run` flag), so the signal-mapping and RBS-mapping
  rules can be demonstrated rather than described.

One more fixture set sits alongside them, without a project:

- [`time-origins/`](time-origins/README.md) — a DBC and three ~2 s
  captures (two BLF, one MF4) that pin where an imported capture's
  timeline starts (ADR 0024): a file with no stated start time, a BLF
  whose objects are out of timestamp order, and an MF4 whose earliest
  content is a signal rather than a frame.

## Git LFS

Every capture in this directory — `.blf` and `.mf4` alike, the
unfinalized recovery fixtures among them — is stored as a **Git LFS**
object; see
[`.gitattributes`](../.gitattributes). A fresh clone needs

```sh
git lfs install   # once per machine
git lfs pull
```

before those files are anything but pointer text. Several Rust tests read
them through the real reader, so a clone without them fails the suite.
Everything else here — the DBCs, the projects, the RBS files, the
generators — is plain text in plain git.

## Files

| File | Purpose |
|---|---|
| `cannet-demo.dbc` | DBC database — message and signal definitions. |
| `cannet-demo.blf` | 10 s of generated CAN/CAN FD traffic, 1810 frames. |
| `generate_blf.py` | Deterministic generator for the BLF (seeded RNG). |
| `cannet-demo.mf4` | The same 10 s as ASAM MDF 4.10, plus event markers and message-independent signals. |
| `generate_mdf.py` | Deterministic generator for the MF4 (reads the BLF; seeded RNG). |

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

## What the MDF adds

`cannet-demo.mf4` carries the same 1810 frames — same ids, same
payloads, same cadences, decodable against the same `cannet-demo.dbc` —
in a `CAN_DataFrame` bus-logging channel group, plus the two kinds of
content a BLF has nowhere to put:

| Content | In the file | On import |
|---|---|---|
| CAN / CAN FD traffic | `CAN_DataFrame` structure channel group, `BusChannel` 1 | frames, one channel to map onto a bus |
| Event markers | four `##EV` blocks (`run start`, `gear shift`, `GPS fix`, `run end`) | session notes, ids and colors intact |
| Message-independent signals | `Ambient` (`AmbientTemp` degC, `CabinHumidity` %) and `Charger` (`ChargerPower` kW, `ContactorState` coded 0=Open / 1=Precharge / 2=Closed) | four file-backed signals, the coded one with its value table |

Coverage checklist:

- [x] MDF 4.10, sorted, finalized, `##DZ`-compressed data blocks.
- [x] Bus-logging composition (one `##CN` per structure member).
- [x] Timeline events with cannet's `common_properties` id and color.
- [x] Message-independent signal channel groups with units.
- [x] A coded channel whose conversion block is a value→text table
      (`ContactorState`), so a file-backed enum lane renders labels.

## Regenerating

```sh
pip install python-can cantools
python3 examples/generate_blf.py
```

```sh
uv run --with asammdf --with numpy --with python-can \
    examples/generate_mdf.py
```

Both scripts seed their RNG — and the MDF generator pins the one field
asammdf would otherwise stamp with the wall clock — so each fixture is
byte-identical across runs. Regenerate the BLF first if you change it:
the MDF generator reads its frames from it.

## Verifying

```sh
cargo run --example verify_decode -p cannet-dbc
```

Reads `cannet-demo.blf` through `cannet-blf::BlfCanFrameSource`, decodes
each frame against `cannet-demo.dbc` with `cannet-dbc::Database`, and
prints per-ID counts plus the first two decoded frames for each ID.
