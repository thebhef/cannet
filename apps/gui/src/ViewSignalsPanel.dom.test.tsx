// @vitest-environment jsdom
//
// Component tests for the view-signals panel (task 89): a thin view
// over `list_view_signals` — status, serving database, used-by and
// candidates all come from the mocked host; this exercises the panel's
// fetch/refetch wiring, the toolbar filters (nothing-selected-is-no-
// filter), the row-wash toggle, and that sorting goes through the host
// rather than being computed in JS.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ViewSignalRow } from "./types";

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
    candidates: [{ dbcPath: "powertrain.dbc", signalName: "CoolantTempF", messageName: "Chassis", unit: "degF" }],
  }),
];

let ROWS: ViewSignalRow[] = DEFAULT_ROWS;
let ATTENTION_COUNT = 2;
const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "list_view_signals") {
      return { rows: ROWS, attentionCount: ATTENTION_COUNT, total: ROWS.length };
    }
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
import { ProjectContext, type ProjectContextValue } from "./projectContext";

const projectCtx = {
  buses: [
    { id: "power", name: "Powertrain" },
    { id: "body", name: "Body" },
  ],
} as unknown as ProjectContextValue;

function renderPanel(params: Record<string, unknown> = {}) {
  const api = { updateParameters: vi.fn() };
  const props = { params, api } as unknown as Parameters<typeof ViewSignalsPanel>[0];
  render(
    <ProjectContext.Provider value={projectCtx}>
      <ViewSignalsPanel {...props} />
    </ProjectContext.Provider>,
  );
  return { api };
}

function lastListCall() {
  return [...calls].reverse().find((c) => c.cmd === "list_view_signals");
}

beforeEach(() => {
  ROWS = DEFAULT_ROWS;
  ATTENTION_COUNT = 2;
  calls.length = 0;
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
    fireEvent.click(screen.getByRole("button", { name: "Bus: all" }));
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

  it("row washes are on by default, and the status column falls back to text when off", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("VehicleSpeed", { selector: ".col-vs-signal" })).toBeInTheDocument());
    // Off by default: no textual status label rendered, only the chip.
    expect(screen.queryByText("Scale")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /row highlights/ }));
    await waitFor(() => expect(screen.getByText("Scale")).toBeInTheDocument());
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
/// bus define the same signal, and load order settles it silently.
const AMBIGUOUS = row({
  id: "power|s:256:PackVolts",
  signalName: "PackVolts",
  status: "ambiguous",
  servingDbc: "/dbc/client.dbc",
  pickedDbc: null,
  candidates: [
    { dbcPath: "/dbc/client.dbc", signalName: "PackVolts", messageName: "PackStatus", unit: "V" },
    { dbcPath: "/dbc/client.dbc", signalName: "Other", messageName: "PackStatus", unit: "A" },
    { dbcPath: "/dbc/private.dbc", signalName: "PackVolts", messageName: "PackStatus", unit: "V" },
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
    // It opens on the database that decodes the signal today.
    expect((sourcePicker() as HTMLSelectElement).value).toBe(
      `/dbc/client.dbc\0PackVolts`,
    );

    fireEvent.change(sourcePicker(), {
      target: { value: `/dbc/private.dbc\0PackVolts` },
    });
    expect(calls.filter((c) => c.cmd === "set_signal_dbc_pick")).toEqual([
      {
        cmd: "set_signal_dbc_pick",
        args: { signal: "power|s:256:PackVolts", dbcPath: "/dbc/private.dbc" },
      },
    ]);
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
      target: { value: `/dbc/private.dbc\0PackVolts` },
    });
    // The picker still shows what the host last said, unchanged.
    expect((sourcePicker() as HTMLSelectElement).value).toBe(
      `/dbc/client.dbc\0PackVolts`,
    );
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
        `/dbc/private.dbc\0PackVolts`,
      ),
    );
  });

  it("offers a remap candidate but does not act on it yet", async () => {
    ROWS = [AMBIGUOUS];
    ATTENTION_COUNT = 1;
    renderPanel();
    await waitFor(() => expect(sourcePicker()).toBeEnabled());
    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    const byValue = (v: string) => options.find((o) => o.value === v);
    expect(byValue(`/dbc/private.dbc\0PackVolts`)).toBeEnabled();
    // Another signal of the same message is the remap case, not a
    // database choice.
    expect(byValue(`/dbc/client.dbc\0Other`)).toBeDisabled();
  });

  it("has nothing to offer on a row with no candidates", async () => {
    ROWS = [row({ id: "x", status: "not-decoded", servingDbc: null, candidates: [] })];
    ATTENTION_COUNT = 1;
    renderPanel();
    await waitFor(() => expect(sourcePicker()).toBeDisabled());
    expect(calls.some((c) => c.cmd === "set_signal_dbc_pick")).toBe(false);
  });
});
