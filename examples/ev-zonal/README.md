# ev-zonal — large-DBC example project

A deliberately large, realistically named two-DBC fixture for
exercising the DBC view (search ranking, tree scaling, per-ECU
grouping) at production-database size. It is the DBC-scaling
workload; `examples/ev-demo` stays the performance-baseline project
and is intentionally untouched by this fixture.

Open `ev-zonal.cannet_prj` in the GUI — the project references its
DBCs by relative path (ADR 0030), so it opens from any clone location.

## Topology

Two logical buses, one DBC scoped to each:

| Bus | DBC | ECUs | Scale |
| --- | --- | --- | --- |
| Pack | `dbc/pack.dbc` | BMS, PackSensorFront/Rear, ThermalControl, ChargerObc, DcdcConverter, InsulationMonitor, VehicleControlUnit | 153 messages, 1159 signals |
| Zonal | `dbc/zonal.dbc` | ZoneFrontLeft/FrontRight/RearLeft/RearRight, CentralCompute, AdasDomain, BodyGateway | 152 messages, 541 signals |

Notable stress cases:

- **`BmsCellDetail`** (`pack.dbc`, CAN FD 64 B, extended id) — per-cell
  voltage, temperature, and balancing state for a 200-cell pack behind
  one `CellPage` multiplex selector: **600 multiplexed signals in one
  message**.
- **`AdasObjectList`** (`zonal.dbc`, CAN FD 16 B) — a fused object
  list multiplexing 16 tracked objects × 6 signals.
- Per-module / per-zone message families (25 battery modules × 3
  messages; 4 zone controllers × 27 messages) — realistic name
  repetition with distinguishing prefixes, the shape that stresses
  fuzzy-search ranking.
- **`PackStateCommand`** (`zonal.dbc`, id `0x60A`) — the E2E-protected
  command: a `CannetCounter` rollover counter and a `CannetCrc`
  CRC-8/SAE-J1850 over bytes 0–6 (ADR 0027), with the CRC marked
  `CannetDisplay "radix=hex"` so it reads as `0x5C` rather than `92`
  (ADR 0043). The counter beside it is just as raw a field and stays
  decimal — the opt-in is per signal.
- **`CentralComputeThermalDerateAdvisoryBroadcast`** (`zonal.dbc`, id
  `0x6F0`) — the long-name case. The classic DBC format caps `BO_` /
  `SG_` identifiers at 32 characters, so the lines carry the
  truncations (`CentralComputeThermalDerateAdvis`,
  `HighVoltageBatteryPackCoolantInl`, …) and `BA_
  "SystemMessageLongSymbol"` / `"SystemSignalLongSymbol"` carry the
  real names. Its `ThermalDerateRequestingSubsystemIdentifier` enum
  adds `VAL_` labels of up to 44 characters — labels have no length
  limit at all. Two short-named signals (`DerateActive`,
  `AdvisoryCounter`) and one short label (`Fault`) sit beside them, so
  a rendering that truncates can be told from one that doesn't.
- Value tables, message/signal comments, `GenMsgCycleTime` attributes,
  IEEE-float lane-polynomial signals (`SIG_VALTYPE_`), and a mix of
  standard and extended ids.

## Regenerating

The DBCs are generated deterministically (pure stdlib, no RNG — the
output is byte-identical across runs and machines):

```sh
python3 examples/ev-zonal/generate_dbcs.py
```

`crates/cannet-dbc/tests/ev_zonal_fixture.rs` pins the properties the
fixture promises (parses warning-free, 150+ messages per DBC, 500+
multiplexed signals on `BmsCellDetail`, the long-name message and its
long `VAL_` labels); run it after regenerating:

```sh
cargo test -p cannet-dbc --test ev_zonal_fixture
```
