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

import type { TransmitFrameRecord } from "./types";

// The host pool the mocked `list_transmit_frames` returns. Tests mutate
// this before rendering; `set_transmit_frame` etc. just record calls.
let POOL: TransmitFrameRecord[] = [];
// What `describe_message` returns — `null` by default (no DBC match);
// a test can set a descriptor to exercise the DBC-derived kind/brs path.
let DESCRIBE: unknown = null;
const calls: Array<{ cmd: string; args: unknown }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "list_transmit_frames":
        return POOL;
      case "list_signals":
        return [];
      case "describe_message":
        return DESCRIBE;
      case "decode_frame":
        return null;
      default:
        return undefined;
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  TransmitPanel,
  maxDataBytesForKind,
  zeroDataHex,
  resizeDataHexPreserving,
} from "./TransmitPanel";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import type { ProjectElement } from "./types";
import type { TraceState } from "./trace";

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
      <ElementRegistryContext.Provider value={registry}>
        <TransmitPanel {...props} />
      </ElementRegistryContext.Provider>
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
  calls.length = 0;
});
afterEach(() => cleanup());

describe("TransmitPanel (thin view over host registry)", () => {
  it("renders only the messages in the element's frameIds group, in order", async () => {
    POOL = [frame("a"), frame("b"), frame("c")];
    renderPanel("el", ["c", "a"]); // group excludes "b", and reorders
    // Two rows (c, a); "b" is not in this panel's group.
    await waitFor(() =>
      expect(screen.getAllByLabelText("frame description")).toHaveLength(2),
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
});

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
