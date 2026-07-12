#!/usr/bin/env python3
"""Deterministic generator for the ev-zonal example DBCs.

Writes `dbc/pack.dbc` and `dbc/zonal.dbc` next to this script. Pure
stdlib, no RNG -- the output is a function of the tables below only, so
regeneration is byte-identical across runs and machines:

    python3 examples/ev-zonal/generate_dbcs.py

The fixture is deliberately large (150+ messages per DBC, one message
with 600+ multiplexed signals) but realistically named, so DBC-view
search ranking and scaling are exercised the way a production database
stresses them. See `README.md` in this directory for the topology.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

EXT_BIT = 0x8000_0000  # DBC files carry extended 29-bit ids with the high bit set.


@dataclass
class Sig:
    name: str
    bits: int
    start: int = -1  # -1 = auto-pack sequentially (little-endian)
    signed: bool = False
    factor: float = 1
    offset: float = 0
    minimum: float = 0
    maximum: float = 0
    unit: str = ""
    comment: str = ""
    values: dict[int, str] = field(default_factory=dict)
    mux: str = ""  # "" plain, "M" selector, "m<N>" arm
    receivers: str = "Vector__XXX"
    float32: bool = False


@dataclass
class Msg:
    name: str
    can_id: int
    tx: str
    signals: list[Sig]
    length: int = 8
    extended: bool = False
    cycle_ms: int = 0
    comment: str = ""


def fmt_num(x: float) -> str:
    """DBC numeric literal -- integers without a trailing `.0`."""
    return str(int(x)) if float(x) == int(x) else repr(float(x))


def auto_pack(msg: Msg) -> None:
    """Assign sequential little-endian start bits to `start == -1`
    signals and check everything fits the declared payload."""
    cursor = 0
    for s in msg.signals:
        if s.start < 0:
            s.start = cursor
            cursor = s.start + s.bits
        else:
            cursor = max(cursor, s.start + s.bits)
    limit = msg.length * 8
    assert cursor <= limit, f"{msg.name}: {cursor} bits > {limit}"


def render_dbc(version: str, ecus: list[str], messages: list[Msg]) -> str:
    names = [m.name for m in messages]
    assert len(names) == len(set(names)), "duplicate message name"
    ids = [m.can_id | (EXT_BIT if m.extended else 0) for m in messages]
    assert len(ids) == len(set(ids)), "duplicate message id"

    out: list[str] = [f'VERSION "{version}"', ""]
    out.append("NS_ :")
    for kw in (
        "NS_DESC_", "CM_", "BA_DEF_", "BA_", "VAL_", "CAT_DEF_", "CAT_",
        "FILTER", "BA_DEF_DEF_", "EV_DATA_", "ENVVAR_DATA_", "SGTYPE_",
        "SGTYPE_VAL_", "BA_DEF_SGTYPE_", "BA_SGTYPE_", "SIG_TYPE_REF_",
        "VAL_TABLE_", "SIG_GROUP_", "SIG_VALTYPE_", "SIGTYPE_VALTYPE_",
        "BO_TX_BU_", "BA_DEF_REL_", "BA_REL_", "BA_DEF_DEF_REL_",
        "BU_SG_REL_", "BU_EV_REL_", "BU_BO_REL_", "SG_MUL_VAL_",
    ):
        out.append(f"\t{kw}")
    out += ["", "BS_:", "", "BU_: " + " ".join(ecus), ""]

    comments: list[str] = []
    bas: list[str] = []
    vals: list[str] = []
    valtypes: list[str] = []

    for m in messages:
        auto_pack(m)
        raw_id = m.can_id | (EXT_BIT if m.extended else 0)
        out.append(f"BO_ {raw_id} {m.name}: {m.length} {m.tx}")
        for s in m.signals:
            mux = f" {s.mux}" if s.mux else ""
            sign = "-" if s.signed else "+"
            out.append(
                f' SG_ {s.name}{mux} : {s.start}|{s.bits}@1{sign}'
                f" ({fmt_num(s.factor)},{fmt_num(s.offset)})"
                f" [{fmt_num(s.minimum)}|{fmt_num(s.maximum)}]"
                f' "{s.unit}" {s.receivers}'
            )
            if s.comment:
                comments.append(f'CM_ SG_ {raw_id} {s.name} "{s.comment}";')
            if s.values:
                pairs = " ".join(f'{k} "{v}"' for k, v in sorted(s.values.items()))
                vals.append(f"VAL_ {raw_id} {s.name} {pairs} ;")
            if s.float32:
                valtypes.append(f"SIG_VALTYPE_ {raw_id} {s.name} : 1;")
        out.append("")
        if m.comment:
            comments.append(f'CM_ BO_ {raw_id} "{m.comment}";')
        if m.cycle_ms:
            bas.append(f'BA_ "GenMsgCycleTime" BO_ {raw_id} {m.cycle_ms};')

    out += comments
    out += [
        'BA_DEF_ BO_ "GenMsgCycleTime" INT 0 100000;',
        'BA_DEF_DEF_ "GenMsgCycleTime" 0;',
    ]
    out += bas
    out += vals
    out += valtypes
    out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------- pack.dbc

PACK_ECUS = [
    "BMS", "PackSensorFront", "PackSensorRear", "ThermalControl",
    "ChargerObc", "DcdcConverter", "InsulationMonitor", "VehicleControlUnit",
]

CELL_COUNT = 200
CELLS_PER_PAGE = 8
CELLS_PER_MODULE = 8
MODULE_COUNT = CELL_COUNT // CELLS_PER_MODULE  # 25

BALANCE_STATES = {0: "Off", 1: "Discharging", 2: "Scheduled", 3: "Fault"}


def cell_detail_message() -> Msg:
    """The scale stress case: one FD message multiplexing per-cell
    voltage, temperature, and balancing state for the whole pack --
    200 cells x 3 = 600 multiplexed signals behind one selector."""
    sigs = [Sig("CellPage", 8, start=0, mux="M",
                comment="Multiplex selector -- which block of 8 cells this frame carries.")]
    pages = CELL_COUNT // CELLS_PER_PAGE
    for page in range(pages):
        for k in range(CELLS_PER_PAGE):
            cell = page * CELLS_PER_PAGE + k + 1
            sigs.append(Sig(
                f"CellVoltage{cell:03d}", 16, start=8 + k * 16, mux=f"m{page}",
                factor=0.0001, minimum=0, maximum=5, unit="V",
                comment=f"Terminal voltage of cell {cell}.",
            ))
            sigs.append(Sig(
                f"CellTemp{cell:03d}", 8, start=136 + k * 8, mux=f"m{page}",
                offset=-40, minimum=-40, maximum=125, unit="degC",
                comment=f"Surface temperature at cell {cell} NTC.",
            ))
            sigs.append(Sig(
                f"CellBalance{cell:03d}", 2, start=200 + k * 2, mux=f"m{page}",
                values=dict(BALANCE_STATES),
            ))
    return Msg(
        "BmsCellDetail", 0x18F00001, "BMS", sigs, length=64, extended=True,
        cycle_ms=100,
        comment="Per-cell measurement page -- cycles CellPage over the full pack.",
    )


def u(name: str, bits: int, **kw) -> Sig:
    return Sig(name, bits, **kw)


def s16(name: str, **kw) -> Sig:
    return Sig(name, 16, signed=True, **kw)


def pack_messages() -> list[Msg]:
    msgs: list[Msg] = []

    def add(name, can_id, tx, sigs, **kw):
        msgs.append(Msg(name, can_id, tx, sigs, **kw))

    # VCU commands toward the pack.
    add("VcuPackCommand", 0x0C0, "VehicleControlUnit", [
        u("PackEnableRequest", 2, values={0: "Standby", 1: "Drive", 2: "Charge", 3: "Sleep"},
          comment="Requested high-voltage pack operating mode."),
        u("PrechargeRequest", 1),
        u("MaxDischargeCurrentRequest", 12, factor=0.5, unit="A"),
        u("MaxRegenCurrentRequest", 12, factor=0.5, unit="A"),
        u("VcuAliveCounter", 4, comment="Rolling counter, increments each transmission."),
    ], cycle_ms=10)
    add("VcuChargeCommand", 0x0C1, "VehicleControlUnit", [
        u("ChargeCurrentTarget", 12, factor=0.25, unit="A"),
        u("ChargeVoltageTarget", 12, factor=0.25, unit="V"),
        u("ChargeSessionEnable", 1),
        u("TargetSoc", 7, unit="%"),
    ], cycle_ms=100)
    add("VcuThermalRequest", 0x0C2, "VehicleControlUnit", [
        u("CabinHeatRequest", 8, factor=0.5, unit="kW"),
        u("BatteryCoolingRequest", 8, factor=0.5, unit="kW"),
        u("PreconditioningActive", 1),
    ], cycle_ms=100)

    # Pack-level BMS broadcasts.
    add("PackStatus", 0x100, "BMS", [
        u("PackVoltage", 16, factor=0.1, unit="V", comment="Total pack terminal voltage."),
        s16("PackCurrent", factor=0.1, unit="A",
            comment="Pack current, positive = discharge."),
        u("StateOfCharge", 10, factor=0.1, unit="%"),
        u("PackState", 3, values={0: "Sleep", 1: "Standby", 2: "Precharge",
                                  3: "Drive", 4: "Charge", 5: "Fault"}),
        u("FaultLevel", 2, values={0: "None", 1: "Warning", 2: "Derate", 3: "Shutdown"}),
    ], cycle_ms=10)
    add("PackLimits", 0x101, "BMS", [
        u("MaxDischargeCurrent", 12, factor=0.5, unit="A"),
        u("MaxRegenCurrent", 12, factor=0.5, unit="A"),
        u("MaxDischargePower", 12, factor=0.1, unit="kW"),
        u("MaxChargePower", 12, factor=0.1, unit="kW"),
    ], cycle_ms=100, comment="Instantaneous pack capability envelope.")
    add("CellExtremes", 0x102, "BMS", [
        u("MinCellVoltage", 13, factor=0.001, unit="V"),
        u("MaxCellVoltage", 13, factor=0.001, unit="V"),
        u("MinCellIndex", 8, comment="1-based index of the lowest-voltage cell."),
        u("MaxCellIndex", 8),
        u("MinCellTemp", 8, offset=-40, unit="degC"),
        u("MaxCellTemp", 8, offset=-40, unit="degC"),
    ], cycle_ms=100)
    add("ContactorStatus", 0x103, "BMS", [
        u("MainPositiveState", 2, values={0: "Open", 1: "Closed", 2: "Welded", 3: "Fault"}),
        u("MainNegativeState", 2, values={0: "Open", 1: "Closed", 2: "Welded", 3: "Fault"}),
        u("PrechargeState", 2, values={0: "Open", 1: "Closed", 2: "Welded", 3: "Fault"}),
        u("ContactorCycleCount", 16, comment="Lifetime close cycles of the main pair."),
    ], cycle_ms=100)
    add("IsolationStatus", 0x104, "InsulationMonitor", [
        u("IsolationResistance", 16, factor=1, unit="kOhm",
          comment="Measured HV+ to chassis isolation resistance."),
        u("IsolationValid", 1),
        u("IsolationWarning", 1),
        u("IsolationFault", 1),
    ], cycle_ms=200)
    add("PackEnergy", 0x105, "BMS", [
        u("RemainingEnergy", 16, factor=0.01, unit="kWh"),
        u("FullChargeEnergy", 16, factor=0.01, unit="kWh"),
        u("LifetimeDischargedEnergy", 24, factor=0.1, unit="kWh"),
    ], cycle_ms=1000)
    add("PackSoh", 0x106, "BMS", [
        u("StateOfHealth", 10, factor=0.1, unit="%"),
        u("CapacityFadeEstimate", 10, factor=0.1, unit="%"),
        u("ResistanceGrowthEstimate", 10, factor=0.1, unit="%"),
    ], cycle_ms=1000)
    add("BalancingSummary", 0x107, "BMS", [
        u("CellsBalancingCount", 8),
        u("BalancingActive", 1),
        u("BalancingTargetVoltage", 13, factor=0.001, unit="V"),
    ], cycle_ms=1000)
    add("HvInterlockStatus", 0x108, "BMS", [
        u("InterlockLoopClosed", 1, comment="HVIL continuity across all HV connectors."),
        u("InterlockOpenLocation", 5, values={0: "None", 1: "PackLid", 2: "MsdPlug",
                                              3: "DcFastPort", 4: "InverterPlug"}),
    ], cycle_ms=100)
    add("PackPowerStats", 0x109, "BMS", [
        s16("InstantPower", factor=0.1, unit="kW"),
        s16("Peak10sPower", factor=0.1, unit="kW"),
        s16("Peak10sRegen", factor=0.1, unit="kW"),
    ], cycle_ms=100)
    add("BmsFaultsA", 0x10A, "BMS", [
        u(name, 1) for name in (
            "OverVoltageFault", "UnderVoltageFault", "OverTempFault",
            "UnderTempFault", "OverCurrentDischargeFault", "OverCurrentChargeFault",
            "CellDeltaFault", "SensorLossFault", "ContactorFault", "PrechargeTimeoutFault",
        )
    ], cycle_ms=100, comment="Latched fault flags, bank A.")
    add("BmsFaultsB", 0x10B, "BMS", [
        u(name, 1) for name in (
            "IsolationLowFault", "InterlockOpenFault", "ThermalRunawayAlert",
            "CoolantLeakFault", "InternalCommFault", "CurrentSensorFault",
            "FuseBlownFault", "MsdRemovedFault",
        )
    ], cycle_ms=100, comment="Latched fault flags, bank B.")
    add("BmsWarnings", 0x10C, "BMS", [
        u(name, 1) for name in (
            "CellVoltageLowWarning", "CellVoltageHighWarning", "TempHighWarning",
            "TempLowWarning", "SocLowWarning", "BalanceOverdueWarning",
            "IsolationDegradedWarning",
        )
    ], cycle_ms=100)
    add("PrechargeStatus", 0x10D, "BMS", [
        u("PrechargeProgress", 8, factor=0.5, unit="%"),
        u("LinkVoltage", 16, factor=0.1, unit="V", comment="DC link voltage seen through the precharge resistor."),
        u("PrechargeDuration", 10, unit="ms"),
    ], cycle_ms=20)
    add("PackCurrentHiRes", 0x10E, "PackSensorFront", [
        Sig("PackCurrentFine", 24, signed=True, factor=0.001, unit="A",
            comment="Shunt-derived high-resolution pack current."),
        u("SensorTemperature", 8, offset=-40, unit="degC"),
    ], cycle_ms=10)
    add("PackVoltageHiRes", 0x10F, "PackSensorFront", [
        u("PackVoltageFine", 24, factor=0.001, unit="V"),
        u("MeasurementValid", 1),
    ], cycle_ms=10)

    # Per-string summaries.
    for i, letter in enumerate("ABCD"):
        add(f"String{letter}Status", 0x120 + i, "BMS", [
            u("StringVoltage", 16, factor=0.1, unit="V"),
            s16("StringCurrent", factor=0.1, unit="A"),
            u("StringContactorClosed", 1),
            u("StringFuseOk", 1),
        ], cycle_ms=100, comment=f"Aggregate status of parallel string {letter}.")
        add(f"String{letter}Extremes", 0x124 + i, "BMS", [
            u("StringMinCellVoltage", 13, factor=0.001, unit="V"),
            u("StringMaxCellVoltage", 13, factor=0.001, unit="V"),
            u("StringMaxTemp", 8, offset=-40, unit="degC"),
        ], cycle_ms=200)

    # Per-module telemetry (25 modules x 3 messages = 75).
    for m in range(1, MODULE_COUNT + 1):
        tx = "PackSensorFront" if m <= MODULE_COUNT // 2 else "PackSensorRear"
        first = (m - 1) * CELLS_PER_MODULE + 1
        last = m * CELLS_PER_MODULE
        add(f"Module{m:02d}Summary", 0x200 + (m - 1), tx, [
            u("ModuleVoltage", 16, factor=0.01, unit="V"),
            u("ModuleMinCellVoltage", 13, factor=0.001, unit="V"),
            u("ModuleMaxCellVoltage", 13, factor=0.001, unit="V"),
            u("ModuleSoc", 10, factor=0.1, unit="%"),
        ], cycle_ms=200, comment=f"Module {m:02d} summary (cells {first}-{last}).")
        add(f"Module{m:02d}Temps", 0x220 + (m - 1), tx, [
            u("NtcTemp1", 8, offset=-40, unit="degC"),
            u("NtcTemp2", 8, offset=-40, unit="degC"),
            u("NtcTemp3", 8, offset=-40, unit="degC"),
            u("NtcTemp4", 8, offset=-40, unit="degC"),
            u("BusbarTemp", 8, offset=-40, unit="degC"),
        ], cycle_ms=500)
        add(f"Module{m:02d}Balance", 0x240 + (m - 1), tx, [
            u("BalanceActiveMask", 8, comment="Bit per cell in the module, 1 = shunt on."),
            u("BalanceDutyCycle", 7, unit="%"),
            u("BalanceBoardTemp", 8, offset=-40, unit="degC"),
        ], cycle_ms=1000)

    # Thermal loop.
    thermal = [
        ("CoolantLoopAStatus", [u("LoopAInletTemp", 8, offset=-40, unit="degC"),
                                u("LoopAOutletTemp", 8, offset=-40, unit="degC"),
                                u("LoopAFlowRate", 10, factor=0.1, unit="l/min"),
                                u("LoopAPressure", 10, factor=0.01, unit="bar")]),
        ("CoolantLoopBStatus", [u("LoopBInletTemp", 8, offset=-40, unit="degC"),
                                u("LoopBOutletTemp", 8, offset=-40, unit="degC"),
                                u("LoopBFlowRate", 10, factor=0.1, unit="l/min"),
                                u("LoopBPressure", 10, factor=0.01, unit="bar")]),
        ("CoolantPumpAStatus", [u("PumpASpeed", 16, unit="rpm"),
                                u("PumpACurrent", 10, factor=0.05, unit="A"),
                                u("PumpAFault", 1)]),
        ("CoolantPumpACommand", [u("PumpASpeedRequest", 16, unit="rpm"),
                                 u("PumpAEnable", 1)]),
        ("CoolantPumpBStatus", [u("PumpBSpeed", 16, unit="rpm"),
                                u("PumpBCurrent", 10, factor=0.05, unit="A"),
                                u("PumpBFault", 1)]),
        ("CoolantPumpBCommand", [u("PumpBSpeedRequest", 16, unit="rpm"),
                                 u("PumpBEnable", 1)]),
        ("ChillerStatus", [u("ChillerActive", 1),
                           u("RefrigerantPressure", 10, factor=0.05, unit="bar"),
                           u("ChillerOutletTemp", 8, offset=-40, unit="degC")]),
        ("ChillerCommand", [u("ChillerRequest", 1),
                            u("ChillerPowerTarget", 8, factor=0.1, unit="kW")]),
        ("BatteryHeaterStatus", [u("HeaterActive", 1),
                                 u("HeaterPower", 8, factor=0.1, unit="kW"),
                                 u("HeaterPlateTemp", 8, offset=-40, unit="degC")]),
        ("BatteryHeaterCommand", [u("HeaterRequest", 1),
                                  u("HeaterPowerTarget", 8, factor=0.1, unit="kW")]),
        ("RadiatorFanStatus", [u("FanSpeed", 8, unit="%"),
                               u("FanCurrent", 10, factor=0.05, unit="A")]),
        ("RadiatorFanCommand", [u("FanSpeedRequest", 8, unit="%")]),
        ("CoolantValveStatus", [u("BypassValvePosition", 8, unit="%"),
                                u("SeriesParallelValve", 2,
                                  values={0: "Series", 1: "Parallel", 2: "Moving", 3: "Fault"})]),
        ("CoolantValveCommand", [u("BypassValveRequest", 8, unit="%"),
                                 u("SeriesParallelRequest", 1)]),
        ("ThermalSetpoints", [u("CellTempTarget", 8, offset=-40, unit="degC"),
                              u("CellTempHighLimit", 8, offset=-40, unit="degC"),
                              u("CellTempLowLimit", 8, offset=-40, unit="degC")]),
        ("CoolantTemperatures", [u("AmbientTemp", 8, offset=-40, unit="degC"),
                                 u("RadiatorOutletTemp", 8, offset=-40, unit="degC"),
                                 u("ChillerInletTemp", 8, offset=-40, unit="degC"),
                                 u("HeaterOutletTemp", 8, offset=-40, unit="degC")]),
    ]
    for i, (name, sigs) in enumerate(thermal):
        add(name, 0x300 + i, "ThermalControl", sigs, cycle_ms=100)

    # Charging (extended J1939-flavoured ids).
    charging = [
        ("ObcStatus", [u("ObcState", 3, values={0: "Idle", 1: "Connected", 2: "Charging",
                                                3: "Complete", 4: "Fault"}),
                       u("ObcOutputCurrent", 12, factor=0.1, unit="A"),
                       u("ObcOutputVoltage", 12, factor=0.25, unit="V")]),
        ("ObcAcInput", [u("AcVoltage", 10, factor=0.5, unit="V"),
                        u("AcCurrent", 10, factor=0.1, unit="A"),
                        u("AcFrequency", 8, factor=0.25, offset=40, unit="Hz"),
                        u("AcPhaseCount", 2)]),
        ("ObcDcOutput", [u("DcOutputPower", 12, factor=0.01, unit="kW"),
                         u("ObcEfficiency", 8, factor=0.5, unit="%")]),
        ("ObcLimits", [u("PilotCurrentLimit", 10, factor=0.1, unit="A",
                         comment="J1772 pilot duty-cycle derived current limit."),
                       u("CableCurrentLimit", 10, factor=0.1, unit="A")]),
        ("ObcTemperatures", [u("ObcInletTemp", 8, offset=-40, unit="degC"),
                             u("ObcRectifierTemp", 8, offset=-40, unit="degC"),
                             u("ObcTransformerTemp", 8, offset=-40, unit="degC")]),
        ("ChargePortStatus", [u("PortLidOpen", 1),
                              u("PlugPresent", 1),
                              u("PlugLocked", 1),
                              u("PortLedState", 3, values={0: "Off", 1: "White", 2: "Green",
                                                           3: "BlinkGreen", 4: "Red"})]),
        ("ChargeSessionStats", [u("SessionEnergy", 16, factor=0.01, unit="kWh"),
                                u("SessionDuration", 16, unit="min"),
                                u("SessionPeakPower", 10, factor=0.1, unit="kW")]),
        ("DcFastChargeStatus", [u("DcfcActive", 1),
                                u("DcfcCurrent", 12, factor=0.25, unit="A"),
                                u("DcfcVoltage", 12, factor=0.25, unit="V"),
                                u("DcfcContactorClosed", 1)]),
        ("DcFastChargeLimits", [u("DcfcCurrentLimit", 12, factor=0.25, unit="A"),
                                u("DcfcVoltageLimit", 12, factor=0.25, unit="V"),
                                u("DcfcPowerLimit", 10, factor=0.5, unit="kW")]),
        ("ChargeScheduleStatus", [u("ScheduledStartMinutes", 11, unit="min",
                                    comment="Minutes until the next scheduled charge window opens."),
                                  u("OffPeakOnly", 1),
                                  u("TargetSocScheduled", 7, unit="%")]),
    ]
    for i, (name, sigs) in enumerate(charging):
        add(name, 0x18FF8001 + i, "ChargerObc", sigs, extended=True, cycle_ms=200)

    # DC/DC converter.
    dcdc = [
        ("DcdcStatus", [u("DcdcState", 2, values={0: "Off", 1: "Active", 2: "Derated", 3: "Fault"}),
                        u("LvOutputVoltage", 10, factor=0.02, unit="V"),
                        u("LvOutputCurrent", 12, factor=0.1, unit="A")]),
        ("DcdcLvOutput", [u("LvSetpoint", 10, factor=0.02, unit="V"),
                          u("LvRippleEstimate", 8, factor=0.01, unit="V")]),
        ("DcdcHvInput", [u("HvInputVoltage", 12, factor=0.25, unit="V"),
                         u("HvInputCurrent", 10, factor=0.05, unit="A")]),
        ("DcdcTemperatures", [u("DcdcHeatsinkTemp", 8, offset=-40, unit="degC"),
                              u("DcdcAmbientTemp", 8, offset=-40, unit="degC")]),
        ("DcdcFaults", [u("DcdcOverTempFault", 1), u("DcdcOverCurrentFault", 1),
                        u("DcdcUnderVoltageFault", 1), u("DcdcCommTimeoutFault", 1)]),
    ]
    for i, (name, sigs) in enumerate(dcdc):
        add(name, 0x340 + i, "DcdcConverter", sigs, cycle_ms=100)

    # Insulation monitor extras.
    add("ImdResistanceDetail", 0x350, "InsulationMonitor", [
        u("PositiveRailResistance", 16, unit="kOhm"),
        u("NegativeRailResistance", 16, unit="kOhm"),
        u("MeasurementAge", 8, factor=0.1, unit="s"),
    ], cycle_ms=500)
    add("ImdSelfTest", 0x351, "InsulationMonitor", [
        u("SelfTestState", 2, values={0: "Idle", 1: "Running", 2: "Passed", 3: "Failed"}),
        u("LastSelfTestResult", 1),
    ], cycle_ms=1000)
    add("ImdConfiguration", 0x352, "InsulationMonitor", [
        u("WarningThreshold", 16, unit="kOhm"),
        u("FaultThreshold", 16, unit="kOhm"),
    ], cycle_ms=1000)

    # Heartbeats + software versions, one pair per ECU.
    for n, ecu in enumerate(PACK_ECUS):
        add(f"{ecu}Heartbeat", 0x700 + n, ecu, [
            u("AliveCounter", 8, comment="Increments every transmission, wraps at 255."),
            u("SupplyVoltage", 8, factor=0.1, unit="V"),
            u("EcuState", 2, values={0: "Init", 1: "Run", 2: "Degraded", 3: "Shutdown"}),
        ], cycle_ms=100)
        add(f"{ecu}SwVersion", 0x710 + n, ecu, [
            u("MajorVersion", 8), u("MinorVersion", 8), u("PatchVersion", 8),
            u("BuildNumber", 16),
        ], cycle_ms=5000)

    msgs.append(cell_detail_message())
    return msgs


# --------------------------------------------------------------- zonal.dbc

ZONES = [("FL", "ZoneFrontLeft"), ("FR", "ZoneFrontRight"),
         ("RL", "ZoneRearLeft"), ("RR", "ZoneRearRight")]

ZONAL_ECUS = [ecu for _, ecu in ZONES] + ["CentralCompute", "AdasDomain", "BodyGateway"]

LOCK_STATES = {0: "Unlocked", 1: "Locked", 2: "DoubleLocked", 3: "Moving", 4: "Fault"}


def zone_status_families(zone: str) -> list[tuple[str, list[Sig]]]:
    """Status messages a zone controller transmits. `zone` is the
    corner suffix (FL/FR/RL/RR) baked into the message names."""
    return [
        (f"Zone{zone}_DoorStatus", [
            u("DoorAjar", 1, comment="1 while the door is not fully latched."),
            u("LockState", 3, values=dict(LOCK_STATES)),
            u("HandleTouched", 1),
            u("ChildLockActive", 1),
        ]),
        (f"Zone{zone}_WindowStatus", [
            u("WindowPosition", 8, factor=0.5, unit="%"),
            u("WindowMoving", 1),
            u("PinchDetected", 1, comment="Anti-pinch reversal triggered this cycle."),
        ]),
        (f"Zone{zone}_LatchStatus", [
            u("LatchEngaged", 1), u("LatchMotorCurrent", 8, factor=0.05, unit="A"),
            u("CinchState", 2, values={0: "Idle", 1: "Cinching", 2: "Done", 3: "Fault"}),
        ]),
        (f"Zone{zone}_MirrorStatus", [
            u("MirrorFolded", 1), u("MirrorHeaterOn", 1),
            u("MirrorTiltX", 8, offset=-128), u("MirrorTiltY", 8, offset=-128),
        ]),
        (f"Zone{zone}_SeatStatus", [
            u("OccupantDetected", 1), u("SeatbeltLatched", 1),
            u("SeatHeaterLevel", 2), u("SeatPositionTrack", 8, factor=0.5, unit="%"),
        ]),
        (f"Zone{zone}_LightingStatus", [
            u("TurnIndicatorOn", 1), u("PuddleLampOn", 1),
            u("LedFaultMask", 8, comment="Bit per LED string, 1 = open circuit."),
        ]),
        (f"Zone{zone}_HvacBlowerStatus", [
            u("BlowerSpeed", 8, unit="%"), u("VentTemp", 8, offset=-40, unit="degC"),
            u("FlapPosition", 8, factor=0.5, unit="%"),
        ]),
        (f"Zone{zone}_TirePressure", [
            u("TirePressure", 10, factor=0.025, unit="bar"),
            u("TireTemp", 8, offset=-40, unit="degC"),
            u("SensorBattery", 7, unit="%"),
            u("SensorMissing", 1),
        ]),
        (f"Zone{zone}_WheelSpeed", [
            u("WheelSpeed", 14, factor=0.03125, unit="km/h"),
            u("WheelDirection", 2, values={0: "Stopped", 1: "Forward", 2: "Reverse", 3: "Invalid"}),
            u("PulseCount", 16, comment="Raw tooth count since power-on, wraps."),
        ]),
        (f"Zone{zone}_BrakeActuatorStatus", [
            u("CaliperPressure", 12, factor=0.1, unit="bar"),
            u("PadWearEstimate", 7, unit="%"),
            u("ActuatorTemp", 8, offset=-40, unit="degC"),
        ]),
        (f"Zone{zone}_SuspensionStatus", [
            u("RideHeight", 10, factor=0.5, offset=-256, unit="mm"),
            u("DamperCurrent", 8, factor=0.05, unit="A"),
            u("AccelVertical", 12, signed=True, factor=0.01, unit="g"),
        ]),
        (f"Zone{zone}_PowerDistStatus", [
            u("RailVoltage", 10, factor=0.02, unit="V"),
            u("TotalLoadCurrent", 10, factor=0.1, unit="A"),
            u("EfuseTrippedMask", 8, comment="Bit per e-fuse channel, 1 = tripped."),
        ]),
        (f"Zone{zone}_LoadCurrents", [
            u("Channel1Current", 8, factor=0.1, unit="A"),
            u("Channel2Current", 8, factor=0.1, unit="A"),
            u("Channel3Current", 8, factor=0.1, unit="A"),
            u("Channel4Current", 8, factor=0.1, unit="A"),
        ]),
        (f"Zone{zone}_Temperature", [
            u("BoardTemp", 8, offset=-40, unit="degC"),
            u("ConnectorTemp", 8, offset=-40, unit="degC"),
        ]),
        (f"Zone{zone}_Heartbeat", [
            u("AliveCounter", 8), u("EcuState", 2, values={0: "Init", 1: "Run",
                                                           2: "Degraded", 3: "Shutdown"}),
        ]),
        (f"Zone{zone}_Faults", [
            u("CommTimeoutFault", 1), u("OverTempFault", 1), u("EfuseFault", 1),
            u("ActuatorStallFault", 1), u("SensorPlausibilityFault", 1),
        ]),
        (f"Zone{zone}_SwVersion", [
            u("MajorVersion", 8), u("MinorVersion", 8), u("PatchVersion", 8),
            u("BuildNumber", 16),
        ]),
    ]


def zone_command_families(zone: str) -> list[tuple[str, list[Sig]]]:
    """Commands CentralCompute sends toward one zone controller."""
    return [
        (f"Zone{zone}_DoorCommand", [
            u("LockRequest", 2, values={0: "NoRequest", 1: "Lock", 2: "Unlock", 3: "DoubleLock"}),
            u("PresentHandle", 1),
        ]),
        (f"Zone{zone}_WindowCommand", [
            u("WindowTargetPosition", 8, factor=0.5, unit="%"),
            u("ExpressMode", 1),
        ]),
        (f"Zone{zone}_MirrorCommand", [
            u("FoldRequest", 1), u("HeaterRequest", 1),
            u("TiltXTarget", 8, offset=-128), u("TiltYTarget", 8, offset=-128),
        ]),
        (f"Zone{zone}_SeatCommand", [
            u("SeatHeaterRequest", 2), u("SeatTrackTarget", 8, factor=0.5, unit="%"),
        ]),
        (f"Zone{zone}_LightingCommand", [
            u("TurnIndicatorRequest", 1), u("PuddleLampRequest", 1),
            u("DimmingLevel", 8, factor=0.5, unit="%"),
        ]),
        (f"Zone{zone}_HvacBlowerCommand", [
            u("BlowerSpeedRequest", 8, unit="%"),
            u("FlapPositionRequest", 8, factor=0.5, unit="%"),
        ]),
        (f"Zone{zone}_BrakeActuatorCommand", [
            u("CaliperPressureRequest", 12, factor=0.1, unit="bar"),
            u("ParkBrakeRequest", 2, values={0: "NoRequest", 1: "Apply", 2: "Release", 3: "Reserved"}),
        ]),
        (f"Zone{zone}_SuspensionCommand", [
            u("RideHeightTarget", 10, factor=0.5, offset=-256, unit="mm"),
            u("DamperFirmness", 8, unit="%"),
        ]),
        (f"Zone{zone}_PowerDistCommand", [
            u("EfuseEnableMask", 8, comment="Bit per e-fuse channel, 1 = enable."),
            u("SleepRequest", 1),
        ]),
        (f"Zone{zone}_AmbientLightCommand", [
            u("AmbientHue", 8), u("AmbientBrightness", 8, factor=0.5, unit="%"),
        ]),
    ]


def adas_object_list() -> Msg:
    """Second mux-heavy case: a fused object list, one mux arm per
    tracked object (16 objects x 6 signals = 96 multiplexed signals)."""
    sigs = [Sig("ObjectIndex", 8, start=0, mux="M",
                comment="Multiplex selector -- which tracked object this frame carries.")]
    for i in range(16):
        arm = f"m{i}"
        sigs += [
            Sig(f"Obj{i:02d}DistX", 16, start=8, signed=True, factor=0.01, unit="m", mux=arm,
                comment=f"Object {i} longitudinal distance."),
            Sig(f"Obj{i:02d}DistY", 16, start=24, signed=True, factor=0.01, unit="m", mux=arm),
            Sig(f"Obj{i:02d}VelX", 16, start=40, signed=True, factor=0.01, unit="m/s", mux=arm),
            Sig(f"Obj{i:02d}VelY", 16, start=56, signed=True, factor=0.01, unit="m/s", mux=arm),
            Sig(f"Obj{i:02d}Class", 4, start=72, mux=arm,
                values={0: "Unknown", 1: "Car", 2: "Truck", 3: "Motorcycle",
                        4: "Bicycle", 5: "Pedestrian", 6: "Animal", 7: "Debris"}),
            Sig(f"Obj{i:02d}Confidence", 7, start=76, unit="%", mux=arm),
        ]
    return Msg("AdasObjectList", 0x310, "AdasDomain", sigs, length=16, cycle_ms=40,
               comment="Fused front object list -- cycles ObjectIndex over active tracks.")


def zonal_messages() -> list[Msg]:
    msgs: list[Msg] = []

    for zi, (zone, ecu) in enumerate(ZONES):
        for fi, (name, sigs) in enumerate(zone_status_families(zone)):
            msgs.append(Msg(name, 0x400 + zi * 0x40 + fi, ecu, sigs,
                            cycle_ms=100, comment=""))
        for fi, (name, sigs) in enumerate(zone_command_families(zone)):
            msgs.append(Msg(name, 0x500 + zi * 0x20 + fi, "CentralCompute", sigs,
                            cycle_ms=50))

    central = [
        ("VehicleMode", [u("DriveMode", 3, values={0: "Park", 1: "Reverse", 2: "Neutral",
                                                   3: "Drive", 4: "Valet", 5: "Transport"}),
                         u("PowerState", 2, values={0: "Off", 1: "Accessory", 2: "On", 3: "Ready"}),
                         u("AliveCounter", 4)]),
        ("PowerModeCommand", [u("RequestedPowerState", 2),
                              u("WakeReason", 4, values={0: "None", 1: "Keyfob", 2: "Door",
                                                         3: "Charge", 4: "Preconditioning",
                                                         5: "Telematics"})]),
        ("CrashNotification", [u("CrashSeverity", 3, values={0: "None", 1: "Low", 2: "Medium",
                                                             3: "High"}),
                               u("RestraintDeployed", 1),
                               u("HvShutdownRequested", 1,
                                 comment="Set with any deployment -- pack must open contactors.")]),
        ("VehicleSpeed", [u("Speed", 14, factor=0.01, unit="km/h"),
                          u("SpeedValid", 1)]),
        ("Odometer", [u("TotalDistance", 24, factor=0.1, unit="km"),
                      u("TripDistance", 20, factor=0.01, unit="km")]),
        ("TimeSync", [u("UnixTimeSeconds", 32, unit="s"),
                      u("TimeSource", 2, values={0: "Rtc", 1: "Gnss", 2: "Cellular", 3: "Manual"})]),
        ("EnergyBudget", [u("HvacAllocation", 8, factor=0.1, unit="kW"),
                          u("DriveAllocation", 10, factor=0.1, unit="kW"),
                          u("ChargeReserve", 8, factor=0.1, unit="kW")]),
        ("RouteInfo", [u("DistanceToDestination", 16, factor=0.1, unit="km"),
                       u("ChargeStopsPlanned", 4),
                       u("ArrivalSocEstimate", 7, unit="%")]),
        ("DriveModeStatus", [u("SelectedProfile", 3, values={0: "Comfort", 1: "Sport",
                                                             2: "Eco", 3: "Snow", 4: "Custom"}),
                             u("RegenLevel", 3),
                             u("OnePedalActive", 1)]),
        ("RegenSetting", [u("RegenLevelRequest", 3),
                          u("CreepModeEnable", 1)]),
    ]
    for i, (name, sigs) in enumerate(central):
        msgs.append(Msg(name, 0x600 + i, "CentralCompute", sigs, cycle_ms=100))

    adas = [
        ("AdasLaneLeft", [Sig("LaneLeftC0", 32, float32=True, unit="m",
                              comment="Polynomial offset coefficient, IEEE float."),
                          Sig("LaneLeftC1", 32, float32=True, unit="rad")]),
        ("AdasLaneRight", [Sig("LaneRightC0", 32, float32=True, unit="m"),
                           Sig("LaneRightC1", 32, float32=True, unit="rad")]),
        ("AdasStatus", [u("AdasAvailable", 1), u("DriverAttentive", 1),
                        u("ActiveFeatureMask", 8, comment="Bit per feature: ACC, LKA, AEB, BSD...")]),
        ("AdasWarnings", [u("ForwardCollisionWarning", 1), u("LaneDepartureWarning", 1),
                          u("BlindSpotWarningLeft", 1), u("BlindSpotWarningRight", 1),
                          u("DriverDrowsyWarning", 1)]),
        ("FrontRadarStatus", [u("RadarBlocked", 1), u("RadarTemp", 8, offset=-40, unit="degC"),
                              u("TrackCount", 6)]),
        ("FrontCameraStatus", [u("CameraBlocked", 1), u("LowSunGlare", 1),
                               u("CalibrationState", 2, values={0: "Ok", 1: "Drifting",
                                                                2: "Required", 3: "Running"})]),
        ("UltrasonicFront", [u("SensorFL", 9, unit="cm"), u("SensorFCL", 9, unit="cm"),
                             u("SensorFCR", 9, unit="cm"), u("SensorFR", 9, unit="cm")]),
        ("UltrasonicRear", [u("SensorRL", 9, unit="cm"), u("SensorRCL", 9, unit="cm"),
                            u("SensorRCR", 9, unit="cm"), u("SensorRR", 9, unit="cm")]),
        ("BlindSpotLeft", [u("TargetPresent", 1), u("TargetDistance", 9, factor=0.1, unit="m"),
                           u("TargetClosingSpeed", 8, signed=True, factor=0.1, unit="m/s")]),
        ("BlindSpotRight", [u("TargetPresent", 1), u("TargetDistance", 9, factor=0.1, unit="m"),
                            u("TargetClosingSpeed", 8, signed=True, factor=0.1, unit="m/s")]),
        ("AebStatus", [u("AebState", 2, values={0: "Standby", 1: "Warning", 2: "Braking",
                                                3: "Inhibited"}),
                       u("BrakeRequestLevel", 8, factor=0.5, unit="%")]),
        ("AccStatus", [u("AccActive", 1), u("SetSpeed", 8, unit="km/h"),
                       u("FollowGapSetting", 3),
                       u("LeadVehicleDetected", 1)]),
        ("LkaStatus", [u("LkaActive", 1), u("SteeringTorqueRequest", 10, signed=True,
                                            factor=0.01, unit="Nm"),
                       u("HandsOnWheel", 1)]),
    ]
    for i, (name, sigs) in enumerate(adas):
        msgs.append(Msg(name, 0x320 + i, "AdasDomain", sigs, cycle_ms=40))
    msgs.append(adas_object_list())

    body = [
        ("ExteriorLightingStatus", [u("LowBeamOn", 1), u("HighBeamOn", 1), u("DrlOn", 1),
                                    u("FogRearOn", 1), u("BrakeLightOn", 1)]),
        ("ExteriorLightingCommand", [u("LowBeamRequest", 1), u("HighBeamRequest", 1),
                                     u("AutoHighBeamEnable", 1)]),
        ("WiperStatus", [u("WiperSpeedActual", 3, values={0: "Off", 1: "Intermittent",
                                                          2: "Low", 3: "High"}),
                         u("WiperParked", 1), u("WasherFluidLow", 1)]),
        ("WiperCommand", [u("WiperSpeedRequest", 3), u("SingleWipeRequest", 1)]),
        ("WasherStatus", [u("WasherPumpActive", 1), u("WasherFluidLevel", 7, unit="%")]),
        ("HornCommand", [u("HornRequest", 1)]),
        ("AlarmStatus", [u("AlarmArmed", 1), u("AlarmTriggered", 1),
                         u("TriggerSource", 4, values={0: "None", 1: "Door", 2: "Motion",
                                                       3: "Tilt", 4: "Glass"})]),
        ("ImmobilizerStatus", [u("KeyAuthenticated", 1), u("ChallengeCounter", 8)]),
        ("KeyfobEvent", [u("ButtonPressed", 4, values={0: "None", 1: "Lock", 2: "Unlock",
                                                       3: "Trunk", 4: "Panic"}),
                         u("FobBatteryLow", 1), u("FobRssi", 8, signed=True, unit="dBm")]),
        ("SunroofStatus", [u("SunroofPosition", 8, factor=0.5, unit="%"),
                           u("ShadePosition", 8, factor=0.5, unit="%")]),
        ("SunroofCommand", [u("SunroofTarget", 8, factor=0.5, unit="%"),
                            u("VentRequest", 1)]),
        ("TrailerStatus", [u("TrailerConnected", 1), u("TrailerLampFault", 1),
                           u("TrailerBrakeGain", 6)]),
        ("ChargeFlapStatus", [u("FlapOpen", 1), u("FlapLockState", 2)]),
        ("RainLightSensor", [u("RainIntensity", 8, unit="%"),
                             u("AmbientLightLevel", 10, unit="lx"),
                             u("TunnelDetected", 1)]),
        ("CabinClimateStatus", [u("CabinTemp", 8, factor=0.5, offset=-40, unit="degC"),
                                u("CabinHumidity", 7, unit="%"),
                                u("EvaporatorTemp", 8, offset=-40, unit="degC")]),
        ("CabinClimateCommand", [u("CabinTempTarget", 8, factor=0.5, offset=-40, unit="degC"),
                                 u("AcRequest", 1), u("RecircRequest", 1)]),
        ("AirQuality", [u("Co2Level", 12, unit="ppm"), u("VocIndex", 8),
                        u("Pm25Level", 10, factor=0.1, unit="ug/m3")]),
        ("HumiditySensor", [u("WindshieldHumidity", 7, unit="%"),
                            u("DewPointEstimate", 8, offset=-40, unit="degC"),
                            u("FogRiskLevel", 2, values={0: "None", 1: "Low", 2: "Medium",
                                                         3: "High"})]),
    ]
    for i, (name, sigs) in enumerate(body):
        msgs.append(Msg(name, 0x660 + i, "BodyGateway", sigs, cycle_ms=200))

    return msgs


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, "dbc")
    os.makedirs(out_dir, exist_ok=True)

    pack = pack_messages()
    zonal = zonal_messages()

    # The scale properties the task 33 fixture promises.
    assert len(pack) >= 150, f"pack.dbc has {len(pack)} messages"
    assert len(zonal) >= 150, f"zonal.dbc has {len(zonal)} messages"
    cell_detail = next(m for m in pack if m.name == "BmsCellDetail")
    muxed = [s for s in cell_detail.signals if s.mux.startswith("m")]
    assert len(muxed) >= 500, f"BmsCellDetail has {len(muxed)} muxed signals"

    for fname, version, ecus, msgs in (
        ("pack.dbc", "ev-zonal pack 1.0", PACK_ECUS, pack),
        ("zonal.dbc", "ev-zonal zonal 1.0", ZONAL_ECUS, zonal),
    ):
        text = render_dbc(version, ecus, msgs)
        path = os.path.join(out_dir, fname)
        with open(path, "w", newline="\n") as f:
            f.write(text)
        total_sigs = sum(len(m.signals) for m in msgs)
        print(f"{fname}: {len(msgs)} messages, {total_sigs} signals")


if __name__ == "__main__":
    main()
