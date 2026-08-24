// Pure builder tests for `viewSignalsPush.ts` — each view's own
// persisted shape mapped to the wire `ViewSignalRef`. The push hook
// itself (`usePushViewSignals`) needs a DOM, and is covered in
// `viewSignalsPush.dom.test.tsx`.

import { describe, expect, it } from "vitest";

import {
  colorMapViewSignalRefs,
  plotViewSignalRefs,
  signalsViewSignalRefs,
  transmitViewSignalRefs,
} from "./viewSignalsPush";
import type { PlotAreaConfig, SignalRef } from "./plotPanelConfig";
import type { DraggableSignalRef } from "./dragSignals";
import type { TransmitFrameConfig } from "./transmitFrameConfig";

function signal(over: Partial<SignalRef> = {}): SignalRef {
  return {
    busId: "power",
    messageId: 0x100,
    extended: false,
    signalName: "VehicleSpeed",
    messageName: "Chassis",
    unit: "km/h",
    ...over,
  };
}

function area(signals: SignalRef[], patterns: string[] = []): PlotAreaConfig {
  return { id: "a1", signals, patterns: patterns.length ? patterns : undefined };
}

describe("plotViewSignalRefs", () => {
  it("flattens every area's manual signals, carrying messageName and unit", () => {
    const areas = [
      area([signal()]),
      area([signal({ signalName: "BrakePressure", unit: "bar" })]),
    ];
    const refs = plotViewSignalRefs(areas, areas);
    expect(refs).toEqual([
      {
        busId: "power",
        messageId: 0x100,
        extended: false,
        signalName: "VehicleSpeed",
        fileBacked: undefined,
        messageName: "Chassis",
        unit: "km/h",
      },
      {
        busId: "power",
        messageId: 0x100,
        extended: false,
        signalName: "BrakePressure",
        fileBacked: undefined,
        messageName: "Chassis",
        unit: "bar",
      },
    ]);
  });

  it("carries fileBacked through", () => {
    const areas = [area([signal({ fileBacked: true })], ["Cell.*"])];
    const refs = plotViewSignalRefs(areas, areas);
    expect(refs).toHaveLength(1);
    expect(refs[0].fileBacked).toBe(true);
  });

  it("emits a pattern match identity-only, dropping the resolved messageName and unit", () => {
    const areas = [area([], ["Cell.*"])];
    const resolved = [
      area([signal({ signalName: "Cell1", messageName: "Bms", unit: "V" })], ["Cell.*"]),
    ];
    expect(plotViewSignalRefs(areas, resolved)).toEqual([
      { busId: "power", messageId: 0x100, extended: false, signalName: "Cell1" },
    ]);
  });

  it("keeps the manual pick's recorded fields when a pattern also matches it", () => {
    const picked = signal({ signalName: "Cell1" });
    const areas = [area([picked], ["Cell.*"])];
    // `applyAreaSelection` excludes a manual pick from its own area's
    // matches, but another area's pattern can still reach it.
    const resolved = [area([picked], ["Cell.*"]), area([signal({ signalName: "Cell1" })], ["Cell.*"])];
    const refs = plotViewSignalRefs([...areas, area([], ["Cell.*"])], resolved);
    expect(refs).toEqual([
      {
        busId: "power",
        messageId: 0x100,
        extended: false,
        signalName: "Cell1",
        fileBacked: undefined,
        messageName: "Chassis",
        unit: "km/h",
      },
    ]);
  });

  it("emits a pattern-derived row that carries overrides identity-only", () => {
    // A recolored pattern row persists as a `viaPattern` entry — it is
    // not a pick, so it has no recorded mapping to compare against.
    const over = signal({ signalName: "Cell2", viaPattern: true, colorPick: "#f00" });
    const areas = [area([over], ["Cell.*"])];
    expect(plotViewSignalRefs(areas, areas)).toEqual([
      { busId: "power", messageId: 0x100, extended: false, signalName: "Cell2" },
    ]);
  });

  it("emits one ref per identity when several areas match the same signal", () => {
    const areas = [area([], ["Cell.*"]), area([], ["Cell.*"])];
    const resolved = [
      area([signal({ signalName: "Cell1" })], ["Cell.*"]),
      area([signal({ signalName: "Cell1" })], ["Cell.*"]),
    ];
    expect(plotViewSignalRefs(areas, resolved)).toHaveLength(1);
  });

  it("is empty for an area whose patterns match nothing, and for no areas at all", () => {
    const areas = [area([], ["Cell.*"])];
    expect(plotViewSignalRefs(areas, areas)).toEqual([]);
    expect(plotViewSignalRefs([], [])).toEqual([]);
  });
});

describe("signalsViewSignalRefs", () => {
  function key(over: Partial<DraggableSignalRef> = {}): DraggableSignalRef {
    return {
      busId: "body",
      messageId: 0x310,
      extended: false,
      signalName: "AmbientTemp",
      messageName: "Climate",
      unit: "C",
      ...over,
    };
  }

  it("maps every manual selection key, carrying messageName and unit", () => {
    const refs = signalsViewSignalRefs([key(), key({ signalName: "CoolantTemp" })], []);
    expect(refs).toEqual([
      {
        busId: "body",
        messageId: 0x310,
        extended: false,
        signalName: "AmbientTemp",
        fileBacked: undefined,
        messageName: "Climate",
        unit: "C",
      },
      {
        busId: "body",
        messageId: 0x310,
        extended: false,
        signalName: "CoolantTemp",
        fileBacked: undefined,
        messageName: "Climate",
        unit: "C",
      },
    ]);
  });

  it("emits a pattern match identity-only, and dedupes it against the manual keys", () => {
    const refs = signalsViewSignalRefs(
      [key()],
      [
        { busId: "body", messageId: 0x310, extended: false, signalName: "AmbientTemp" },
        { busId: "body", messageId: 0x310, extended: false, signalName: "CabinSetpoint" },
      ],
    );
    expect(refs).toEqual([
      {
        busId: "body",
        messageId: 0x310,
        extended: false,
        signalName: "AmbientTemp",
        fileBacked: undefined,
        messageName: "Climate",
        unit: "C",
      },
      { busId: "body", messageId: 0x310, extended: false, signalName: "CabinSetpoint" },
    ]);
  });

  it("emits a matched file-backed signal with its flag", () => {
    const refs = signalsViewSignalRefs(
      [],
      [{ busId: null, messageId: 3, extended: false, signalName: "Torque", fileBacked: true }],
    );
    expect(refs).toEqual([
      { busId: null, messageId: 3, extended: false, signalName: "Torque", fileBacked: true },
    ]);
  });

  it("is empty for an empty selection", () => {
    expect(signalsViewSignalRefs([], [])).toEqual([]);
  });
});

describe("colorMapViewSignalRefs", () => {
  it("emits the one target signal once picked", () => {
    const refs = colorMapViewSignalRefs({
      busId: "power",
      messageId: 0x2a0,
      extended: false,
      signalName: "PackCurrent",
    });
    expect(refs).toEqual([
      { busId: "power", messageId: 0x2a0, extended: false, signalName: "PackCurrent" },
    ]);
  });

  it("defaults a missing busId to null", () => {
    const refs = colorMapViewSignalRefs({
      messageId: 1,
      extended: false,
      signalName: "X",
    });
    expect(refs[0].busId).toBeNull();
  });

  it("is empty before a target is picked", () => {
    expect(
      colorMapViewSignalRefs({ busId: null, messageId: 0, extended: false, signalName: "" }),
    ).toEqual([]);
  });
});

describe("transmitViewSignalRefs", () => {
  function frame(over: Partial<TransmitFrameConfig> = {}): TransmitFrameConfig {
    return {
      id: "f1",
      description: "",
      busId: "power",
      canId: 0x110,
      extended: false,
      kind: "classic",
      dataHex: "",
      cycleMs: 100,
      cycleMode: "manual",
      brs: false,
      dlc: 0,
      calc: null,
      ...over,
    };
  }

  it("is empty for a frame with no calculated-field spec", () => {
    expect(transmitViewSignalRefs([frame()])).toEqual([]);
  });

  it("emits the counter signal identity-only", () => {
    const refs = transmitViewSignalRefs([
      frame({ calc: { counter: { signal: "Counter", increment: 1 } } }),
    ]);
    expect(refs).toEqual([
      { busId: "power", messageId: 0x110, extended: false, signalName: "Counter" },
    ]);
  });

  it("emits both the counter and the CRC signal when both are set", () => {
    const refs = transmitViewSignalRefs([
      frame({
        calc: {
          counter: { signal: "Counter", increment: 1 },
          crc: { signal: "Crc", range_bits: [0, 8] },
        },
      }),
    ]);
    expect(refs.map((r) => r.signalName)).toEqual(["Counter", "Crc"]);
  });

  it("flattens across several frames", () => {
    const refs = transmitViewSignalRefs([
      frame({ id: "f1", canId: 0x110, calc: { counter: { signal: "A", increment: 1 } } }),
      frame({ id: "f2", canId: 0x111, calc: { crc: { signal: "B", range_bits: [0, 8] } } }),
    ]);
    expect(refs).toEqual([
      { busId: "power", messageId: 0x110, extended: false, signalName: "A" },
      { busId: "power", messageId: 0x111, extended: false, signalName: "B" },
    ]);
  });
});
