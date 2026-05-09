#!/usr/bin/env python3
"""Generate the cannet-demo.blf fixture from cannet-demo.dbc.

The trace is deterministic (seeded RNG) and runs for DURATION_S seconds.
Each message gets its own cadence and waveform plan; some signals are
clean periodic, some have noise on top, and the multiplexed message
rotates through its four signal sets.

Run:
    python3 generate_blf.py

Requires:
    pip install python-can cantools
"""

from __future__ import annotations

import math
import random
import struct
from pathlib import Path

import can
import cantools

HERE = Path(__file__).resolve().parent
DBC_PATH = HERE / "cannet-demo.dbc"
BLF_PATH = HERE / "cannet-demo.blf"
DURATION_S = 10.0
SEED = 0xCA7F00D


def main() -> None:
    rnd = random.Random(SEED)
    db = cantools.database.load_file(str(DBC_PATH))

    msg_vehicle = db.get_message_by_name("VehicleState")
    msg_battery = db.get_message_by_name("BatteryDiag")
    msg_sensor = db.get_message_by_name("SensorMux")
    msg_gps = db.get_message_by_name("GpsPosition")
    msg_adas = db.get_message_by_name("AdasState")

    schedule: list[tuple[float, callable]] = []

    # VehicleState — 50 ms / 20 Hz. VehSpeed ramps with mild noise; RPM
    # follows a sine; gear cycles every ~2 s; brake is pure noise pulses.
    period = 0.050
    n = int(DURATION_S / period)
    for i in range(n):
        t = i * period
        speed = 60.0 + 30.0 * math.sin(2 * math.pi * t / 6.0) + rnd.gauss(0, 0.5)
        rpm = 1500.0 + 800.0 * math.sin(2 * math.pi * t / 4.0 + 0.7)
        gear = (i // 40) % 8
        brake = max(0.0, 50.0 * math.sin(2 * math.pi * t / 2.5)) + rnd.gauss(0, 1.0)
        brake = max(0.0, min(127.5, brake))
        data = msg_vehicle.encode(
            {
                "VehSpeed": clamp(speed, 0, 655.35),
                "EngineRpm": clamp(rpm, 0, 16383.75),
                "GearLever": gear,
                "BrakePedal": brake,
            }
        )
        schedule.append((t, _make_msg(msg_vehicle, data, fd=False)))

    # BatteryDiag — 100 ms / 10 Hz, extended ID. Voltage drifts slowly;
    # temp is a slow sine + noise; current alternates with sign.
    period = 0.100
    n = int(DURATION_S / period)
    for i in range(n):
        t = i * period
        voltage = 12.6 + 0.3 * math.sin(2 * math.pi * t / 8.0) + rnd.gauss(0, 0.02)
        temp = 32.0 + 8.0 * math.sin(2 * math.pi * t / 12.0) + rnd.gauss(0, 0.4)
        current = 25.0 * math.sin(2 * math.pi * t / 1.5) + rnd.gauss(0, 0.5)
        data = msg_battery.encode(
            {
                "BattVoltage": clamp(voltage, 0, 655.35),
                "BattTemp": clamp(temp, -3276.8, 3236.7),
                "BattCurrent": clamp(current, -1638.4, 1638.35),
            }
        )
        schedule.append((t, _make_msg(msg_battery, data, fd=False)))

    # SensorMux — 20 ms / 50 Hz, multiplexed. Cycles selector 0..3 each
    # frame so all four signal sets show up frequently.
    period = 0.020
    n = int(DURATION_S / period)
    for i in range(n):
        t = i * period
        sensor_id = i % 4
        if sensor_id == 0:
            payload = {
                "SensorId": 0,
                "TempSensor": 22.0 + 4.0 * math.sin(2 * math.pi * t / 5.0)
                + rnd.gauss(0, 0.1),
            }
        elif sensor_id == 1:
            payload = {
                "SensorId": 1,
                "PressureSensor": 101.3 + 3.0 * math.sin(2 * math.pi * t / 3.0),
            }
        elif sensor_id == 2:
            payload = {
                "SensorId": 2,
                "HumiditySensor": 45.0 + 5.0 * math.sin(2 * math.pi * t / 7.0)
                + rnd.gauss(0, 0.2),
            }
        else:
            payload = {
                "SensorId": 3,
                "AccelSensor": 0.05 * math.sin(2 * math.pi * t / 0.4)
                + rnd.gauss(0, 0.005),
            }
        data = msg_sensor.encode(payload)
        schedule.append((t, _make_msg(msg_sensor, data, fd=False)))

    # GpsPosition — 1 s / 1 Hz, CAN FD, extended ID. Lat/Lon are true
    # floats; altitude is a scaled signed int.
    period = 1.000
    n = int(DURATION_S / period)
    for i in range(n):
        t = i * period
        lat = 37.7749 + 0.0001 * t
        lon = -122.4194 + 0.0001 * t
        alt = 50.0 + 5.0 * math.sin(2 * math.pi * t / 6.0)
        hdop = 1.2 + 0.1 * rnd.random()
        data = msg_gps.encode(
            {
                "Latitude": lat,
                "Longitude": lon,
                "Altitude": clamp(alt, -21474836.48, 21474836.47),
                "HDOP": clamp(hdop, 0, 25.5),
            }
        )
        schedule.append((t, _make_msg(msg_gps, data, fd=True)))

    # AdasState — 10 ms / 100 Hz, CAN FD. Eight target distances each
    # follow their own waveform.
    period = 0.010
    n = int(DURATION_S / period)
    for i in range(n):
        t = i * period
        payload = {"ObjectCount": 8}
        for k in range(8):
            base = 20.0 + 5.0 * k
            d = base + 4.0 * math.sin(2 * math.pi * t / (1.0 + 0.3 * k) + k)
            d += rnd.gauss(0, 0.05)
            payload[f"TargetDistance{k}"] = clamp(d, -327.68, 327.67)
        data = msg_adas.encode(payload)
        schedule.append((t, _make_msg(msg_adas, data, fd=True)))

    # Sort by timestamp so the BLF reads in chronological order.
    schedule.sort(key=lambda x: x[0])

    with can.io.BLFWriter(str(BLF_PATH)) as writer:
        # Anchor t=0 to the BLF "object" timeline. python-can uses the
        # timestamp on each message directly, so we pass the absolute
        # offset from the start.
        for t, msg in schedule:
            msg.timestamp = t
            writer.on_message_received(msg)

    print(f"Wrote {len(schedule)} frames over {DURATION_S} s -> {BLF_PATH}")


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _make_msg(message, data: bytes, fd: bool) -> can.Message:
    return can.Message(
        arbitration_id=message.frame_id,
        is_extended_id=message.is_extended_frame,
        is_fd=fd,
        bitrate_switch=fd,
        data=data,
        dlc=len(data),
    )


if __name__ == "__main__":
    main()
