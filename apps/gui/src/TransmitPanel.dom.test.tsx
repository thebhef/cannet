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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  comboboxOptionLabels,
  openCombobox,
  pickCombobox,
} from "./comboboxTestKit";
import {
  maxDataBytesForKind,
  zeroDataHex,
  resizeDataHexPreserving,
} from "./transmitFrameConfig";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { makeLiveRegistry } from "./registryTestKit";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import type { ProjectElement } from "./types";
import type { TraceState } from "./trace";
import { SignalCatalogProvider } from "./signalCatalogContext";
import {
  LONG_MESSAGE_NAME,
  LONG_MESSAGE_TAIL,
  LONG_SIGNAL_NAME,
  LONG_SIGNAL_TAIL,
  expectMiddleEllipsis,
} from "./longNameTestKit";

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

  it("'Frame' creates a host message and adds it to the group", async () => {
    POOL = [];
    const { updates } = renderPanel("el", []);
    await screen.findByText('No frames yet. Click "Frame" to add one.');
    fireEvent.click(screen.getByRole("button", { name: "Add Frame" }));
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

  it("clicking a signal name in the disclosed face does not collapse the row", async () => {
    // The same rule the trace views now keep: what a row disclosed is
    // not part of the row's toggle. The signal name is a plain span, so
    // before this it read as a click on the tile's background and shut
    // the face the user was reading.
    POOL = [frame("a")];
    DESCRIBE = twoSignalDescriptor();
    renderPanel("el", ["a"]);
    fireEvent.click(await screen.findByTitle("expand"));
    const name = await screen.findByTitle("AliveCtr");
    fireEvent.click(name);
    expect(document.querySelector(".tx-expanded")).toBeInTheDocument();
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
    // The editor opens on the DBC's designation — the section is on
    // and populated before anything is typed …
    const toggle = (await screen.findByLabelText("counter configured")) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect((screen.getByLabelText("counter signal") as HTMLInputElement).value).toBe("AliveCtr");
    // … and editing it makes an override, which rides through
    // set_transmit_frame as `frame.calc`.
    fireEvent.change(screen.getByLabelText("counter increment"), { target: { value: "2" } });
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => {
      const call = lastCall("set_transmit_frame");
      expect(call).toBeDefined();
      const frameArg = (call?.args as { frame?: { calc?: unknown } }).frame;
      expect(frameArg?.calc).toMatchObject({
        counter: { signal: "AliveCtr", increment: 2 },
      });
    });
  });

  // One enum signal with a two-row VAL_ table, expanded and ready to
  // edit — the fixture the enum-cell cases below share.
  async function renderEnumRow() {
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
    return await screen.findByLabelText("Mode value (enum)");
  }

  it("an enum signal fetches its VAL_ table and commits the picked label's raw", async () => {
    const picker = await renderEnumRow();
    // The host's VAL_ table (not the decoded value — decode_frame
    // returns null here) is what the picked label resolves through.
    await pickCombobox(picker, "On");
    await waitFor(() => {
      const args = lastCall("encode_frame")?.args as {
        signals?: { name: string; physical: number }[];
      };
      expect(args?.signals).toEqual([{ name: "Mode", physical: 1 }]);
    });
    // One click, one encode — no second send when focus later leaves.
    expect(calls.filter((c) => c.cmd === "encode_frame")).toHaveLength(1);
  });

  it("the row's bus scopes every DBC lookup the panel makes", async () => {
    // Bus assignment governs decode, so the panel's describe / decode /
    // encode queries resolve through the databases assigned to the bus
    // the row transmits on — the same set that decodes the frame once
    // it is on the wire.
    const picker = await renderEnumRow();
    await pickCombobox(picker, "On");
    await waitFor(() => expect(lastCall("encode_frame")).toBeDefined());
    for (const cmd of [
      "describe_message",
      "decode_frame",
      "encode_frame",
      "list_value_tables",
    ]) {
      const args = lastCall(cmd)?.args as { busId?: string | null };
      expect(args?.busId, cmd).toBe("b1");
    }
  });

  it("renders one line per enum option: `label (raw)`", async () => {
    const picker = await renderEnumRow();
    openCombobox(picker);
    await waitFor(() => expect(comboboxOptionLabels()).toEqual(["Off (0)", "On (1)"]));
  });

  it("reopening the picker after a selection still lists every label", async () => {
    const picker = await renderEnumRow();
    await pickCombobox(picker, "On");
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(comboboxOptionLabels()).toEqual(["Off (0)", "On (1)"]);
  });

  it("takes a raw value outside the VAL_ table as free text", async () => {
    const picker = await renderEnumRow();
    openCombobox(picker);
    const filter = screen.getByLabelText("Mode value (enum) filter");
    fireEvent.change(filter, { target: { value: "3" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    await waitFor(() => {
      const args = lastCall("encode_frame")?.args as {
        signals?: { name: string; physical: number }[];
      };
      expect(args?.signals).toEqual([{ name: "Mode", physical: 3 }]);
    });
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

// ADR 0045: the transmit panel is a receiving end for concrete
// signals — it builds one frame per distinct message — and rejects a
// pattern payload outright, because a rule names no message set.
describe("TransmitPanel as a drop target", () => {
  const MIME = "application/x-cannet-plot-signal";
  const SIGNALS_MIME = "application/x-cannet-drag-signals";
  const PATTERNS_MIME = "application/x-cannet-drag-patterns";

  function transfer(types: string[], payload: unknown) {
    return {
      types,
      getData: (t: string) => (t === MIME ? JSON.stringify(payload) : ""),
      dropEffect: "",
    };
  }
  const sig = (signalName: string, messageId: number) => ({
    busId: "b1",
    messageId,
    extended: false,
    signalName,
    messageName: "EngineData",
    unit: "",
  });
  const panel = () => document.querySelector(".tx-panel") as HTMLElement;
  const framesCreated = () => calls.filter((c) => c.cmd === "set_transmit_frame").length;

  it("makes one frame for a whole message's signals, and none for a repeat", async () => {
    renderPanel("el-tx-drop", []);
    const dt = transfer([MIME, SIGNALS_MIME], {
      signals: [sig("EngineSpeed", 256), sig("EngineTemp", 256), sig("Brake", 257)],
      patterns: [],
    });
    fireEvent.dragOver(panel(), { dataTransfer: dt });
    fireEvent.drop(panel(), { dataTransfer: dt });
    // Two distinct messages in the payload ⇒ two frames, however many
    // of their signals came along.
    await waitFor(() => expect(framesCreated()).toBe(2));
  });

  it("refuses a pattern-only payload during dragover, and drops nothing", async () => {
    renderPanel("el-tx-pattern", []);
    const dt = transfer([MIME, PATTERNS_MIME], { signals: [], patterns: ["^Bus1/"] });
    // `fireEvent` returns false when a handler called preventDefault —
    // accepting the drop. Refusing it is what shows the "no drop"
    // cursor, which is the only feedback `dragover` can give.
    expect(fireEvent.dragOver(panel(), { dataTransfer: dt })).toBe(true);
    fireEvent.drop(panel(), { dataTransfer: dt });
    await new Promise((r) => setTimeout(r, 0));
    expect(framesCreated()).toBe(0);
  });
});

/// The transmit panel on the shared gridview (ADR 0044). The tests above
/// remain the panel's contract net; these cover only what the migration
/// added — the cursor over the tiles, Space as the panel's primary
/// action, and expansion keyed by frame id.
describe("TransmitPanel on the gridview", () => {
  const tiles = () => Array.from(document.querySelectorAll(".tx-frame-row"));
  const signalRows = () => Array.from(document.querySelectorAll(".tx-signal-row"));
  const list = () => document.querySelector(".tx-panel-list") as HTMLElement;

  it("moves the cursor over the frame tiles and carries the selection with it", async () => {
    POOL = [frame("a"), frame("b")];
    renderPanel("el", ["a", "b"]);
    await waitFor(() => expect(tiles()).toHaveLength(2));
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(tiles()[0]).toHaveAttribute("data-active");
    expect(tiles()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(tiles()[1]).toHaveAttribute("data-active");
    expect(tiles()[0]).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(list(), { key: "End" });
    expect(tiles()[1]).toHaveAttribute("data-active");
  });

  it("Space sends the cursor's frame once", async () => {
    POOL = [frame("a"), frame("b")];
    renderPanel("el", ["a", "b"]);
    await waitFor(() => expect(tiles()).toHaveLength(2));
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: " " });
    await waitFor(() =>
      expect(lastCall("transmit_frame_once")?.args).toMatchObject({ id: "b" }),
    );
  });

  it("Space starts and stops a periodic row instead of sending it", async () => {
    // One idiom, two row kinds: the primary action of a periodic row is
    // its schedule, so Space toggles it — never a one-off send, which
    // would be a second answer to what the key does.
    POOL = [frame("a", { mode: "periodic", running: false })];
    renderPanel("el", ["a"]);
    await waitFor(() => expect(tiles()).toHaveLength(1));
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: " " });
    await waitFor(() =>
      expect(lastCall("start_periodic_transmit")?.args).toMatchObject({ id: "a" }),
    );
    expect(lastCall("transmit_frame_once")).toBeUndefined();
  });

  it("Space stops a periodic row that is already running", async () => {
    POOL = [frame("a", { mode: "periodic", running: true })];
    renderPanel("el", ["a"]);
    await waitFor(() => expect(tiles()).toHaveLength(1));
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: " " });
    await waitFor(() =>
      expect(lastCall("stop_periodic_transmit")?.args).toMatchObject({ id: "a" }),
    );
    expect(lastCall("start_periodic_transmit")).toBeUndefined();
  });

  it("leaves the start button live on an unconnected bus, and the send button locked", async () => {
    // The two controls answer the same question Space does, so they
    // answer it the same way: starting a periodic is a state change and
    // is always allowed, sending is an act that needs somewhere to go.
    POOL = [
      frame("m", { request: { ...frame("m").request, busId: "b2" } }),
      frame("p", { mode: "periodic", request: { ...frame("p").request, busId: "b2" } }),
    ];
    renderPanel("el", ["m", "p"]);
    await waitFor(() => expect(tiles()).toHaveLength(2));
    expect(screen.getByText("send")).toBeDisabled();
    const start = screen.getByText("start");
    expect(start).not.toBeDisabled();
    fireEvent.click(start);
    await waitFor(() =>
      expect(lastCall("start_periodic_transmit")?.args).toMatchObject({ id: "p" }),
    );
  });

  it("Space is not guarded on a connection: the send is a silent no-op, the toggle still lands", async () => {
    // With no bus connected there is nowhere to send, so a manual row's
    // Space does nothing and queues nothing. A periodic row's Space
    // still changes its state — the scheduler simply emits no frames
    // until a route exists (ADR 0039).
    POOL = [
      frame("a", { request: { ...frame("a").request, busId: "b2" } }),
      frame("p", { mode: "periodic", request: { ...frame("p").request, busId: "b2" } }),
    ];
    renderPanel("el", ["a", "p"]);
    await waitFor(() => expect(tiles()).toHaveLength(2));
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: " " });
    expect(lastCall("transmit_frame_once")).toBeUndefined();

    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: " " });
    await waitFor(() =>
      expect(lastCall("start_periodic_transmit")?.args).toMatchObject({ id: "p" }),
    );
  });

  it("Right discloses a tile's expanded face, and its signals are rows of the space", async () => {
    POOL = [frame("a")];
    DESCRIBE = twoSignalDescriptor();
    renderPanel("el", ["a"]);
    await waitFor(() => expect(tiles()).toHaveLength(1));
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: "ArrowRight" });
    expect(document.querySelector(".tx-expanded")).toBeInTheDocument();
    // The DBC signals table is a *list*, so each line is a row of the
    // space the cursor reaches (ADR 0044) — the frame-shape and
    // calculated-field strips beside it are not, and stay Tab's.
    await waitFor(() => expect(signalRows()).toHaveLength(2));
    fireEvent.keyDown(list(), { key: "ArrowRight" });
    expect(signalRows()[0]).toHaveAttribute("data-active");
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(signalRows()[1]).toHaveAttribute("data-active");
    // Left walks out of a signal onto the tile that disclosed it.
    fireEvent.keyDown(list(), { key: "ArrowLeft" });
    expect(tiles()[0]).toHaveAttribute("data-active");
    fireEvent.keyDown(list(), { key: "ArrowLeft" });
    expect(document.querySelector(".tx-expanded")).not.toBeInTheDocument();
    expect(signalRows()).toHaveLength(0);
  });

  it("Tab from a signal row lands in that signal's own value cell", async () => {
    POOL = [frame("a")];
    DESCRIBE = twoSignalDescriptor();
    renderPanel("el", ["a"]);
    await waitFor(() => expect(tiles()).toHaveLength(1));
    list().focus();
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: "ArrowRight" });
    await waitFor(() => expect(signalRows()).toHaveLength(2));
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(signalRows()[1]).toHaveAttribute("data-active");
    fireEvent.keyDown(list(), { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByLabelText("RollCtr value"));
  });

  it("marks its list as a tree, with the tiles and their signals as its items", async () => {
    // The container and its rows carry real ARIA roles, so
    // `aria-activedescendant` names something an assistive technology
    // can report (ADR 0044).
    POOL = [frame("a")];
    DESCRIBE = twoSignalDescriptor();
    renderPanel("el", ["a"]);
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(list()).toHaveAttribute("role", "tree");
    expect(tiles()[0]).toHaveAttribute("role", "treeitem");
    fireEvent.click(await screen.findByTitle("expand"));
    await waitFor(() => expect(signalRows()).toHaveLength(2));
    for (const r of signalRows()) expect(r).toHaveAttribute("role", "treeitem");
  });

  it("a click on the tile's background both moves the cursor and toggles the face; a click on a control only moves the cursor", async () => {
    POOL = [frame("a"), frame("b")];
    renderPanel("el", ["a", "b"]);
    await waitFor(() => expect(tiles()).toHaveLength(2));
    // The description input is a control — the cursor follows, the face
    // stays shut so the user isn't yanked around while editing.
    fireEvent.click(screen.getAllByLabelText("frame description")[1]);
    expect(tiles()[1]).toHaveAttribute("data-active");
    expect(tiles()[1].querySelector(".tx-expanded")).not.toBeInTheDocument();
    // The tile's own background is the disclosure.
    fireEvent.click(tiles()[1].querySelector(".tx-frame-body") as HTMLElement);
    expect(tiles()[1].querySelector(".tx-expanded")).toBeInTheDocument();
  });

  it("takes the keyboard when a tile is clicked, and leaves it to a control", async () => {
    // Without this the list never holds focus in a mouse-then-keyboard
    // session: focus stays on `<body>`, where the arrows and Tab are
    // dead until the user happens to click the container's border.
    POOL = [frame("a")];
    renderPanel("el", ["a"]);
    await waitFor(() => expect(tiles()).toHaveLength(1));
    fireEvent.click(tiles()[0].querySelector(".tx-frame-body") as HTMLElement);
    expect(document.activeElement).toBe(list());
    const description = screen.getAllByLabelText("frame description")[0];
    description.focus();
    fireEvent.click(description);
    expect(document.activeElement).toBe(description);
  });

  it("marks its list as a gridview so the global dispatcher stays off its keys", async () => {
    POOL = [frame("a")];
    renderPanel("el", ["a"]);
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(list()).toHaveAttribute("data-gridview");
  });
});

describe("TransmitPanel rehydration", () => {
  it("repaints from an externally rewritten element — it reads the registry live", async () => {
    // The transmit element carries no view `config` to resync: the
    // group it renders is the element's `frameIds`, read every render.
    POOL = [frame("a"), frame("b")];
    const { Provider, control } = makeLiveRegistry([
      { kind: "transmit", id: "el", sinks: [], frameIds: ["a"] } as ProjectElement,
    ]);
    const api = { updateParameters: vi.fn() };
    const props = { params: { elementId: "el" }, api } as unknown as Parameters<
      typeof TransmitPanel
    >[0];
    render(
      <ProjectContext.Provider value={projectCtx}>
        <SignalCatalogProvider>
          <Provider>
            <TransmitPanel {...props} />
          </Provider>
        </SignalCatalogProvider>
      </ProjectContext.Provider>,
    );
    await waitFor(() => expect(screen.getAllByLabelText("frame description")).toHaveLength(1));
    await act(async () => {
      control.update("el", { frameIds: ["a", "b"] } as never);
    });
    expect(screen.getAllByLabelText("frame description")).toHaveLength(2);
  });
});

describe("view-signals push", () => {
  it("pushes nothing for a frame with no calculated-field spec", async () => {
    POOL = [frame("a")];
    renderPanel("el", ["a"]);
    await waitFor(() =>
      expect(lastCall("set_view_signals")?.args).toEqual(
        expect.objectContaining({ viewId: "el", signals: [] }),
      ),
    );
  });

  it("pushes a frame's counter and CRC signals, identity only", async () => {
    POOL = [
      frame("a", {
        request: { busId: "b1", id: 0x110, extended: false, kind: "classic", data: [0], brs: false, esi: false, dlc: 0 },
        calc: {
          counter: { signal: "Counter", increment: 1 },
          crc: { signal: "Crc", range_bits: [0, 8] },
        },
      }),
    ];
    renderPanel("el", ["a"]);
    await waitFor(() =>
      expect(lastCall("set_view_signals")?.args).toEqual(
        expect.objectContaining({
          viewId: "el",
          signals: [
            { busId: "b1", messageId: 0x110, extended: false, signalName: "Counter" },
            { busId: "b1", messageId: 0x110, extended: false, signalName: "Crc" },
          ],
        }),
      ),
    );
  });

  it("un-pushes on unmount", async () => {
    POOL = [frame("a")];
    renderPanel("el", ["a"]);
    await waitFor(() => expect(lastCall("set_view_signals")).toBeDefined());
    cleanup();
    expect(lastCall("remove_view_signals")?.args).toEqual({ viewId: "el" });
  });
});

describe("TransmitPanel with long names", () => {
  it("splits the message name on the row and the signal names in the table", async () => {
    POOL = [frame("a")];
    SIGNALS = [
      {
        bus_id: "b1",
        message_id: 0x100,
        extended: false,
        message_name: LONG_MESSAGE_NAME,
        signal_name: LONG_SIGNAL_NAME,
        unit: "degC",
      } as unknown as SignalDescriptorRecord,
    ];
    const d = twoSignalDescriptor();
    DESCRIBE = {
      ...d,
      name: LONG_MESSAGE_NAME,
      signals: [{ ...d.signals[0], name: LONG_SIGNAL_NAME }, d.signals[1]],
    };
    renderPanel("el", ["a"]);
    // The collapsed row resolves the DBC message name from the catalog.
    const dbcName = await screen.findByTitle("DBC message name");
    expectMiddleEllipsis(dbcName, LONG_MESSAGE_NAME, LONG_MESSAGE_TAIL);

    fireEvent.click(await screen.findByTitle("expand"));
    await screen.findByText("RollCtr");
    const names = document.querySelectorAll(".tx-signal-row .tx-col-name");
    expectMiddleEllipsis(names[0], LONG_SIGNAL_NAME, LONG_SIGNAL_TAIL);
    // The control: the second signal keeps its short name as one node.
    expect(names[1].querySelector(".name-text")).toBeNull();
    expect(names[1].textContent).toBe("RollCtr");
  });
});
