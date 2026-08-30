// The bus-health join: three host models against the project's own bus
// list. The rule under test throughout is that **absent is not zero** —
// a cell the host cannot know reads as `null`, and only a bus that is
// genuinely configured and silent reads as a figure.

import { describe, expect, it } from "vitest";

import {
  adapterIdentity,
  anyBusHasErrors,
  busHealthConcerns,
  busHealthRows,
  type BusHealthInputs,
} from "./busHealth";
import type { Bus, BusConnStates, BusHealthMap, InterfaceBinding } from "./types";

const buses: Bus[] = [
  { id: "b1", name: "Powertrain" },
  { id: "b2", name: "Chassis" },
  { id: "b3", name: "Diagnostics" },
  { id: "b4", name: "Sim" },
];

const bindings: InterfaceBinding[] = [
  { server: "local", interface: "pcan:PCAN_USBBUS1(SN:1)", bus_id: "b1" },
  { server: "local", interface: "pcan:PCAN_USBBUS2(SN:1)", bus_id: "b2" },
  { kind: "local-virtual-bus", server: "local-vbus://v", interface: "bus", bus_id: "b4" },
];

const interfaces = [
  { id: "pcan:PCAN_USBBUS1(SN:1)", display_name: "PEAK PCAN-USB FD (ch:1)", fd_capable: true },
  { id: "pcan:PCAN_USBBUS2(SN:1)", display_name: "PEAK PCAN-USB FD (ch:2)", fd_capable: true },
];

const connStates: BusConnStates = {
  b1: {
    kind: "connected",
    applied: { speedBps: 500000, fdEnabled: true, fdDataSpeedBps: 2000000 },
  },
  b2: { kind: "connected", applied: { speedBps: 500000, fdEnabled: false, fdDataSpeedBps: null } },
  // A virtual bus has no controller to configure, so the host applied
  // nothing at all.
  b4: { kind: "connected", applied: null },
};

const health: BusHealthMap = {
  b1: { controller: { state: "active", tec: 0, rec: 0 }, loadPercent: 34, errorCount: 0, errorRate: 0 },
  b2: {
    controller: { state: "passive", tec: 142, rec: 9 },
    loadPercent: 71,
    errorCount: 1284,
    errorRate: 312,
    lastErrorTsNs: 1_000_000,
  },
  b4: { errorCount: 0, errorRate: 0 },
};

const inputs: BusHealthInputs = { buses, bindings, interfaces, connStates, health };

const row = (id: string, over: Partial<BusHealthInputs> = {}) => {
  const found = busHealthRows({ ...inputs, ...over }).find((r) => r.busId === id);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
};

describe("busHealthRows", () => {
  it("gives every project bus a row, in project order", () => {
    expect(busHealthRows(inputs).map((r) => r.name)).toEqual([
      "Powertrain",
      "Chassis",
      "Diagnostics",
      "Sim",
    ]);
  });

  it("reads a healthy bus's state, load, counters and adapter", () => {
    const r = row("b1");
    // A healthy controller reads as connected. "Error-active" is the
    // ISO 11898-1 name for exactly this state, and it reads to anyone
    // who is not holding the standard as though a fault were running.
    expect(r.stateText).toBe("Connected");
    expect(r.tone).toBe("active");
    expect(r.loadPercent).toBe(34);
    expect(r.tec).toBe(0);
    expect(r.rec).toBe(0);
    expect(r.adapter).toBe("PEAK PCAN-USB FD (ch:1)");
    // The applied configuration is the project panel's own formatter's
    // output, so one bitrate has exactly one spelling in the app.
    expect(r.applied).toBe("500k · FD data 2M");
  });

  it("keeps the ISO name for a healthy controller in the tooltip", () => {
    // The relabel drops a word a CAN engineer looks for, so the
    // standard's own name has to stay reachable — the cell says
    // Connected, the hover says which ISO state that is.
    const r = row("b1");
    expect(r.stateTitle).toContain("Error-active");
    expect(r.stateTitle).toContain("ISO 11898-1");
  });

  it("gives a state that already reads as trouble no second spelling", () => {
    // The control for the test above: only the healthy state was
    // misread, so only it gets a tooltip. A bus-off row saying
    // "Bus-off (ISO 11898-1: Bus-off)" would be noise.
    expect(row("b2").stateTitle).toBeNull();
    expect(row("b3").stateTitle).toBeNull();
  });

  it("separates an error-passive bus and carries its counters", () => {
    const r = row("b2");
    expect(r.stateText).toBe("Error-passive");
    expect(r.tone).toBe("passive");
    expect(r.tec).toBe(142);
    expect(r.rec).toBe(9);
    expect(r.errorCount).toBe(1284);
    expect(r.applied).toBe("500k");
  });

  it("reads an unbound, unconnected bus as absent all the way across", () => {
    const r = row("b3");
    expect(r.stateText).toBe("Not connected");
    expect(r.tone).toBe("off");
    expect(r.loadPercent).toBeNull();
    expect(r.tec).toBeNull();
    expect(r.rec).toBeNull();
    expect(r.errorCount).toBeNull();
    expect(r.adapter).toBeNull();
    expect(r.applied).toBeNull();
  });

  it("says why a virtual bus has no load rather than showing it as zero", () => {
    const r = row("b4");
    expect(r.loadPercent).toBeNull();
    expect(r.loadAbsentReason).toMatch(/no configurable bitrate/);
    expect(r.tec).toBeNull();
    // `describeAppliedConfig` answers `null` for a bus the host applied
    // nothing to, and an in-process virtual bus is exactly that: there
    // is no controller and therefore no configuration to report. The
    // accepted mock drew "driver default (nothing sent)" in this cell,
    // which is the *different* case of a real adapter left on its own
    // default — reusing the formatter is the ruling, so the formatter's
    // answer stands.
    expect(r.applied).toBeNull();
  });

  it("shows a bus-off bus at zero per cent, because that is the true reading", () => {
    // The distinction the panel exists to draw, and the control for the
    // test above: both cells would render identically if "off the wire"
    // and "we cannot know" collapsed into one answer.
    const r = row("b2", {
      health: {
        ...health,
        b2: {
          controller: { state: "busOff", tec: 256, rec: 0 },
          loadPercent: 0,
          errorCount: 9471,
          errorRate: 2100,
        },
      },
    });
    expect(r.tone).toBe("busoff");
    expect(r.stateText).toBe("Bus-off");
    expect(r.loadPercent).toBe(0);
    expect(r.loadAbsentReason).toBeNull();
  });

  it("shows an interface the driver cannot reach as its own state, not as bus-off", () => {
    // A removed adapter and a bus-off controller must not read alike:
    // bus-off is a present controller that recovers on its own, and
    // rendering the two the same would promise a recovery that cannot
    // happen without someone plugging the cable back in.
    const r = row("b2", {
      health: {
        ...health,
        b2: {
          controller: { state: "unavailable", tec: 0, rec: 0 },
          loadPercent: 0,
          errorCount: 0,
          errorRate: 0,
        },
      },
    });
    expect(r.tone).toBe("unavailable");
    expect(r.stateText).toBe("Adapter unavailable");
  });

  it("gives a controller over the warning limit its own words and the warning tone", () => {
    // The reading an unplugged CAN cable produces on its way to
    // error-passive. Before it had a name it arrived as "active", which
    // is why a real fault looked like a healthy bus.
    const r = row("b2", {
      health: {
        ...health,
        b2: {
          controller: { state: "warning", tec: 104, rec: 0 },
          loadPercent: 0,
          errorCount: 0,
          errorRate: 0,
        },
      },
    });
    expect(r.tone).toBe("warning");
    expect(r.stateText).toBe("Error-warning");
    expect(r.tec).toBe(104);
  });

  it("falls back to the wire id for an interface the app has not enumerated", () => {
    expect(row("b1", { interfaces: [] }).adapter).toBe("pcan:PCAN_USBBUS1(SN:1)");
  });

  it("says a virtual bus has no hardware rather than leaking its wire id", () => {
    // Every local-vbus binding carries the same canonical interface
    // name, which is a wire id and not something to show anyone. This
    // is the Adapter column — the honest answer for a bus with no
    // hardware behind it is that there is none.
    const r = row("b4");
    expect(r.adapter).toBe("virtual bus");
    // And not the bus's own name: column 1 already carries that, so
    // repeating it here would say nothing.
    expect(r.name).toBe("Sim");
    expect(r.adapter).not.toBe(r.name);
  });
});

describe("busHealthConcerns", () => {
  it("names only the buses whose controller is not error-active", () => {
    expect(busHealthConcerns(busHealthRows(inputs))).toEqual([
      { bus: "Chassis", state: "error-passive", busOff: false },
    ]);
  });

  it("treats a bus that has reported nothing as no concern at all", () => {
    // The control: silence is not a fault. Without this the launcher
    // would tint for every virtual bus and every driver that does not
    // answer, which is exactly the alarm nobody would keep looking at.
    expect(busHealthConcerns(busHealthRows({ ...inputs, health: {} }))).toEqual([]);
  });

  it("counts an unreachable adapter as a fault the launcher tints for", () => {
    const concerns = busHealthConcerns(
      busHealthRows({
        ...inputs,
        health: {
          b1: { controller: { state: "unavailable", tec: 0, rec: 0 }, errorCount: 0, errorRate: 0 },
        },
      }),
    );
    expect(concerns).toEqual([{ bus: "Powertrain", state: "adapter unavailable", busOff: true }]);
  });

  it("names a bus over the warning limit as a concern, tinted as a warning", () => {
    // Not the launcher's fault tint: the controller is present and its
    // counters fall again on their own. But it is a concern -- a
    // launcher that stayed dark until 128 would say nothing through the
    // part of a fault an operator could still act on.
    const concerns = busHealthConcerns(
      busHealthRows({
        ...inputs,
        health: {
          b1: { controller: { state: "warning", tec: 104, rec: 0 }, errorCount: 0, errorRate: 0 },
        },
      }),
    );
    expect(concerns).toEqual([{ bus: "Powertrain", state: "error-warning", busOff: false }]);
  });

  it("counts a bus-off bus as a fault rather than a warning", () => {
    const concerns = busHealthConcerns(
      busHealthRows({
        ...inputs,
        health: { b1: { controller: { state: "busOff", tec: 256, rec: 0 }, errorCount: 0, errorRate: 0 } },
      }),
    );
    expect(concerns).toEqual([{ bus: "Powertrain", state: "bus-off", busOff: true }]);
  });
});

describe("anyBusHasErrors", () => {
  it("says no for an empty map and for a capture with clean buses", () => {
    // The gate the trace view's error-frame collapse asks before it
    // engages. A clean capture must not be routed through the host's
    // filtered paging to exclude rows that never occur.
    expect(anyBusHasErrors({})).toBe(false);
    expect(
      anyBusHasErrors({
        b1: { errorCount: 0, errorRate: 0 },
        b2: { errorCount: 0, errorRate: 0 },
      }),
    ).toBe(false);
  });

  it("says yes on the first error frame, on any bus", () => {
    expect(
      anyBusHasErrors({
        b1: { errorCount: 0, errorRate: 0 },
        b2: { errorCount: 1, errorRate: 0 },
      }),
    ).toBe(true);
  });
});

describe("adapterIdentity", () => {
  it("reports nothing at all for an adapter whose driver reported nothing", () => {
    // The control the whole feature is judged against: a backend that
    // exposes no identity — an in-process virtual bus, a Kvaser channel
    // today — has to look exactly as it did before the fields existed.
    // A row of em dashes would be four claims about facts nobody has.
    expect(adapterIdentity(interfaces[0])).toBeNull();
    expect(adapterIdentity(undefined)).toBeNull();
  });

  it("folds the driver stack and its version into one phrase", () => {
    // A version with no stack to attach it to says nothing, so the two
    // are one slot rather than two.
    expect(
      adapterIdentity({
        ...interfaces[0],
        driver_name: "PCAN-Basic",
        driver_version: "4.9.0.942",
      }),
    ).toEqual({ driver: "PCAN-Basic 4.9.0.942", firmware: null, serial: null });
  });

  it("keeps each slot the driver did not answer for absent, not blank", () => {
    // PCAN-Basic exposes no hardware serial and no XL call reports
    // device firmware, so these absences are the normal case rather
    // than an error path — and neither may acquire a placeholder.
    expect(
      adapterIdentity({
        ...interfaces[0],
        driver_name: "Vector XL Driver Library",
        driver_version: "11.4.32",
        serial_number: "12345",
      }),
    ).toEqual({
      driver: "Vector XL Driver Library 11.4.32",
      firmware: null,
      serial: "12345",
    });
  });

  it("survives a driver that reported a version but not a name", () => {
    expect(adapterIdentity({ ...interfaces[0], driver_version: "4.9.0.942" })).toEqual({
      driver: "4.9.0.942",
      firmware: null,
      serial: null,
    });
  });
});

describe("busHealthRows receive overruns", () => {
  const inputs = (h: BusHealthMap): BusHealthInputs => ({
    buses,
    bindings,
    interfaces,
    connStates,
    health: h,
  });

  it("keeps a driver that saw no loss apart from one that never looked", () => {
    // Zero is the reading that licenses treating the capture as the
    // whole of what the bus sent. `null` is nobody having checked, and
    // every other figure in the row is read as though the first were
    // true — so collapsing them is the exact failure this counter was
    // opened to close.
    const rows = busHealthRows(
      inputs({
        b1: {
          controller: { state: "active", tec: 0, rec: 0, rxOverruns: 0 },
          errorCount: 0,
          errorRate: 0,
        },
        b2: {
          controller: { state: "warning", tec: 104, rec: 0, rxOverruns: 6 },
          errorCount: 0,
          errorRate: 0,
        },
        b3: { errorCount: 0, errorRate: 0 },
      }),
    );
    const by = Object.fromEntries(rows.map((r) => [r.busId, r]));
    expect(by.b1.rxOverruns).toBe(0);
    expect(by.b2.rxOverruns).toBe(6);
    // A bus whose driver does not report receive loss, and a bus the
    // host has said nothing about at all: both `null`, both an em dash.
    expect(by.b3.rxOverruns).toBeNull();
    expect(by.b4.rxOverruns).toBeNull();
  });
});
