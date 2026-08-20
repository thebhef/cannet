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
    const refs = plotViewSignalRefs([
      area([signal()]),
      area([signal({ signalName: "BrakePressure", unit: "bar" })]),
    ]);
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

  it("carries fileBacked through, and never emits anything for a pattern alone", () => {
    const refs = plotViewSignalRefs([
      area([signal({ fileBacked: true })], ["Cell.*"]),
    ]);
    // Exactly one ref — the manual pick. The pattern contributes
    // nothing: it has no recorded configuration to compare against.
    expect(refs).toHaveLength(1);
    expect(refs[0].fileBacked).toBe(true);
  });

  it("is empty for an area with only patterns, and for no areas at all", () => {
    expect(plotViewSignalRefs([area([], ["Cell.*"])])).toEqual([]);
    expect(plotViewSignalRefs([])).toEqual([]);
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
    const refs = signalsViewSignalRefs([key(), key({ signalName: "CoolantTemp" })]);
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

  it("is empty for an empty selection", () => {
    expect(signalsViewSignalRefs([])).toEqual([]);
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
