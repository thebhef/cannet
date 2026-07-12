# ev-zonal — large-DBC example project

A deliberately large, realistically named two-DBC fixture for
exercising the DBC view (search ranking, tree scaling, per-ECU
grouping) at production-database size. It is the task-33 scaling
workload; `examples/ev-demo` stays the performance-baseline project
and is intentionally untouched by this fixture.

Open `ev-zonal.cannet_prj` in the GUI — the project references its
DBCs by relative path (ADR 0030), so it opens from any clone location.

## Topology

Two logical buses, one DBC scoped to each:

| Bus | DBC | ECUs | Scale |
| --- | --- | --- | --- |
| Pack | `dbc/pack.dbc` | BMS, PackSensorFront/Rear, ThermalControl, ChargerObc, DcdcConverter, InsulationMonitor, VehicleControlUnit | 153 messages, 1159 signals |
| Zonal | `dbc/zonal.dbc` | ZoneFrontLeft/FrontRight/RearLeft/RearRight, CentralCompute, AdasDomain, BodyGateway | 150 messages, 531 signals |

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
multiplexed signals on `BmsCellDetail`); run it after regenerating:

```sh
cargo test -p cannet-dbc --test ev_zonal_fixture
```
