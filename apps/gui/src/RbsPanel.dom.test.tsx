// @vitest-environment jsdom
//
// Component tests for the RBS panel as a thin view over the host's
// rest-of-bus-simulation model (ADR 0028). The Tauri `invoke` bridge
// is mocked, so this asserts the *contract*: the panel renders the
// host-assembled `rbs_view` tree and routes every edit through the
// matching `rbs_*` command — sparse-override semantics, scheduling,
// and file round-trips are covered by the Rust `rbs` unit tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { RbsView } from "./types";

let VIEW: RbsView | null = null;
const calls: Array<{ cmd: string; args: unknown }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "rbs_view":
        return VIEW;
      case "rbs_crc_algorithms":
        return ["CRC-8/SAE-J1850", "CRC-8/AUTOSAR"];
      case "list_value_tables":
        return [
          { raw: 0, label: "Off" },
          { raw: 1, label: "Standby" },
        ];
      default:
        return undefined;
    }
  }),
}));
// Captures registered handlers so tests can deliver `rbs-changed`
// events like the host does.
let eventHandlers: Array<(e: { payload: string }) => void> = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (e: { payload: string }) => void) => {
    eventHandlers.push(handler);
    return () => {};
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

import { RbsPanel } from "./RbsPanel";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import type { ProjectElement } from "./types";
import type { TraceState } from "./trace";

const projectCtx = {
  buses: [
    { id: "p1", name: "Powertrain" },
    { id: "c1", name: "Chassis" },
  ],
  connectedBusIds: ["p1"],
} as unknown as ProjectContextValue;

function makeRegistry(elementId: string, path: string | null, run: boolean) {
  const fakeTrace = {} as TraceState;
  let element: ProjectElement = { kind: "rbs", id: elementId, path, run };
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

function renderPanel(path: string | null, run = false) {
  const { registry, updates } = makeRegistry("el", path, run);
  const api = { updateParameters: vi.fn() };
  const props = { params: { elementId: "el" }, api } as unknown as Parameters<
    typeof RbsPanel
  >[0];
  render(
    <ProjectContext.Provider value={projectCtx}>
      <ElementRegistryContext.Provider value={registry}>
        <RbsPanel {...props} />
      </ElementRegistryContext.Provider>
    </ProjectContext.Provider>,
  );
  return { updates };
}

function lastCall(cmd: string) {
  return [...calls].reverse().find((c) => c.cmd === cmd);
}

/// A representative host view: one resolved bus with one ECU and one
/// message (counter + CRC from the DBC, one overridden signal), plus
/// an unresolved bus rendering inert.
function sampleView(): RbsView {
  return {
    elementId: "el",
    path: "/tmp/sim.cannet_rbs",
    fillBit: 0,
    dirty: true,
    run: false,
    killSwitch: false,
    buses: [
      {
        key: "Powertrain",
        busId: "p1",
        connected: true,
        enabled: true,
        ecus: [
          {
            name: "BMS",
            enabled: true,
            messages: [
              {
                key: "0x123",
                messageId: 0x123,
                extended: false,
                name: "Status",
                inFile: true,
                enabled: true,
                running: false,
                periodMs: 100,
                periodOverridden: false,
                isFd: false,
                expectedLen: 8,
                data: [0x42, 0, 0, 0, 0, 0, 0, 0],
                counter: { signal: "AliveCtr", increment: 1, rollover: 15 },
                counterOverridden: false,
                crc: {
                  signal: "Crc8",
                  algorithm: "CRC-8/SAE-J1850",
                  range_bits: [0, 56],
                },
                crcOverridden: false,
                transmitterMismatch: null,
                signals: [
                  {
                    name: "TargetMode",
                    unit: "",
                    value: 1,
                    label: "Standby",
                    overridden: true,
                    overrideText: "Standby",
                    calcRole: null,
                    factor: 1,
                    offset: 0,
                    min: 0,
                    max: 255,
                    size: 8,
                    signed: false,
                    floatKind: "integer",
                    hasValueTable: true,
                  },
                  {
                    name: "AliveCtr",
                    unit: "",
                    value: 0,
                    label: null,
                    overridden: false,
                    overrideText: null,
                    calcRole: "counter",
                    factor: 1,
                    offset: 0,
                    min: 0,
                    max: 15,
                    size: 4,
                    signed: false,
                    floatKind: "integer",
                    hasValueTable: false,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        key: "Ghost",
        busId: null,
        connected: false,
        enabled: true,
        ecus: [],
      },
    ],
  };
}

beforeEach(() => {
  VIEW = null;
  calls.length = 0;
  eventHandlers = [];
});
afterEach(() => cleanup());

describe("RbsPanel (thin view over the host RBS model)", () => {
  it("renders the host-seeded tree for a pathless element and saves via Save As", async () => {
    // A fresh element needs no file: the host (rbs_init, driven by
    // App) already holds a seeded in-memory config; the panel just
    // views it. Dirty + pathless → Save prompts for the first path.
    VIEW = { ...sampleView(), path: null };
    renderPanel(null);
    expect(await screen.findByText("Powertrain")).toBeInTheDocument();
    expect(screen.getByText("(unsaved)")).toBeInTheDocument();
    const dialog = await import("@tauri-apps/plugin-dialog");
    vi.mocked(dialog.save).mockResolvedValueOnce("/tmp/picked.cannet_rbs");
    fireEvent.click(screen.getByText("Save •"));
    await waitFor(() =>
      expect(lastCall("rbs_save_as")?.args).toMatchObject({
        elementId: "el",
        path: "/tmp/picked.cannet_rbs",
      }),
    );
  });

  it("recovers when the host state lands after mount (launch race)", async () => {
    // On app launch the layout's panel can mount before the project's
    // rbs_load finishes: the first fetch sees nothing. The panel must
    // pick the state up via the post-subscribe fetch / a later
    // rbs-changed — never sit empty.
    VIEW = null;
    renderPanel("/tmp/sim.cannet_rbs");
    await waitFor(() => expect(lastCall("rbs_view")).toBeDefined());
    expect(screen.queryByText("Powertrain")).not.toBeInTheDocument();
    // Host finishes loading and emits rbs-changed.
    VIEW = sampleView();
    for (const h of eventHandlers) h({ payload: "el" });
    expect(await screen.findByText("Powertrain")).toBeInTheDocument();
  });

  it("renders the host tree: bus → ECU → message, with inert unresolved buses", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    expect(await screen.findByText("Powertrain")).toBeInTheDocument();
    expect(screen.getByText("BMS")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("0x123")).toBeInTheDocument();
    // The unresolved bus renders, flagged inert.
    expect(screen.getByText("Ghost")).toBeInTheDocument();
    expect(screen.getByText("unresolved bus")).toBeInTheDocument();
    // The dirty flag shows on Save.
    expect(screen.getByText("Save •")).toBeInTheDocument();
  });

  it("routes enable toggles through rbs_set_enabled at the right level", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    fireEvent.click(await screen.findByLabelText("BMS enabled"));
    await waitFor(() => expect(lastCall("rbs_set_enabled")).toBeDefined());
    expect(lastCall("rbs_set_enabled")?.args).toMatchObject({
      elementId: "el",
      bus: "Powertrain",
      ecu: "BMS",
      message: null,
      enabled: false,
    });
    fireEvent.click(screen.getByLabelText("0x123 enabled"));
    await waitFor(() =>
      expect(lastCall("rbs_set_enabled")?.args).toMatchObject({
        message: "0x123",
        enabled: false,
      }),
    );
  });

  it("commits a signal override through rbs_set_signal and clears with ×", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    // Expand the message to reach the signal grid.
    fireEvent.click(await screen.findByLabelText("toggle 0x123"));
    const input = await screen.findByLabelText("TargetMode value");
    fireEvent.change(input, { target: { value: "403.2" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(lastCall("rbs_set_signal")?.args).toMatchObject({
        elementId: "el",
        target: { bus: "Powertrain", ecu: "BMS", message: "0x123" },
        signal: "TargetMode",
        value: 403.2,
      }),
    );
    // The overridden signal carries a clear control; clearing sends
    // null (back to DBC-tracking).
    fireEvent.click(screen.getByTitle(/clear override.*Standby/));
    await waitFor(() =>
      expect(lastCall("rbs_set_signal")?.args).toMatchObject({
        signal: "TargetMode",
        value: null,
      }),
    );
  });

  it("clears enum cells on focus so the datalist offers every label", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    fireEvent.click(await screen.findByLabelText("toggle 0x123"));
    const input = await screen.findByLabelText("TargetMode value");
    expect(input).toHaveValue("Standby");
    // Focus empties the draft (so the datalist isn't filtered by the
    // committed label) while the placeholder keeps it visible…
    fireEvent.focus(input);
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Standby");
    // …and blurring without typing reverts instead of committing.
    fireEvent.blur(input);
    expect(input).toHaveValue("Standby");
    expect(lastCall("rbs_set_signal")).toBeUndefined();
  });

  it("renders calculated-field destinations read-only", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    fireEvent.click(await screen.findByLabelText("toggle 0x123"));
    // AliveCtr is the counter destination: no input, a (counter) tag.
    expect(screen.queryByLabelText("AliveCtr value")).not.toBeInTheDocument();
    expect(screen.getByText("(counter)")).toBeInTheDocument();
  });

  it("pushes the Run flag through the element model (project-persisted)", async () => {
    VIEW = sampleView();
    const { updates } = renderPanel("/tmp/sim.cannet_rbs");
    fireEvent.click(await screen.findByLabelText("run simulation"));
    expect(updates).toContainEqual({ kind: "rbs", run: true });
  });

  it("opens the calc-field editor and applies through rbs_set_calc", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    fireEvent.click(await screen.findByText("fields…"));
    expect(await screen.findByText(/Calculated fields — Status/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(lastCall("rbs_set_calc")).toBeDefined());
    expect(lastCall("rbs_set_calc")?.args).toMatchObject({
      elementId: "el",
      target: { bus: "Powertrain", ecu: "BMS", message: "0x123" },
    });
  });
});
