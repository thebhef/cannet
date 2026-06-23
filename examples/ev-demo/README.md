# ev-demo — example EV project & perf workload

A small but realistic single-vehicle electric-vehicle model used two ways:

- **as a cannet project** you can open in the GUI (`ev-demo.cannet_prj`), and
- **as the reproducible workload** the `cannet-perf-measurement` performance /
  integration harness runs as a rest-of-bus simulation (see
  `crates/cannet-perf-measurement`).

## Topology

Two CAN buses, **physically bridged** on the bench (the two PEAK
adapters are wired to the same harness, so traffic on one bus is seen on
the other). Modelling them as two logical buses keeps the per-domain
framing while needing only the two interfaces available.

```
            Powertrain bus (HS-CAN, 500 kbit/s) — PCAN_USBBUS1
            ┌───────────────────────────────────────────────┐
            │  VCU        MotorFront        MotorRear         │
            └───────────────────────────────────────────────┘
                              │  (physical bridge)
            ┌───────────────────────────────────────────────┐
            │  BMS        ThermalMgr        DCDC      OBC     │
            └───────────────────────────────────────────────┘
            Battery bus (HS-CAN, 500 kbit/s) — PCAN_USBBUS2
```

Seven ECUs, four DBCs (one per ECU group), scoped per bus:

| Bus | ECUs | DBC | Messages (id, cadence) |
| --- | --- | --- | --- |
| Powertrain | VCU | `dbc/vcu.dbc` | VcuStatus (0x100, 10 ms), VcuTorqueCmd (0x110, 10 ms), VcuBmsCommand (0x18FF50A3 ext, 50 ms) |
| Powertrain | MotorFront, MotorRear | `dbc/traction-motor.dbc` | MotorFrontStatus (0x200, 10 ms), MotorRearStatus (0x201, 10 ms) |
| Battery | BMS | `dbc/bms.dbc` | BmsState (0x300, 20 ms), BmsCellSummary (0x301, 100 ms), BmsLimits (0x302, 100 ms) |
| Battery | ThermalMgr, DCDC, OBC | `dbc/thermal.dbc` | ThermalState (0x400, 100 ms), DcdcState (0x410, 100 ms), ObcState (0x420, 200 ms) |

Send/receive is explicit in each DBC (the `BO_` transmitter and the
per-signal receiver lists), and crosses the bridge where it should — the
VCU on the powertrain bus commands the BMS on the battery bus
(`VcuBmsCommand`) and reads `BmsState` back; the BMS publishes current
limits the inverters clamp torque to. Aggregate steady-state rate is
**~515 frames/s** (≈420 on Powertrain, ≈95 on Battery).

`VcuBmsCommand` is the extended-id, end-to-end-protected frame: `AliveCtr`
is a rolling counter and `Crc8` a CRC-8/SAE-J1850 over the payload
(ADR 0027 calculated fields), so the example also exercises the
counter/CRC path.

Each enum signal in the DBCs carries a value→color map (ADR 0029),
authored as `colormap` project elements: `Gear`, `ContactorReq`,
`PackStatus`, `ContactorState`, and `ChargeState`. Faults render red,
closed/complete/drive green, transitional states amber, neutral states
grey — so the trace cells and plot enum lanes read in colour wherever
those signals appear.

## Files

| File | What it is |
| --- | --- |
| `ev-demo.cannet_prj` | Project: buses, the two PEAK interface bindings, DBC scoping (DBCs referenced by project-relative path — ADR 0030), the trace / plot / RBS elements, the enum value→color maps (ADR 0029), and a populated dockview layout that opens them. Schema v7. |
| `ev-demo.cannet_rbs` | Rest-of-bus simulation (ADR 0028): static signal values per message. Cadences come from each DBC's `GenMsgCycleTime`. |
| `dbc/*.dbc` | The four ECU databases. |

The RBS holds **static** values — a steady-state snapshot of a vehicle
driving (≈65 km/h, contactors closed, ~72 % SoC). It is the workload's
payload source; the harness reconstructs each frame fill bit → DBC start
values → these overrides.

## Using it

- **GUI**: open `ev-demo.cannet_prj`. Its layout opens a representative
  view configuration — a chronological and a by-id trace, a powertrain
  and a battery plot (each pre-filtered to its bus's signals), and the
  RBS panel. Connect the two buses to the PEAK interfaces (or rebind to
  whatever interfaces you have), then Run the RBS element to transmit the
  rest-of-bus. This is also the view set the frontend perf
  characterisation drives.
- **Harness**: `cargo run -p cannet-perf-measurement -- validate` prints the
  schedule this project produces; the other subcommands run it across
  the harness's source modes. See `crates/cannet-perf-measurement`.
