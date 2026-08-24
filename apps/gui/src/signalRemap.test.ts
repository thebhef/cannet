// The remap pick's one shared operation (`signalRemap.ts`): pointing
// every persisted reference to one signal at the signal that replaced
// it. The per-store rewrites are covered here, and so is the guarantee
// the operation exists for — one invocation reaching every store.
// `ViewSignalsPanel.dom.test.tsx` covers the other half: one pick in the
// panel, through the live element registry, landing on two different
// stores.

import { beforeEach, describe, expect, it, vi } from "vitest";

const hostCalls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
let POOL: unknown[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    hostCalls.push({ cmd, args });
    if (cmd === "list_transmit_frames") return POOL;
    return undefined;
  }),
}));

import {
  remapColorMapPatch,
  remapElementPatch,
  remapPlotConfig,
  remapSignal,
  remapSignalsConfig,
  remapTransmitFrames,
  type SignalRemap,
  type SignalRemapStores,
} from "./signalRemap";
import type { ProjectElement } from "./types";
import type { TransmitFrameConfig } from "./transmitFrameConfig";

const REMAP: SignalRemap = {
  fromBusId: "power",
  toBusId: "power",
  messageId: 0x100,
  extended: false,
  from: "EngSpeed",
  to: "EngineSpeed",
  messageName: "EngineData",
  unit: "rpm",
  dbcPath: "powertrain.dbc",
};

const OLD_KEY = "power|s:256:EngSpeed";
const NEW_KEY = "power|s:256:EngineSpeed";

function plotSignal(name: string, over: Record<string, unknown> = {}) {
  return {
    busId: "power",
    messageId: 0x100,
    extended: false,
    signalName: name,
    messageName: "EngineData_old",
    unit: "1/min",
    ...over,
  };
}

describe("remapPlotConfig", () => {
  it("rewrites a matching series' name and the fields the area recorded it under", () => {
    const config = { areas: [{ id: "a1", signals: [plotSignal("EngSpeed", { colorPick: "#abcdef" })] }] };
    const next = remapPlotConfig(config, REMAP) as {
      areas: { signals: Record<string, unknown>[] }[];
    } | null;
    expect(next).not.toBeNull();
    expect(next?.areas[0].signals[0]).toEqual({
      busId: "power",
      messageId: 0x100,
      extended: false,
      signalName: "EngineSpeed",
      messageName: "EngineData",
      unit: "rpm",
      colorPick: "#abcdef",
    });
  });

  it("leaves a config with no matching series alone, by identity", () => {
    const config = { areas: [{ id: "a1", signals: [plotSignal("OtherSignal")] }] };
    expect(remapPlotConfig(config, REMAP)).toBeNull();
  });

  it("does not match a series on another bus or another message", () => {
    const config = {
      areas: [
        { id: "a1", signals: [plotSignal("EngSpeed", { busId: "body" })] },
        { id: "a2", signals: [plotSignal("EngSpeed", { messageId: 0x101 })] },
        { id: "a3", signals: [plotSignal("EngSpeed", { extended: true })] },
      ],
    };
    expect(remapPlotConfig(config, REMAP)).toBeNull();
  });

  it("never matches a file-backed series — no database ever bore on one", () => {
    const config = { areas: [{ id: "a1", signals: [plotSignal("EngSpeed", { fileBacked: true })] }] };
    expect(remapPlotConfig(config, REMAP)).toBeNull();
  });

  it("drops the rewritten series when the area already plots the target", () => {
    const config = {
      areas: [{ id: "a1", signals: [plotSignal("EngSpeed"), plotSignal("EngineSpeed")] }],
    };
    const next = remapPlotConfig(config, REMAP) as {
      areas: { signals: { signalName: string }[] }[];
    } | null;
    expect(next?.areas[0].signals.map((s) => s.signalName)).toEqual(["EngineSpeed"]);
  });

  it("follows the area's primary-signal key across the rename", () => {
    const config = {
      areas: [{ id: "a1", signals: [plotSignal("EngSpeed")], primarySignalKey: OLD_KEY }],
    };
    const next = remapPlotConfig(config, REMAP) as {
      areas: { primarySignalKey: string }[];
    } | null;
    expect(next?.areas[0].primarySignalKey).toBe(NEW_KEY);
  });

  it("keeps every other panel-level key it does not understand", () => {
    const config = { areas: [{ id: "a1", signals: [plotSignal("EngSpeed")] }], cursorX: 42 };
    const next = remapPlotConfig(config, REMAP) as { cursorX: number } | null;
    expect(next?.cursorX).toBe(42);
  });
});

describe("remapSignalsConfig", () => {
  it("rewrites a manual selection key", () => {
    const config = { selection: { keys: [plotSignal("EngSpeed")], patterns: ["Cell(\\d+)"] } };
    const next = remapSignalsConfig(config, REMAP) as {
      selection: { keys: { signalName: string }[]; patterns: string[] };
    } | null;
    expect(next?.selection.keys[0].signalName).toBe("EngineSpeed");
    // Patterns are re-evaluated against the live catalog every render —
    // there is no stored identity in one to rewrite.
    expect(next?.selection.patterns).toEqual(["Cell(\\d+)"]);
  });

  it("moves the signal's section assignment onto the new identity", () => {
    const config = {
      selection: { keys: [plotSignal("EngSpeed")] },
      sections: { names: ["Drive"], assignments: { [OLD_KEY]: "Drive" }, patterns: {} },
    };
    const next = remapSignalsConfig(config, REMAP) as {
      sections: { assignments: Record<string, string> };
    } | null;
    expect(next?.sections.assignments).toEqual({ [NEW_KEY]: "Drive" });
  });

  it("keeps the target's own section assignment when it already has one", () => {
    const config = {
      selection: { keys: [plotSignal("EngSpeed")] },
      sections: { names: [], assignments: { [OLD_KEY]: "Drive", [NEW_KEY]: "Chassis" }, patterns: {} },
    };
    const next = remapSignalsConfig(config, REMAP) as {
      sections: { assignments: Record<string, string> };
    } | null;
    expect(next?.sections.assignments).toEqual({ [NEW_KEY]: "Chassis" });
  });

  it("leaves a selection holding nothing that matches alone", () => {
    const config = { selection: { keys: [plotSignal("OtherSignal")] } };
    expect(remapSignalsConfig(config, REMAP)).toBeNull();
  });
});

describe("remapColorMapPatch", () => {
  const element = (over: Partial<Extract<ProjectElement, { kind: "colormap" }>> = {}) =>
    ({
      kind: "colormap",
      id: "cm1",
      busId: "power",
      messageId: 0x100,
      extended: false,
      signalName: "EngSpeed",
      rules: [],
      ...over,
    }) as Extract<ProjectElement, { kind: "colormap" }>;

  it("re-points the target signal, keeping the rules the user authored", () => {
    expect(remapColorMapPatch(element(), REMAP)).toEqual({ signalName: "EngineSpeed" });
  });

  it("leaves a colormap aimed at another signal alone", () => {
    expect(remapColorMapPatch(element({ signalName: "OtherSignal" }), REMAP)).toBeNull();
  });
});

describe("remapElementPatch", () => {
  it("has nothing to rewrite on a generator — its rules are patterns, not identities", () => {
    const el: ProjectElement = {
      kind: "generator",
      id: "g1",
      rules: [{ pattern: "EngSpeed", enabled: true }],
    };
    expect(remapElementPatch(el, REMAP)).toBeNull();
  });

  it("has nothing to rewrite on a transmit element — its frames live host-side", () => {
    const el: ProjectElement = { kind: "transmit", id: "t1", sinks: [], frameIds: ["f1"] };
    expect(remapElementPatch(el, REMAP)).toBeNull();
  });

  it("reaches a plot element's config", () => {
    const el: ProjectElement = {
      kind: "plot",
      id: "p1",
      sources: ["*"],
      config: { areas: [{ id: "a1", signals: [plotSignal("EngSpeed")] }] },
    };
    const patch = remapElementPatch(el, REMAP) as { config: { areas: { signals: { signalName: string }[] }[] } } | null;
    expect(patch?.config.areas[0].signals[0].signalName).toBe("EngineSpeed");
  });
});

describe("remapTransmitFrames", () => {
  const frame = (over: Partial<TransmitFrameConfig> = {}): TransmitFrameConfig => ({
    id: "f1",
    description: "",
    busId: "power",
    canId: 0x100,
    extended: false,
    kind: "classic",
    dataHex: "00",
    cycleMs: 100,
    cycleMode: "manual",
    brs: false,
    dlc: 8,
    calc: null,
    ...over,
  });

  it("rewrites a counter's and a CRC's target signal", () => {
    const frames = [
      frame({
        calc: {
          counter: { signal: "EngSpeed", increment: 1 },
          crc: { signal: "EngSpeed", range_bits: [0, 56] },
        },
      }),
    ];
    const changed = remapTransmitFrames(frames, REMAP);
    expect(changed).toHaveLength(1);
    expect(changed[0].calc?.counter?.signal).toBe("EngineSpeed");
    expect(changed[0].calc?.crc?.signal).toBe("EngineSpeed");
    expect(changed[0].calc?.counter?.increment).toBe(1);
  });

  it("ignores a frame on another bus or another id", () => {
    const calc = { counter: { signal: "EngSpeed", increment: 1 } };
    expect(remapTransmitFrames([frame({ busId: "body", calc })], REMAP)).toEqual([]);
    expect(remapTransmitFrames([frame({ canId: 0x101, calc })], REMAP)).toEqual([]);
  });

  it("returns only the frames that actually changed", () => {
    const frames = [
      frame({ id: "f1", calc: null }),
      frame({ id: "f2", calc: { counter: { signal: "Other", increment: 1 } } }),
      frame({ id: "f3", calc: { counter: { signal: "EngSpeed", increment: 1 } } }),
    ];
    expect(remapTransmitFrames(frames, REMAP).map((f) => f.id)).toEqual(["f3"]);
  });
});

// The one remap that moves a bus: a reference saved before per-bus
// signal binding names none, decodes nothing (ADR 0054), and the repair
// the panel offers is a definition on a bus that does decode. The name
// stays; the identity every store holds moves onto the bus.
describe("re-pointing a reference that names no bus", () => {
  const REPOINT: SignalRemap = {
    fromBusId: null,
    toBusId: "power",
    messageId: 0x100,
    extended: false,
    from: "EngSpeed",
    to: "EngSpeed",
    messageName: "EngineData",
    unit: "rpm",
    dbcPath: "powertrain.dbc",
  };
  const BUSLESS_KEY = "*|s:256:EngSpeed";
  const ON_POWER_KEY = "power|s:256:EngSpeed";
  const busless = (over: Record<string, unknown> = {}) =>
    plotSignal("EngSpeed", { busId: null, ...over });

  it("moves a plot series and its area's primary key onto the bus", () => {
    const config = {
      areas: [{ id: "a1", signals: [busless()], primarySignalKey: BUSLESS_KEY }],
    };
    const next = remapPlotConfig(config, REPOINT) as {
      areas: { signals: Record<string, unknown>[]; primarySignalKey: string }[];
    } | null;
    expect(next?.areas[0].signals[0]).toMatchObject({ busId: "power", signalName: "EngSpeed" });
    expect(next?.areas[0].primarySignalKey).toBe(ON_POWER_KEY);
  });

  it("leaves a series that already names a bus alone", () => {
    const config = { areas: [{ id: "a1", signals: [plotSignal("EngSpeed")] }] };
    expect(remapPlotConfig(config, REPOINT)).toBeNull();
  });

  it("moves the signals view's selection key and its section assignment", () => {
    const config = {
      selection: { keys: [busless()] },
      sections: { names: ["Drive"], assignments: { [BUSLESS_KEY]: "Drive" }, patterns: {} },
    };
    const next = remapSignalsConfig(config, REPOINT) as {
      selection: { keys: Record<string, unknown>[] };
      sections: { assignments: Record<string, string> };
    } | null;
    expect(next?.selection.keys[0]).toMatchObject({ busId: "power" });
    expect(next?.sections.assignments).toEqual({ [ON_POWER_KEY]: "Drive" });
  });

  it("moves a colormap's target onto the bus", () => {
    const element = {
      kind: "colormap",
      id: "cm1",
      busId: null,
      messageId: 0x100,
      extended: false,
      signalName: "EngSpeed",
      rules: [],
    } as unknown as Extract<ProjectElement, { kind: "colormap" }>;
    expect(remapColorMapPatch(element, REPOINT)).toEqual({
      signalName: "EngSpeed",
      busId: "power",
    });
  });

  it("moves no transmit frame — the frame's own bus is not the reference's", () => {
    const frame: TransmitFrameConfig = {
      id: "f1",
      description: "",
      busId: "power",
      canId: 0x100,
      extended: false,
      kind: "classic",
      dataHex: "00",
      cycleMs: 100,
      cycleMode: "manual",
      brs: false,
      dlc: 8,
      calc: { counter: { signal: "EngSpeed", increment: 1 } },
    };
    expect(remapTransmitFrames([frame], REPOINT)).toEqual([]);
  });

  it("carries the colour override onto the new identity", async () => {
    const colors: { key: string; color: string | null }[] = [];
    await remapSignal(
      {
        elements: [],
        updateElement: () => {},
        signalColors: { [BUSLESS_KEY]: "#123456" },
        setSignalColor: (key, color) => colors.push({ key, color }),
      },
      REPOINT,
    );
    expect(colors).toEqual([
      { key: ON_POWER_KEY, color: "#123456" },
      { key: BUSLESS_KEY, color: null },
    ]);
  });

  it("is a no-op when neither the name nor the bus moves", async () => {
    const patches: string[] = [];
    await remapSignal(
      {
        elements: [
          {
            kind: "plot",
            id: "p1",
            sources: ["*"],
            config: { areas: [{ id: "a1", signals: [busless()] }] },
          },
        ],
        updateElement: (id) => patches.push(id),
        signalColors: {},
        setSignalColor: () => {},
      },
      { ...REPOINT, toBusId: null },
    );
    expect(patches).toEqual([]);
  });
});

describe("remapSignal — the one operation", () => {
  const PLOT: ProjectElement = {
    kind: "plot",
    id: "p1",
    sources: ["*"],
    config: { areas: [{ id: "a1", signals: [plotSignal("EngSpeed")] }] },
  };
  const SIGNALS: ProjectElement = {
    kind: "signals",
    id: "s1",
    sources: ["*"],
    config: { selection: { keys: [plotSignal("EngSpeed")], patterns: [] } },
  };
  const COLORMAP: ProjectElement = {
    kind: "colormap",
    id: "cm1",
    busId: "power",
    messageId: 0x100,
    extended: false,
    signalName: "EngSpeed",
    rules: [{ min: 0, max: 1, color: "#fff" }],
  };

  function stores(over: Partial<SignalRemapStores> = {}) {
    const patches: { id: string; patch: Partial<ProjectElement> }[] = [];
    const colors: { key: string; color: string | null }[] = [];
    const s: SignalRemapStores = {
      elements: [PLOT, SIGNALS, COLORMAP],
      updateElement: (id, patch) => patches.push({ id, patch }),
      signalColors: {},
      setSignalColor: (key, color) => colors.push({ key, color }),
      ...over,
    };
    return { stores: s, patches, colors };
  }

  beforeEach(() => {
    hostCalls.length = 0;
    POOL = [];
  });

  // The guarantee the operation exists for: one invocation, every
  // store. A rewrite spread across call sites is one missed store away
  // from a repair that silently didn't happen.
  it("reaches every store from a single invocation", async () => {
    POOL = [
      {
        id: "f1",
        description: "",
        request: { busId: "power", id: 0x100, extended: false, kind: "classic", data: [0], brs: false, dlc: 8 },
        cycleMs: 100,
        mode: "manual",
        running: false,
        calc: { counter: { signal: "EngSpeed", increment: 1 } },
      },
    ];
    const { stores: s, patches, colors } = stores({ signalColors: { [OLD_KEY]: "#123456" } });

    await remapSignal(s, REMAP);

    // Store 1 — the plot element's config.
    const plot = patches.find((p) => p.id === "p1")?.patch as { config: { areas: { signals: { signalName: string }[] }[] } };
    expect(plot.config.areas[0].signals[0].signalName).toBe("EngineSpeed");
    // Store 2 — the signals view's manual selection.
    const signals = patches.find((p) => p.id === "s1")?.patch as { config: { selection: { keys: { signalName: string }[] } } };
    expect(signals.config.selection.keys[0].signalName).toBe("EngineSpeed");
    // Store 3 — the colormap element's target.
    expect(patches.find((p) => p.id === "cm1")?.patch).toEqual({ signalName: "EngineSpeed" });
    // Store 4 — the host's transmit pool.
    const written = hostCalls.find((c) => c.cmd === "set_transmit_frame");
    expect((written?.args?.frame as { calc: { counter: { signal: string } } }).calc.counter.signal).toBe(
      "EngineSpeed",
    );
    // Store 5 — the project's per-signal colour override.
    expect(colors).toEqual([
      { key: NEW_KEY, color: "#123456" },
      { key: OLD_KEY, color: null },
    ]);
  });

  it("records the chosen database for the target and drops the old name's choice", async () => {
    await remapSignal(stores().stores, REMAP);
    expect(hostCalls.filter((c) => c.cmd === "set_signal_dbc_pick").map((c) => c.args)).toEqual([
      { signal: NEW_KEY, dbcPath: "powertrain.dbc" },
      { signal: OLD_KEY, dbcPath: null },
    ]);
  });

  it("writes nothing to an element that holds no reference to the old signal", async () => {
    const untouched: ProjectElement = {
      kind: "generator",
      id: "g1",
      rules: [{ pattern: "Eng(\d+)", enabled: true }],
    };
    const { stores: s, patches } = stores({ elements: [PLOT, untouched] });
    await remapSignal(s, REMAP);
    expect(patches.map((p) => p.id)).toEqual(["p1"]);
  });

  it("leaves the target's own colour alone when it already has one", async () => {
    const { stores: s, colors } = stores({
      signalColors: { [OLD_KEY]: "#123456", [NEW_KEY]: "#abcdef" },
    });
    await remapSignal(s, REMAP);
    expect(colors).toEqual([]);
  });

  it("is a no-op when the pick names the signal the references already hold", async () => {
    const { stores: s, patches } = stores();
    await remapSignal(s, { ...REMAP, to: REMAP.from });
    expect(patches).toEqual([]);
    expect(hostCalls).toEqual([]);
  });
});

describe("the remap is a rewrite, not an alias", () => {
  // It self-heals rather than remembering: reverting the database
  // reports the difference the other way round through the same
  // surface, and the opposite pick puts the references back exactly as
  // they were. Nothing durable survives to resolve the old name.
  it("round-trips a config when the opposite pick is made", () => {
    const config = {
      areas: [{ id: "a1", signals: [plotSignal("EngSpeed")], primarySignalKey: OLD_KEY }],
    };
    const forward = remapPlotConfig(config, REMAP);
    const back = remapPlotConfig(forward, {
      ...REMAP,
      from: REMAP.to,
      to: REMAP.from,
      messageName: "EngineData_old",
      unit: "1/min",
    });
    expect(back).toEqual(config);
  });
});
