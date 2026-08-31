// @vitest-environment jsdom
//
// Component tests for the view-signals panel: a thin view
// over `list_view_signals` — status, serving database, used-by and
// candidates all come from the mocked host; this exercises the panel's
// fetch/refetch wiring, the toolbar filters (nothing-selected-is-no-
// filter), the row-wash toggle, and that sorting goes through the host
// rather than being computed in JS.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ViewSignalCandidate, ViewSignalRef, ViewSignalRow } from "./types";
import { PanelEditRecorderContext } from "./panelEditRecorder";
import type { PanelEditStep } from "./panelEditHistory";

import {
  LONG_MESSAGE_NAME,
  LONG_MESSAGE_TAIL,
  LONG_SIGNAL_NAME,
  LONG_SIGNAL_TAIL,
  expectMiddleEllipsis,
} from "./longNameTestKit";

/// One candidate on the fixture's own bus — the ordinary case, where a
/// choice is only ever about which database or which signal.
function cand(
  dbcPath: string,
  signalName: string,
  messageName: string,
  unit: string,
  busId = "power",
  busName = "Powertrain",
): ViewSignalCandidate {
  return { busId, busName, dbcPath, signalName, messageName, unit };
}

function row(over: Partial<ViewSignalRow> = {}): ViewSignalRow {
  return {
    id: "id",
    status: "decoded",
    busId: "power",
    busName: "Powertrain",
    messageId: 0x100,
    extended: false,
    messageName: "Chassis",
    signalName: "VehicleSpeed",
    unit: "km/h",
    servingDbc: "powertrain.dbc",
    pickedDbc: null,
    usedBy: ["Plot 1"],
    candidates: [],
    diffs: [],
    ...over,
  };
}

const DEFAULT_ROWS: ViewSignalRow[] = [
  row({ id: "a", signalName: "VehicleSpeed", status: "decoded", busId: "power", busName: "Powertrain" }),
  row({
    id: "b",
    signalName: "AmbientTemp",
    messageName: "Climate",
    status: "not-decoded",
    servingDbc: null,
    busId: "body",
    busName: "Body",
    usedBy: ["Plot 2"],
    candidates: [],
  }),
  row({
    id: "c",
    signalName: "CoolantTemp",
    status: "scale",
    busId: "power",
    busName: "Powertrain",
    unit: "degF",
    usedBy: ["Plot 1"],
    diffs: [{ field: "unit", mapped: "degC", decoded: "degF" }],
    candidates: [cand("powertrain.dbc", "CoolantTempF", "Chassis", "degF")],
  }),
];

let ROWS: ViewSignalRow[] = DEFAULT_ROWS;
let ATTENTION_COUNT = 2;
/// The host's transmit pool, as `list_transmit_frames` answers it — the
/// one store the remap operation reaches through a command rather than
/// through the element registry.
let POOL: unknown[] = [];
const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];

/// A stand-in for the host's `ViewSignalRegistry`: the pushes the views
/// make, held in app state and read back whole on every list. Null for
/// every test that just wants fixed `ROWS`; a test that cares about
/// *when* a push happened relative to the panel sets it to a map and
/// gets a host that remembers.
let REGISTRY: Map<string, { viewName: string; signals: ViewSignalRefWire[] }> | null = null;
interface ViewSignalRefWire {
  busId: string | null;
  messageId: number;
  extended: boolean;
  signalName: string;
  messageName?: string;
  unit?: string;
}
/// The rows `REGISTRY` implies. Only the plumbing is under test here,
/// so every reference resolves to a Decoded row — the taxonomy itself
/// is `view_signals.rs`'s own tests.
function registryRows(): ViewSignalRow[] {
  const out: ViewSignalRow[] = [];
  for (const view of REGISTRY?.values() ?? []) {
    for (const s of view.signals) {
      out.push(
        row({
          id: `${s.busId}|${s.messageId}:${s.signalName}`,
          busId: s.busId,
          busName: s.busId === "power" ? "Powertrain" : "Body",
          messageId: s.messageId,
          extended: s.extended,
          signalName: s.signalName,
          messageName: s.messageName ?? "",
          unit: s.unit ?? "",
          usedBy: [view.viewName],
        }),
      );
    }
  }
  return out;
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "list_view_signals") {
      if (REGISTRY) {
        const rows = registryRows();
        return { rows, attentionCount: 0, total: rows.length };
      }
      return { rows: ROWS, attentionCount: ATTENTION_COUNT, total: ROWS.length };
    }
    if (cmd === "set_view_signals" && REGISTRY) {
      REGISTRY.set(args?.viewId as string, {
        viewName: args?.viewName as string,
        signals: args?.signals as ViewSignalRefWire[],
      });
      emitHostEvent("view-signals-changed");
      return undefined;
    }
    if (cmd === "remove_view_signals" && REGISTRY) {
      REGISTRY.delete(args?.viewId as string);
      emitHostEvent("view-signals-changed");
      return undefined;
    }
    if (cmd === "list_transmit_frames") return POOL;
    return undefined;
  }),
}));
const mockListeners = new Map<string, Set<() => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    const set = mockListeners.get(event) ?? new Set();
    set.add(handler);
    mockListeners.set(event, set);
    return () => set.delete(handler);
  }),
}));
function emitHostEvent(event: string) {
  for (const h of mockListeners.get(event) ?? []) h();
}

import { ViewSignalsPanel } from "./ViewSignalsPanel";
import { usePushViewSignals } from "./viewSignalsPush";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { makeLiveRegistry } from "./registryTestKit";
import type { ProjectElement } from "./types";

const setSignalColor = vi.fn();
const projectCtx = {
  buses: [
    { id: "power", name: "Powertrain" },
    { id: "body", name: "Body" },
  ],
  signalColors: {},
  onSetSignalColor: setSignalColor,
} as unknown as ProjectContextValue;

/// The panel's remap pick writes through the element registry, so it
/// renders under a real one (`registryTestKit`) — the same state and
/// `applyElementPatch` bookkeeping the app uses, so a write is
/// observable exactly as a mounted view would see it.
function renderPanel(params: Record<string, unknown> = {}, elements: ProjectElement[] = []) {
  const api = { updateParameters: vi.fn() };
  const props = { params, api } as unknown as Parameters<typeof ViewSignalsPanel>[0];
  const { Provider, control } = makeLiveRegistry(elements);
  const recorded: PanelEditStep[] = [];
  render(
    <ProjectContext.Provider value={projectCtx}>
      <Provider>
        <PanelEditRecorderContext.Provider value={(s) => recorded.push(s)}>
          <ViewSignalsPanel {...props} />
        </PanelEditRecorderContext.Provider>
      </Provider>
    </ProjectContext.Provider>,
  );
  return { api, registry: control, recorded };
}

function lastListCall() {
  return [...calls].reverse().find((c) => c.cmd === "list_view_signals");
}

beforeEach(() => {
  ROWS = DEFAULT_ROWS;
  ATTENTION_COUNT = 2;
  REGISTRY = null;
  POOL = [];
  calls.length = 0;
  setSignalColor.mockClear();
  mockListeners.clear();
});
afterEach(() => cleanup());

describe("ViewSignalsPanel", () => {
  it("fetches on mount, sorted by bus by default, and renders every row", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("VehicleSpeed", { selector: ".col-vs-signal" })).toBeInTheDocument());
    expect(screen.getByText("AmbientTemp")).toBeInTheDocument();
    expect(screen.getByText("CoolantTemp")).toBeInTheDocument();
    expect(lastListCall()?.args).toEqual(
      expect.objectContaining({
        sortKey: "bus",
        sortDir: "asc",
        busNames: [
          ["power", "Powertrain"],
          ["body", "Body"],
        ],
      }),
    );
  });

  it("shows the attention count when no filter is active, and the shown count once one is", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "2 of 3 need attention" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Scale \(1\)/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "1 of 3 shown" })).toBeInTheDocument(),
    );
  });

  it("clicking the counts readout toggles the attention-status filter", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("VehicleSpeed", { selector: ".col-vs-signal" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "2 of 3 need attention" }));
    // Not Decoded + Scale + Ambiguous only — VehicleSpeed (Decoded) drops out.
    await waitFor(() => expect(screen.queryByText("VehicleSpeed", { selector: ".col-vs-signal" })).not.toBeInTheDocument());
    expect(screen.getByText("AmbientTemp")).toBeInTheDocument();
    expect(screen.getByText("CoolantTemp")).toBeInTheDocument();
    // Clicking again clears it.
    fireEvent.click(screen.getByRole("button", { name: "2 of 3 shown" }));
    await waitFor(() => expect(screen.getByText("VehicleSpeed", { selector: ".col-vs-signal" })).toBeInTheDocument());
  });

  it("status filter: nothing selected is no filter, one selected is just that status", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("VehicleSpeed", { selector: ".col-vs-signal" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Not Decoded \(1\)/ }));
    await waitFor(() => expect(screen.queryByText("VehicleSpeed", { selector: ".col-vs-signal" })).not.toBeInTheDocument());
    expect(screen.getByText("AmbientTemp")).toBeInTheDocument();
    expect(screen.queryByText("CoolantTemp")).not.toBeInTheDocument();
  });

  it("status filter: several selected is their union", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("VehicleSpeed", { selector: ".col-vs-signal" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Not Decoded \(1\)/ }));
    fireEvent.click(screen.getByRole("button", { name: /Scale \(1\)/ }));
    await waitFor(() => {
      expect(screen.getByText("AmbientTemp")).toBeInTheDocument();
      expect(screen.getByText("CoolantTemp")).toBeInTheDocument();
    });
    expect(screen.queryByText("VehicleSpeed", { selector: ".col-vs-signal" })).not.toBeInTheDocument();
  });

  it("bus fly-out filters by bus, ANDed with the status filter", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("VehicleSpeed", { selector: ".col-vs-signal" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Bus: All" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Body/ }));
    await waitFor(() => expect(screen.queryByText("VehicleSpeed", { selector: ".col-vs-signal" })).not.toBeInTheDocument());
    expect(screen.getByText("AmbientTemp")).toBeInTheDocument();
    expect(screen.queryByText("CoolantTemp")).not.toBeInTheDocument();
  });

  it("clicking a sortable header re-fetches sorted by that column", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("VehicleSpeed", { selector: ".col-vs-signal" })).toBeInTheDocument());
    fireEvent.click(screen.getByText("signal"));
    await waitFor(() =>
      expect(lastListCall()?.args).toEqual(
        expect.objectContaining({ sortKey: "signal", sortDir: "asc" }),
      ),
    );
  });

  it("clicking the unsortable detail header does not change the sort", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("VehicleSpeed", { selector: ".col-vs-signal" })).toBeInTheDocument());
    const before = lastListCall()?.args;
    fireEvent.click(screen.getByText("detail"));
    // No new fetch fired for a no-op sort click.
    expect(lastListCall()?.args).toEqual(before);
  });

  it("paints no row background, and says a row's status with the chip alone", async () => {
    // Row background belongs to the gridview — cursor and selection are
    // what paint a row (ADR 0044). A panel says per-row state in a
    // *cell*: the swatch-wide status column carries the chip, whose
    // words are its tooltip and accessible name, never column text the
    // 40px column would truncate.
    renderPanel();
    await waitFor(() => expect(screen.getByText("VehicleSpeed", { selector: ".col-vs-signal" })).toBeInTheDocument());
    const chip = screen.getByRole("img", { name: "Scale" });
    expect(chip).toHaveAttribute("title", "Scale");
    expect(chip.closest(".col-vs-status")).toHaveTextContent("");
    expect(screen.queryByRole("button", { name: "Row Highlights" })).toBeNull();
    for (const el of document.querySelectorAll(".view-signals-row")) {
      expect(el.className).not.toMatch(/wash/);
    }
  });

  it("refetches on view-signals-changed", async () => {
    renderPanel();
    await waitFor(() => expect(calls.filter((c) => c.cmd === "list_view_signals")).toHaveLength(1));
    emitHostEvent("view-signals-changed");
    await waitFor(() => expect(calls.filter((c) => c.cmd === "list_view_signals")).toHaveLength(2));
  });

  it("shows the diff detail for a Scale row: mapped as / decoded by", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("CoolantTemp")).toBeInTheDocument());
    expect(screen.getByText("Mapped as:")).toBeInTheDocument();
    expect(screen.getByText("degC")).toBeInTheDocument();
    expect(screen.getByText("Decoded by:")).toBeInTheDocument();
    expect(screen.getByText("degF")).toBeInTheDocument();
  });

  it("shows a status-keyed note for Not Decoded, which carries no diffs", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText("No mapped database decodes this field")).toBeInTheDocument(),
    );
  });

  it("summarizes total signals and bus count in the footer", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText("3 signals across 2 buses")).toBeInTheDocument(),
    );
  });

  it("says nothing has been referenced yet when the model is empty", async () => {
    ROWS = [];
    ATTENTION_COUNT = 0;
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText("No open view references a signal yet.")).toBeInTheDocument(),
    );
  });
});

/// The ambiguous row the source picker exists for: two databases on one
/// bus define the same signal, and load order settles it silently. The
/// host offers exactly the signal under each definer — which database
/// is the only question (`view_signals::offers`).
const AMBIGUOUS = row({
  id: "power|s:256:PackVolts",
  signalName: "PackVolts",
  status: "ambiguous",
  servingDbc: "/dbc/client.dbc",
  pickedDbc: null,
  candidates: [
    cand("/dbc/client.dbc", "PackVolts", "PackStatus", "V"),
    cand("/dbc/private.dbc", "PackVolts", "PackStatus", "V"),
  ],
});

/// The row the *remap* pick exists for: the database renamed the
/// signal, so nothing decodes the name every view still holds, and the
/// message's own definitions are the candidates to re-point at.
const STALE_NAME = row({
  id: "power|s:256:PackVolts",
  signalName: "PackVolts",
  messageName: "PackStatus",
  status: "not-decoded",
  servingDbc: null,
  pickedDbc: null,
  usedBy: ["Plot 1", "Color map 1"],
  candidates: [
    cand("/dbc/client.dbc", "PackVoltage", "PackStatus", "mV"),
    cand("/dbc/client.dbc", "PackCurrent", "PackStatus", "A"),
  ],
});

/// The row this task exists for: a reference saved before per-bus
/// signal binding. It names no bus, so nothing decodes it, and the only
/// repair on offer is a definition on a bus that does.
const NO_BUS = row({
  id: "*|s:256:PackVolts",
  busId: null,
  busName: null,
  signalName: "PackVolts",
  messageName: "PackStatus",
  status: "not-decoded",
  servingDbc: null,
  pickedDbc: null,
  usedBy: ["Plot 1"],
  candidates: [
    cand("/dbc/client.dbc", "PackVolts", "PackStatus", "V", "power", "Powertrain"),
    cand("/dbc/client.dbc", "PackVolts", "PackStatus", "V", "body", "Body"),
  ],
});

function sourcePicker() {
  return screen.getByRole("combobox");
}

describe("ViewSignalsPanel source picker", () => {
  it("records the chosen database against the row's signal identity", async () => {
    ROWS = [AMBIGUOUS];
    ATTENTION_COUNT = 1;
    renderPanel();
    await waitFor(() => expect(sourcePicker()).toBeEnabled());
    // It opens unresolved: load order is a default, not a choice, so
    // no offer reads as chosen — the placeholder names the winner.
    expect((sourcePicker() as HTMLSelectElement).value).toBe("");
    expect(
      screen.getByRole("option", { name: "— load order: client.dbc —" }),
    ).toBeDisabled();

    fireEvent.change(sourcePicker(), {
      target: { value: `power\0/dbc/private.dbc\0PackVolts` },
    });
    expect(calls.filter((c) => c.cmd === "set_signal_dbc_pick")).toEqual([
      {
        cmd: "set_signal_dbc_pick",
        args: { signal: "power|s:256:PackVolts", dbcPath: "/dbc/private.dbc" },
      },
    ]);
  });

  it("records a pick of the load-order winner itself — the default is confirmable", async () => {
    ROWS = [AMBIGUOUS];
    ATTENTION_COUNT = 1;
    renderPanel();
    await waitFor(() => expect(sourcePicker()).toBeEnabled());
    fireEvent.change(sourcePicker(), {
      target: { value: `power\0/dbc/client.dbc\0PackVolts` },
    });
    expect(calls.filter((c) => c.cmd === "set_signal_dbc_pick")).toEqual([
      {
        cmd: "set_signal_dbc_pick",
        args: { signal: "power|s:256:PackVolts", dbcPath: "/dbc/client.dbc" },
      },
    ]);
  });

  it("records the pick as an undo step whose inverse is the pick in force (task 129)", async () => {
    // A first pick's inverse is null — undoing it returns the row to
    // unresolved, not to an explicit pick of the old winner.
    ROWS = [AMBIGUOUS];
    ATTENTION_COUNT = 1;
    const { recorded } = renderPanel();
    await waitFor(() => expect(sourcePicker()).toBeEnabled());
    fireEvent.change(sourcePicker(), {
      target: { value: `power\0/dbc/private.dbc\0PackVolts` },
    });
    expect(recorded).toEqual([
      {
        undo: [{ kind: "pick", signal: "power|s:256:PackVolts", dbcPath: null }],
        redo: [
          { kind: "pick", signal: "power|s:256:PackVolts", dbcPath: "/dbc/private.dbc" },
        ],
      },
    ]);

    // Re-picking over an existing pick keeps that pick as the inverse.
    ROWS = [row({ ...AMBIGUOUS, status: "decoded", pickedDbc: "/dbc/private.dbc", servingDbc: "/dbc/private.dbc" })];
    emitHostEvent("dbc-changed");
    await waitFor(() =>
      expect((sourcePicker() as HTMLSelectElement).value).toBe(
        `power\0/dbc/private.dbc\0PackVolts`,
      ),
    );
    fireEvent.change(sourcePicker(), {
      target: { value: `power\0/dbc/client.dbc\0PackVolts` },
    });
    expect(recorded[1]).toEqual({
      undo: [
        { kind: "pick", signal: "power|s:256:PackVolts", dbcPath: "/dbc/private.dbc" },
      ],
      redo: [
        { kind: "pick", signal: "power|s:256:PackVolts", dbcPath: "/dbc/client.dbc" },
      ],
    });
  });

  it("records no step for a pick on a row nothing decodes — there is no inverse to keep", async () => {
    ROWS = [STALE_NAME];
    ATTENTION_COUNT = 1;
    const { recorded } = renderPanel();
    await waitFor(() => expect(sourcePicker()).toBeEnabled());
    // A same-name candidate on an undecoded row would be the ambiguity
    // pick with no serving database behind it; the write still goes,
    // unrecorded. (STALE_NAME's candidates rename, so drive onPick's
    // guard directly through a same-name fixture.)
    ROWS = [row({ ...STALE_NAME, candidates: [cand("/dbc/client.dbc", "PackVolts", "PackStatus", "V")] })];
    emitHostEvent("view-signals-changed");
    await waitFor(() =>
      expect((sourcePicker() as HTMLSelectElement).options.length).toBeGreaterThan(0),
    );
    fireEvent.change(sourcePicker(), {
      target: { value: `power\0/dbc/client.dbc\0PackVolts` },
    });
    expect(recorded).toEqual([]);
    expect(calls.filter((c) => c.cmd === "set_signal_dbc_pick")).toHaveLength(1);
  });

  it("brings the row back through the host rather than holding the pick locally", async () => {
    // No apply step and no optimistic local state: the host records the
    // choice and announces it as a DBC change, which is what refetches.
    ROWS = [AMBIGUOUS];
    ATTENTION_COUNT = 1;
    renderPanel();
    await waitFor(() => expect(sourcePicker()).toBeEnabled());
    const before = calls.filter((c) => c.cmd === "list_view_signals").length;

    fireEvent.change(sourcePicker(), {
      target: { value: `power\0/dbc/private.dbc\0PackVolts` },
    });
    // The picker still shows what the host last said — unresolved.
    expect((sourcePicker() as HTMLSelectElement).value).toBe("");
    expect(calls.filter((c) => c.cmd === "list_view_signals")).toHaveLength(before);

    ROWS = [
      row({
        ...AMBIGUOUS,
        status: "decoded",
        servingDbc: "/dbc/private.dbc",
        pickedDbc: "/dbc/private.dbc",
      }),
    ];
    emitHostEvent("dbc-changed");
    await waitFor(() =>
      expect((sourcePicker() as HTMLSelectElement).value).toBe(
        `power\0/dbc/private.dbc\0PackVolts`,
      ),
    );
  });

  it("offers remap candidates on a row nothing decodes", async () => {
    // Only such a row gets the message's signal list — its repair is a
    // re-point (`view_signals::offers`). Every offer is live.
    ROWS = [STALE_NAME];
    ATTENTION_COUNT = 1;
    renderPanel();
    await waitFor(() => expect(sourcePicker()).toBeEnabled());
    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    const byValue = (v: string) => options.find((o) => o.value === v);
    expect(byValue(`power\0/dbc/client.dbc\0PackVoltage`)).toBeEnabled();
    expect(byValue(`power\0/dbc/client.dbc\0PackCurrent`)).toBeEnabled();
  });

  /// The guarantee the shared operation exists for, at the gesture that
  /// invokes it: **one** pick, and every view that referenced the old
  /// name moves — here a plot and a colormap, two different stores,
  /// neither of which the panel knows anything about.
  it("a remap pick reaches every view's stored reference from one gesture", async () => {
    ROWS = [STALE_NAME];
    ATTENTION_COUNT = 1;
    const { registry } = renderPanel({}, [
      {
        kind: "plot",
        id: "p1",
        sources: ["*"],
        config: {
          areas: [
            {
              id: "a1",
              signals: [
                {
                  busId: "power",
                  messageId: 0x100,
                  extended: false,
                  signalName: "PackVolts",
                  messageName: "PackStatus",
                  unit: "V",
                },
              ],
            },
          ],
        },
      },
      {
        kind: "colormap",
        id: "cm1",
        busId: "power",
        messageId: 0x100,
        extended: false,
        signalName: "PackVolts",
        rules: [],
      },
    ]);
    await waitFor(() => expect(sourcePicker()).toBeEnabled());

    fireEvent.change(sourcePicker(), { target: { value: `power\0/dbc/client.dbc\0PackVoltage` } });

    await waitFor(() => {
      const plot = registry.entries().find((e) => e.element.id === "p1")?.element as unknown as {
        config: { areas: { signals: { signalName: string; unit: string }[] }[] };
      };
      expect(plot.config.areas[0].signals[0]).toMatchObject({
        signalName: "PackVoltage",
        messageName: "PackStatus",
        unit: "mV",
      });
      const colormap = registry.entries().find((e) => e.element.id === "cm1")
        ?.element as unknown as { signalName: string };
      expect(colormap.signalName).toBe("PackVoltage");
    });
    // …and it is a rewrite, not an alias: nothing durable is recorded
    // that maps the old name onto the new one.
    expect(
      calls.filter((c) => c.cmd === "set_signal_dbc_pick").map((c) => c.args),
    ).toEqual([
      { signal: "power|s:256:PackVoltage", dbcPath: "/dbc/client.dbc" },
      { signal: "power|s:256:PackVolts", dbcPath: null },
    ]);
  });

  it("rewrites the transmit pool's calculated-field target in the same gesture", async () => {
    ROWS = [STALE_NAME];
    ATTENTION_COUNT = 1;
    POOL = [
      {
        id: "f1",
        description: "",
        request: {
          busId: "power",
          id: 0x100,
          extended: false,
          kind: "classic",
          data: [0, 0],
          brs: false,
          dlc: 8,
        },
        cycleMs: 100,
        mode: "manual",
        running: false,
        calc: { counter: { signal: "PackVolts", increment: 1 } },
      },
    ];
    renderPanel();
    await waitFor(() => expect(sourcePicker()).toBeEnabled());

    fireEvent.change(sourcePicker(), { target: { value: `power\0/dbc/client.dbc\0PackVoltage` } });

    await waitFor(() => {
      const written = calls.find((c) => c.cmd === "set_transmit_frame");
      expect(
        (written?.args?.frame as { calc: { counter: { signal: string } } } | undefined)?.calc.counter
          .signal,
      ).toBe("PackVoltage");
    });
  });

  it("offers a reference that names no bus the buses that decode", async () => {
    ROWS = [NO_BUS];
    ATTENTION_COUNT = 1;
    renderPanel();
    await waitFor(() => expect(sourcePicker()).toBeEnabled());
    // Nothing is in force, and the picker says so rather than showing
    // the first offer as if it were.
    expect((sourcePicker() as HTMLSelectElement).value).toBe("");
    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((o) => o.textContent)).toEqual([
      "— not decoded —",
      "Powertrain · client.dbc: PackVolts",
      "Body · client.dbc: PackVolts",
    ]);
  });

  it("re-points every stored reference onto the bus that was chosen", async () => {
    ROWS = [NO_BUS];
    ATTENTION_COUNT = 1;
    const { registry } = renderPanel({}, [
      {
        kind: "plot",
        id: "p1",
        sources: ["*"],
        config: {
          areas: [
            {
              id: "a1",
              signals: [
                {
                  busId: null,
                  messageId: 0x100,
                  extended: false,
                  signalName: "PackVolts",
                  messageName: "PackStatus",
                  unit: "V",
                },
              ],
            },
          ],
        },
      },
    ]);
    await waitFor(() => expect(sourcePicker()).toBeEnabled());

    fireEvent.change(sourcePicker(), {
      target: { value: `power\0/dbc/client.dbc\0PackVolts` },
    });

    await waitFor(() => {
      const plot = registry.entries().find((e) => e.element.id === "p1")?.element as unknown as {
        config: { areas: { signals: { busId: string | null; signalName: string }[] }[] };
      };
      expect(plot.config.areas[0].signals[0]).toMatchObject({
        busId: "power",
        signalName: "PackVolts",
      });
    });
    // A re-point is not an ambiguity pick: it moves the references, and
    // the only thing recorded against the *new* identity is the
    // database the choice named.
    expect(
      calls.filter((c) => c.cmd === "set_signal_dbc_pick").map((c) => c.args),
    ).toEqual([
      { signal: "power|s:256:PackVolts", dbcPath: "/dbc/client.dbc" },
      { signal: "*|s:256:PackVolts", dbcPath: null },
    ]);
  });

  it("has nothing to offer on a row with no candidates", async () => {
    ROWS = [row({ id: "x", status: "not-decoded", servingDbc: null, candidates: [] })];
    ATTENTION_COUNT = 1;
    renderPanel();
    await waitFor(() => expect(sourcePicker()).toBeDisabled());
    expect(calls.some((c) => c.cmd === "set_signal_dbc_pick")).toBe(false);
  });
});

describe("ViewSignalsPanel with long names", () => {
  it("splits the signal and message names, and leaves a short one alone", async () => {
    ROWS = [
      row({ id: "long", signalName: LONG_SIGNAL_NAME, messageName: LONG_MESSAGE_NAME }),
      row({ id: "short", signalName: "VehicleSpeed", messageName: "Chassis" }),
    ];
    renderPanel({ elementId: "el1" });
    await waitFor(() => expect(document.querySelectorAll(".trace-row")).toHaveLength(2));
    const rows = document.querySelectorAll(".trace-row");
    expectMiddleEllipsis(rows[0].querySelector(".col-vs-signal"), LONG_SIGNAL_NAME, LONG_SIGNAL_TAIL);
    expectMiddleEllipsis(rows[0].querySelector(".col-vs-msg"), LONG_MESSAGE_NAME, LONG_MESSAGE_TAIL);
    expect(rows[1].querySelector(".name-text")).toBeNull();
  });
});

// The owner asked whether a view has to have existed when the panel
// was created for its signals to show up. It does not, and this is the
// falsification: the view mounts and pushes while no panel is on
// screen, and the panel — mounted afterwards, against a host that
// simply remembers the push — lists the signal from its own first
// fetch. The registry is app state, not a subscription.
describe("ViewSignalsPanel mounted after the views that push", () => {
  function Probe({ viewId, viewName, refs }: { viewId: string; viewName: string; refs: ViewSignalRef[] }) {
    usePushViewSignals(viewId, viewName, refs);
    return null;
  }

  it("lists a signal pushed before the panel existed", async () => {
    REGISTRY = new Map();
    const refs: ViewSignalRef[] = [
      {
        busId: "power",
        messageId: 0x100,
        extended: false,
        signalName: "PackVolts",
        messageName: "PackStatus",
        unit: "V",
      },
    ];
    // The view mounts first, with nothing listening.
    render(<Probe viewId="v-early" viewName="Plot 1" refs={refs} />);
    await waitFor(() => expect(REGISTRY?.size).toBe(1));
    expect(calls.some((c) => c.cmd === "list_view_signals")).toBe(false);

    // …and the panel, mounted afterwards, sees it.
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText("PackVolts", { selector: ".col-vs-signal" })).toBeInTheDocument(),
    );
    expect(screen.getByText("Plot 1")).toBeInTheDocument();
  });
});
