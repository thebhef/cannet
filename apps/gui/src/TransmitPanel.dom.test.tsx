// @vitest-environment jsdom
//
// Component tests for the transmit panel as a thin view over the
// host-side TX-message registry. The Tauri `invoke`
// bridge is mocked, so this asserts the *contract*: the panel renders
// only the messages named by its element's `frameIds` group and routes
// every user action through the matching host command — it holds no
// frame model state of its own. The registry model itself (ordering,
// same-id/bus coexistence, periodic lifecycle) is covered by the Rust
// `transmit_frames` unit tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { SignalDescriptorRecord, TransmitFrameRecord } from "./types";

// The host pool the mocked `list_transmit_frames` returns. Tests mutate
// this before rendering; `set_transmit_frame` etc. just record calls.
let POOL: TransmitFrameRecord[] = [];
// What `describe_message` returns — `null` by default (no DBC match);
// a test can set a descriptor to exercise the DBC-derived kind/brs path.
let DESCRIBE: unknown = null;
// The `list_signals` catalog. Empty by default (no DBC-name resolution);
// a test can set entries to exercise the collapsed row's DBC-name lookup.
let SIGNALS: SignalDescriptorRecord[] = [];
// The `list_value_tables` result, keyed by signal name — a test can
// populate this to exercise an enum row's fetched datalist/commit path.
const VALUE_TABLES: Record<string, { raw: number; label: string }[]> = {};
const calls: Array<{ cmd: string; args: unknown }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "list_transmit_frames":
        return POOL;
      case "list_signals":
        return SIGNALS;
      case "describe_message":
        return DESCRIBE;
      case "decode_frame":
        return null;
      case "list_value_tables":
        return VALUE_TABLES[(args as { signalName?: string })?.signalName ?? ""] ?? [];
      case "encode_frame":
        return { bytes: [0] };
      default:
        return undefined;
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { listen } from "@tauri-apps/api/event";

import { TransmitPanel } from "./TransmitPanel";
import {
  maxDataBytesForKind,
  zeroDataHex,
  resizeDataHexPreserving,
} from "./transmitFrameConfig";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import type { ProjectElement } from "./types";
import type { TraceState } from "./trace";
import { SignalCatalogProvider } from "./signalCatalogContext";

function frame(
  id: string,
  over: Partial<TransmitFrameRecord> = {},
): TransmitFrameRecord {
  return {
    id,
    description: "",
    request: {
      busId: "b1",
      id: 0x100,
      extended: false,
      kind: "classic",
      data: [0],
      brs: false,
      esi: false,
      dlc: 0,
    },
    cycleMs: 100,
    mode: "manual",
    running: false,
    ...over,
  };
}

// A registry holding one transmit element whose `frameIds` group is the
// argument. Records `update` patches so the test can assert frameIds /
// sinks mutations.
function makeRegistry(elementId: string, frameIds: string[]) {
  const fakeTrace = {} as TraceState;
  let element: ProjectElement = { kind: "transmit", id: elementId, sinks: [], frameIds };
  const updates: Array<Partial<ProjectElement>> = [];
  const registry = {
    get entries() {
      return [{ element, trace: fakeTrace }] as RegistryEntry[];
    },
    get: (id: string) =>
      id === elementId ? ({ element, trace: fakeTrace } as RegistryEntry) : undefined,
    create: () => elementId,
    ensure: () => {},
    updateTrace: () => {},
    update: (id: string, patch: Partial<ProjectElement>) => {
      if (id !== elementId) return;
      updates.push(patch);
      element = { ...element, ...patch } as ProjectElement;
    },
    remove: () => {},
  } as unknown as ElementRegistry;
  return { registry, updates };
}

const projectCtx = {
  buses: [{ id: "b1", name: "Bus 1" }],
  connectedBusIds: ["b1"],
} as unknown as ProjectContextValue;

function renderPanel(elementId: string, frameIds: string[]) {
  const { registry, updates } = makeRegistry(elementId, frameIds);
  const api = { updateParameters: vi.fn() };
  const props = { params: { elementId }, api } as unknown as Parameters<
    typeof TransmitPanel
  >[0];
  render(
    <ProjectContext.Provider value={projectCtx}>
      <SignalCatalogProvider>
        <ElementRegistryContext.Provider value={registry}>
          <TransmitPanel {...props} />
        </ElementRegistryContext.Provider>
      </SignalCatalogProvider>
    </ProjectContext.Provider>,
  );
  return { updates };
}

function lastCall(cmd: string) {
  return [...calls].reverse().find((c) => c.cmd === cmd);
}

beforeEach(() => {
  POOL = [];
  DESCRIBE = null;
  SIGNALS = [];
  for (const k of Object.keys(VALUE_TABLES)) delete VALUE_TABLES[k];
  calls.length = 0;
});
afterEach(() => cleanup());

describe("TransmitPanel (thin view over host registry)", () => {
  it("resolves the collapsed row's DBC message name from the signal catalog", async () => {
    // frame("a")'s request defaults to bus b1, id 0x100, classic,
    // extended false — match it with one catalog entry on that
    // (bus, message, extended) key.
    POOL = [frame("a")];
    SIGNALS = [
      {
        bus_id: "b1",
        message_id: 0x100,
        extended: false,
        message_name: "EngineData",
        transmitter: "EngineEcu",
        signal_name: "EngineSpeed",
        unit: "rpm",
        is_enum: false,
      },
    ];
    renderPanel("el", ["a"]);
    await waitFor(() =>
      expect(screen.getByTitle("DBC message name")).toHaveTextContent("EngineData"),
    );
  });

  it("renders only the messages in the element's frameIds group, in order", async () => {
    POOL = [frame("a"), frame("b"), frame("c")];
    renderPanel("el", ["c", "a"]); // group excludes "b", and reorders
    // Two rows (c, a); "b" is not in this panel's group.
    await waitFor(() =>
      expect(screen.getAllByLabelText("frame description")).toHaveLength(2),
    );
  });

  it("re-fetches the pool once the change-event listener is attached (launch race)", async () => {
    // `listen` is async; a host-side pool change (e.g. project load
    // seeding TX frames) that lands in the gap between the initial
    // snapshot fetch and the listener actually being registered would
    // otherwise be silently missed until the next `transmit-frames-changed`
    // event or the running-poll — neither of which fires here.
    let releaseListen: (() => void) | undefined;
    vi.mocked(listen).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseListen = () => resolve(() => Promise.resolve());
        }),
    );

    POOL = [];
    renderPanel("el", ["f1"]);

    // Let the initial snapshot fetch land (pool still empty at this point).
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "list_transmit_frames")).toHaveLength(1),
    );
    expect(screen.queryAllByLabelText("frame description")).toHaveLength(0);

    // The host publishes a frame in the gap before the listener attaches.
    POOL = [frame("f1", { description: "Gear box" })];

    // Attach completes.
    releaseListen?.();

    // The post-listener refetch must pick up the frame that arrived
    // during the attach gap.
    await waitFor(() =>
      expect(screen.getAllByLabelText("frame description")).toHaveLength(1),
    );
  });

  it("'+ frame' creates a host message and adds it to the group", async () => {
    POOL = [];
    const { updates } = renderPanel("el", []);
    await screen.findByText('No frames yet. Click "+ frame" to add one.');
    fireEvent.click(screen.getByText("+ frame"));
    await waitFor(() => expect(lastCall("set_transmit_frame")).toBeTruthy());
    // The new id is appended to the element's frameIds group.
    await waitFor(() =>
      expect(updates.some((u) => Array.isArray((u as { frameIds?: string[] }).frameIds))).toBe(
        true,
      ),
    );
  });

  it("editing the description writes that message back to the host", async () => {
    POOL = [frame("a")];
    renderPanel("el", ["a"]);
    const desc = await screen.findByLabelText("frame description");
    fireEvent.change(desc, { target: { value: "open contactor" } });
    await waitFor(() => {
      const c = lastCall("set_transmit_frame");
      expect(c).toBeTruthy();
      const args = c!.args as { id: string; frame: { description: string } };
      expect(args.id).toBe("a");
      expect(args.frame.description).toBe("open contactor");
    });
  });

  it("Start on a periodic message calls start_periodic_transmit", async () => {
    POOL = [frame("a", { mode: "periodic", running: false })];
    renderPanel("el", ["a"]);
    const start = await screen.findByText("start");
    fireEvent.click(start);
    await waitFor(() => {
      const c = lastCall("start_periodic_transmit");
      expect(c).toBeTruthy();
      expect((c!.args as { id: string }).id).toBe("a");
    });
  });

  it("period input commits a positive value but reverts an empty one on blur", async () => {
    POOL = [frame("a", { mode: "periodic", running: true, cycleMs: 100 })];
    renderPanel("el", ["a"]);
    const period = await screen.findByLabelText("cycle period (ms)");

    // Clearing the field and blurring must NOT dispatch (no cycle_ms=0
    // reaching the host — that would stop the running periodic).
    fireEvent.change(period, { target: { value: "" } });
    fireEvent.blur(period);
    expect(lastCall("set_transmit_frame")).toBeUndefined();

    // A valid edit commits through set_transmit_frame.
    fireEvent.change(period, { target: { value: "5" } });
    fireEvent.blur(period);
    await waitFor(() => {
      const c = lastCall("set_transmit_frame");
      expect(c).toBeTruthy();
      expect((c!.args as { frame: { cycleMs: number } }).frame.cycleMs).toBe(5);
    });
  });

  it("does not storm set_transmit_frame for a DBC-bound frame (no feedback loop)", async () => {
    // A classic frame whose id binds to a classic DBC message and whose
    // payload already matches the message's declared length: the row's
    // DBC-derived kind/brs/length effect runs but produces no change, so
    // no write should ever be dispatched. Without the no-op guard this
    // round-trips through the host on every render forever.
    POOL = [
      frame("a", {
        request: { ...frame("a").request, kind: "classic", data: [0, 0, 0, 0, 0, 0, 0, 0] },
      }),
    ];
    DESCRIBE = {
      name: "EngineData",
      expectedLen: 8,
      isFd: false,
      brs: false,
      genMsgCycleTimeMs: null,
      usesExtendedMux: false,
      signals: [],
    };
    renderPanel("el", ["a"]);
    await screen.findByLabelText("frame description");
    // Give the descriptor fetch + any follow-up effects time to settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.cmd === "set_transmit_frame")).toHaveLength(0);
  });

  it("re-fits a too-short payload to the DBC message length (so it decodes)", async () => {
    // A frame carrying a 1-byte payload bound to an 8-byte DBC message:
    // the row's descriptor effect grows the payload to 8 zero bytes
    // (preserving the leading byte) so the frame decodes and plots,
    // then settles — exactly one write.
    POOL = [
      frame("a", {
        request: { ...frame("a").request, kind: "classic", data: [0] },
      }),
    ];
    DESCRIBE = {
      name: "EngineData",
      expectedLen: 8,
      isFd: false,
      brs: false,
      genMsgCycleTimeMs: null,
      usesExtendedMux: false,
      signals: [],
    };
    renderPanel("el", ["a"]);
    await screen.findByLabelText("frame description");
    await waitFor(() => {
      const c = lastCall("set_transmit_frame");
      expect(c).toBeTruthy();
      expect((c!.args as { frame: { request: { data: number[] } } }).frame.request.data)
        .toHaveLength(8);
    });
    // The resize is one-shot — the effect must not keep firing.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.cmd === "set_transmit_frame")).toHaveLength(1);
  });

  it("exposes the standard/extended toggle on the row (top level) and flips it", async () => {
    POOL = [frame("a")]; // extended: false by default
    renderPanel("el", ["a"]);
    // The toggle is on the collapsed row — no need to expand.
    const toggle = await screen.findByLabelText(
      "standard id (click to switch to extended)",
    );
    fireEvent.click(toggle);
    await waitFor(() => {
      const c = lastCall("set_transmit_frame");
      expect(c).toBeTruthy();
      expect((c!.args as { frame: { request: { extended: boolean } } }).frame.request.extended)
        .toBe(true);
    });
  });

  it("shows Stop (not Start) when the host reports the periodic running", async () => {
    POOL = [frame("a", { mode: "periodic", running: true })];
    renderPanel("el", ["a"]);
    expect(await screen.findByText("stop")).toBeInTheDocument();
    expect(screen.queryByText("start")).toBeNull();
  });

  it("editing a payload byte cell writes the new payload back to the host", async () => {
    POOL = [frame("a")]; // classic, no DBC match — raw byte editing
    renderPanel("el", ["a"]);
    await screen.findByLabelText("frame description");
    // Each byte cell is a hex `<input>` inside a `title="byte N"` label.
    const input = screen.getByTitle("byte 0").querySelector("input")!;
    fireEvent.change(input, { target: { value: "AB" } });
    fireEvent.blur(input);
    await waitFor(() => {
      const c = lastCall("set_transmit_frame");
      expect(c).toBeTruthy();
      const data = (c!.args as { frame: { request: { data: number[] } } })
        .frame.request.data;
      expect(data[0]).toBe(0xab);
    });
  });

  // The calculated-fields modal is a floating layer hosted inside an
  // expandable row whose background click toggles expansion. Picking a
  // signal in the modal's combobox must not read as a row click:
  // collapsing the row unmounts the modal mid-edit.
  it("picking a counter signal in the calc editor keeps the editor open and applies the pick", async () => {
    POOL = [frame("a")];
    DESCRIBE = twoSignalDescriptor();
    renderPanel("el", ["a"]);
    fireEvent.click(await screen.findByTitle("expand"));
    fireEvent.click(await screen.findByText("fields…"));
    // Turn the counter section on — it defaults to the first signal.
    fireEvent.click(await screen.findByLabelText("counter configured"));
    const trigger = await screen.findByLabelText("counter signal");
    expect(trigger).toHaveTextContent("AliveCtr");

    // Open the combobox and pick the other signal.
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: "RollCtr" }));

    // The editor is still mounted and the pick took effect.
    expect(screen.getByRole("dialog", { name: "Calculated fields" })).toBeInTheDocument();
    expect(screen.getByLabelText("counter signal")).toHaveTextContent("RollCtr");

    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => {
      const call = lastCall("set_transmit_frame");
      const frameArg = (call?.args as { frame?: { calc?: unknown } }).frame;
      expect(frameArg?.calc).toMatchObject({ counter: { signal: "RollCtr" } });
    });
  });

  it("clicking the calc editor's own chrome does not collapse the row under it", async () => {
    POOL = [frame("a")];
    DESCRIBE = twoSignalDescriptor();
    renderPanel("el", ["a"]);
    fireEvent.click(await screen.findByTitle("expand"));
    fireEvent.click(await screen.findByText("fields…"));
    fireEvent.click(await screen.findByText(/^Calculated fields — /));
    expect(screen.getByRole("dialog", { name: "Calculated fields" })).toBeInTheDocument();
  });
});

/// A DBC message with two counter-shaped signals, so the calc editor's
/// destination combobox has something to switch between.
function twoSignalDescriptor() {
  const sig = (name: string) => ({
    name,
    unit: "",
    factor: 1,
    offset: 0,
    min: 0,
    max: 15,
    size: 4,
    signed: false,
    mux: { kind: "plain" },
    floatKind: "integer",
    hasValueTable: false,
    startValueRaw: null,
  });
  return {
    name: "Status",
    expectedLen: 8,
    isFd: false,
    brs: false,
    genMsgCycleTimeMs: 100,
    genMsgSendType: null,
    usesExtendedMux: false,
    calcFields: null,
    signals: [sig("AliveCtr"), sig("RollCtr")],
  };
}

describe("payload sizing helpers", () => {
  it("carries the calc override through set_transmit_frame via the shared editor", async () => {
    POOL = [frame("a")];
    DESCRIBE = {
      name: "Status",
      expectedLen: 8,
      isFd: false,
      brs: false,
      genMsgCycleTimeMs: 100,
      genMsgSendType: null,
      usesExtendedMux: false,
      calcFields: {
        counter: { signal: "AliveCtr", increment: 1, rollover: 15 },
      },
      signals: [
        {
          name: "AliveCtr",
          unit: "",
          factor: 1,
          offset: 0,
          min: 0,
          max: 15,
          size: 4,
          signed: false,
          mux: { kind: "plain" },
          floatKind: "integer",
          hasValueTable: false,
          startValueRaw: null,
        },
      ],
    };
    renderPanel("el", ["a"]);
    // Expand the row to reach the calculated-fields strip.
    const expand = await screen.findByTitle("expand");
    fireEvent.click(expand);
    // The strip shows the DBC default designation.
    expect(await screen.findByText(/counter: AliveCtr/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("fields…"));
    // Turn the counter section on (an override) and Apply — the
    // override rides through set_transmit_frame as `frame.calc`.
    fireEvent.click(await screen.findByLabelText("counter configured"));
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => {
      const call = lastCall("set_transmit_frame");
      expect(call).toBeDefined();
      const frameArg = (call?.args as { frame?: { calc?: unknown } }).frame;
      expect(frameArg?.calc).toMatchObject({
        counter: { signal: "AliveCtr", increment: 1 },
      });
    });
  });

  it("an enum signal fetches its VAL_ table and commits the matched raw on a typed label", async () => {
    POOL = [frame("a")];
    DESCRIBE = {
      name: "Status",
      expectedLen: 8,
      isFd: false,
      brs: false,
      genMsgCycleTimeMs: 100,
      genMsgSendType: null,
      usesExtendedMux: false,
      calcFields: {},
      signals: [
        {
          name: "Mode",
          unit: "",
          factor: 1,
          offset: 0,
          min: 0,
          max: 1,
          size: 1,
          signed: false,
          mux: { kind: "plain" },
          floatKind: "integer",
          hasValueTable: true,
          startValueRaw: null,
        },
      ],
    };
    VALUE_TABLES.Mode = [
      { raw: 0, label: "Off" },
      { raw: 1, label: "On" },
    ];
    renderPanel("el", ["a"]);
    fireEvent.click(await screen.findByTitle("expand"));
    const input = await screen.findByLabelText("Mode value (enum)");
    // Typing a label the host's VAL_ table defines (not the currently
    // decoded one — decode_frame returns null here) resolves through
    // the fetched table to that label's raw value.
    fireEvent.change(input, { target: { value: "On" } });
    fireEvent.blur(input);
    await waitFor(() => {
      const call = lastCall("encode_frame");
      expect(call).toBeDefined();
      const args = call?.args as { signals?: { name: string; physical: number }[] };
      expect(args.signals).toEqual([{ name: "Mode", physical: 1 }]);
    });
  });

  it("an enum signal commits the moment a label is picked, not on blur", async () => {
    POOL = [frame("a")];
    DESCRIBE = {
      name: "Status",
      expectedLen: 8,
      isFd: false,
      brs: false,
      genMsgCycleTimeMs: 100,
      genMsgSendType: null,
      usesExtendedMux: false,
      calcFields: {},
      signals: [
        {
          name: "Mode",
          unit: "",
          factor: 1,
          offset: 0,
          min: 0,
          max: 1,
          size: 1,
          signed: false,
          mux: { kind: "plain" },
          floatKind: "integer",
          hasValueTable: true,
          startValueRaw: null,
        },
      ],
    };
    VALUE_TABLES.Mode = [
      { raw: 0, label: "Off" },
      { raw: 1, label: "On" },
    ];
    renderPanel("el", ["a"]);
    fireEvent.click(await screen.findByTitle("expand"));
    const input = await screen.findByLabelText("Mode value (enum)");
    await waitFor(() =>
      expect(document.querySelector('datalist option[value="On"]')).toBeTruthy(),
    );
    // Picking a datalist suggestion leaves focus where it is, so the
    // commit cannot wait for a blur.
    fireEvent.change(input, { target: { value: "On" } });
    await waitFor(() => {
      const args = lastCall("encode_frame")?.args as {
        signals?: { name: string; physical: number }[];
      };
      expect(args?.signals).toEqual([{ name: "Mode", physical: 1 }]);
    });
    const before = calls.filter((c) => c.cmd === "encode_frame").length;
    fireEvent.blur(input);
    expect(calls.filter((c) => c.cmd === "encode_frame")).toHaveLength(before);
  });

  it("a numeric signal commits the typed physical value through encode_frame", async () => {
    POOL = [frame("a")];
    DESCRIBE = {
      name: "Status",
      expectedLen: 8,
      isFd: false,
      brs: false,
      genMsgCycleTimeMs: 100,
      genMsgSendType: null,
      usesExtendedMux: false,
      calcFields: {},
      signals: [
        {
          name: "Speed",
          unit: "kph",
          factor: 1,
          offset: 0,
          min: 0,
          max: 100,
          size: 8,
          signed: false,
          mux: { kind: "plain" },
          floatKind: "integer",
          hasValueTable: false,
          startValueRaw: null,
        },
      ],
    };
    renderPanel("el", ["a"]);
    fireEvent.click(await screen.findByTitle("expand"));
    const input = await screen.findByLabelText("Speed value");
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.blur(input);
    await waitFor(() => {
      const call = lastCall("encode_frame");
      expect(call).toBeDefined();
      const args = call?.args as { signals?: { name: string; physical: number }[] };
      expect(args.signals).toEqual([{ name: "Speed", physical: 42 }]);
    });
  });

  it("maxDataBytesForKind: 8 classic, 64 FD, 0 remote/error", () => {
    expect(maxDataBytesForKind("classic")).toBe(8);
    expect(maxDataBytesForKind("fd")).toBe(64);
    expect(maxDataBytesForKind("remote")).toBe(0);
    expect(maxDataBytesForKind("error")).toBe(0);
  });

  it("zeroDataHex builds a zero-filled payload of the given length", () => {
    expect(zeroDataHex(0)).toBe("");
    expect(zeroDataHex(8)).toBe("0000000000000000");
  });

  it("resizeDataHexPreserving pads on grow and truncates on shrink, keeping the prefix", () => {
    // Grow: keep "AB", pad to 4 bytes.
    expect(resizeDataHexPreserving("AB", 4)).toBe("AB000000");
    // Shrink: keep the first 2 bytes, drop the rest.
    expect(resizeDataHexPreserving("AABBCCDD", 2)).toBe("AABB");
    // Exact: unchanged.
    expect(resizeDataHexPreserving("AABB", 2)).toBe("AABB");
  });
});
