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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
import {
  comboboxOptionLabels,
  openCombobox,
  pickCombobox,
} from "./comboboxTestKit";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { makeLiveRegistry } from "./registryTestKit";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import type { ProjectElement } from "./types";
import type { TraceState } from "./trace";
import { PanelCommandsContext, createPanelCommandRegistry } from "./panelCommands";

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
                    name: "PackVoltage",
                    unit: "V",
                    value: 400,
                    label: null,
                    overridden: false,
                    overrideText: null,
                    calcRole: null,
                    factor: 0.1,
                    offset: 0,
                    min: 0,
                    max: 500,
                    size: 16,
                    signed: false,
                    floatKind: "integer",
                    hasValueTable: false,
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

  it("commits a picked label through rbs_set_signal and clears with ×", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    // Expand the message to reach the signal grid.
    fireEvent.click(await screen.findByLabelText("toggle 0x123"));
    await pickCombobox(await screen.findByLabelText("TargetMode value"), "Off");
    await waitFor(() =>
      expect(lastCall("rbs_set_signal")?.args).toMatchObject({
        elementId: "el",
        target: { bus: "Powertrain", ecu: "BMS", message: "0x123" },
        signal: "TargetMode",
        value: "Off",
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

  it("renders one line per enum option: `label (raw)`", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    fireEvent.click(await screen.findByLabelText("toggle 0x123"));
    const picker = await screen.findByLabelText("TargetMode value");
    openCombobox(picker);
    await waitFor(() =>
      expect(comboboxOptionLabels()).toEqual(["Off (0)", "Standby (1)"]),
    );
  });

  it("picks a label in one click and does not send it twice", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    fireEvent.click(await screen.findByLabelText("toggle 0x123"));
    await pickCombobox(await screen.findByLabelText("TargetMode value"), "Off");
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "rbs_set_signal")).toHaveLength(1),
    );
    expect(lastCall("rbs_set_signal")?.args).toMatchObject({ value: "Off" });
  });

  it("reopening the picker after a selection still lists every label", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    fireEvent.click(await screen.findByLabelText("toggle 0x123"));
    const picker = await screen.findByLabelText("TargetMode value");
    await pickCombobox(picker, "Off");
    // The picker collapsed on the pick. Arrowing it open again must
    // not filter the list down to the value just committed.
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(comboboxOptionLabels()).toEqual(["Off (0)", "Standby (1)"]);
  });

  it("takes a raw value outside the VAL_ table as free text", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    fireEvent.click(await screen.findByLabelText("toggle 0x123"));
    const picker = await screen.findByLabelText("TargetMode value");
    openCombobox(picker);
    // Fault injection: a code the DBC never named still has to be
    // sendable, so the typed text is offered as a row of its own.
    const filter = screen.getByLabelText("TargetMode value filter");
    fireEvent.change(filter, { target: { value: "127" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    await waitFor(() =>
      expect(lastCall("rbs_set_signal")?.args).toMatchObject({
        signal: "TargetMode",
        value: 127,
      }),
    );
  });

  it("keeps the Enter/blur commit for a numeric signal cell", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    fireEvent.click(await screen.findByLabelText("toggle 0x123"));
    const input = await screen.findByLabelText("PackVoltage value");
    fireEvent.change(input, { target: { value: "403.2" } });
    expect(lastCall("rbs_set_signal")).toBeUndefined();
    fireEvent.blur(input);
    await waitFor(() =>
      expect(lastCall("rbs_set_signal")?.args).toMatchObject({
        signal: "PackVoltage",
        value: 403.2,
      }),
    );
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

  // The signal right-click menu (configure as counter/CRC) shares the
  // dismiss-on-outside-click + Escape hook with the other floating
  // menus — previously this menu closed on *any* click (including
  // Escape doing nothing at all).
  it("opens the signal context menu on right-click and dismisses on Escape", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    fireEvent.click(await screen.findByLabelText("toggle 0x123"));
    fireEvent.contextMenu(await screen.findByText("AliveCtr"));
    expect(await screen.findByText("Configure as sequence counter…")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByText("Configure as sequence counter…")).not.toBeInTheDocument(),
    );
  });

  it("dismisses the signal context menu on an outside click, and an inside click doesn't leak through", async () => {
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    fireEvent.click(await screen.findByLabelText("toggle 0x123"));
    fireEvent.contextMenu(await screen.findByText("AliveCtr"));
    const item = await screen.findByText("Configure as sequence counter…");
    // A mousedown on the menu's own item must not dismiss it before
    // the click that actually activates it lands.
    fireEvent.mouseDown(item);
    expect(screen.getByText("Configure as sequence counter…")).toBeInTheDocument();
    fireEvent.click(item);
    await waitFor(() => expect(screen.getByText(/Calculated fields — Status/)).toBeInTheDocument());
  });
});

describe("RbsPanel gridview keys", () => {
  it("Escape in a row's content hands the keyboard back to the tree", async () => {
    // The reference case for the shared layer's way out of a row: Tab
    // reaches a row's controls, and Escape returns to the tree with the
    // arrows live again.
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    const tree = await screen.findByRole("tree");
    const check = await screen.findByLabelText("0x123 enabled");
    check.focus();
    expect(document.activeElement).toBe(check);
    fireEvent.keyDown(check, { key: "Escape" });
    expect(document.activeElement).toBe(tree);
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(tree.getAttribute("aria-activedescendant")).not.toBeNull();
  });

  it("leaves Escape to a signal cell's picker while its dropdown is open", async () => {
    // Content keeps first claim: the combobox closes its own dropdown
    // and keeps focus on the cell, so the press never becomes the
    // tree's.
    VIEW = sampleView();
    renderPanel("/tmp/sim.cannet_rbs");
    const tree = await screen.findByRole("tree");
    fireEvent.click(await screen.findByLabelText("toggle 0x123"));
    const picker = await screen.findByLabelText("TargetMode value");
    openCombobox(picker);
    const filter = await screen.findByLabelText("TargetMode value filter");
    fireEvent.keyDown(filter, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByLabelText("TargetMode value filter")).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(picker);
    expect(document.activeElement).not.toBe(tree);
  });
});

describe("RbsPanel command registration (panel.find)", () => {
  function renderWithCommands() {
    const { registry } = makeRegistry("el", "/tmp/sim.cannet_rbs", false);
    const commands = createPanelCommandRegistry();
    const api = { updateParameters: vi.fn() };
    const props = { params: { elementId: "el" }, api } as unknown as Parameters<
      typeof RbsPanel
    >[0];
    render(
      <ProjectContext.Provider value={projectCtx}>
        <ElementRegistryContext.Provider value={registry}>
          <PanelCommandsContext.Provider value={commands}>
            <RbsPanel {...props} />
          </PanelCommandsContext.Provider>
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>,
    );
    return commands;
  }

  it("focuses and selects the filter box", async () => {
    VIEW = sampleView();
    const commands = renderWithCommands();
    const filterBox = (await screen.findByLabelText("filter")) as HTMLInputElement;
    fireEvent.change(filterBox, { target: { value: "AliveCtr" } });
    expect(document.activeElement).not.toBe(filterBox);
    act(() => {
      commands.invoke("el", "panel.find");
    });
    expect(document.activeElement).toBe(filterBox);
    expect(filterBox.selectionStart).toBe(0);
    expect(filterBox.selectionEnd).toBe(filterBox.value.length);
  });
});

describe("RbsPanel rehydration", () => {
  it("repaints from an externally rewritten element — it reads the registry live", async () => {
    // The RBS element carries no view `config` to resync: what the
    // panel shows of it (the file it references) is read every render.
    const { Provider, control } = makeLiveRegistry([
      { kind: "rbs", id: "el", path: null, run: false } as ProjectElement,
    ]);
    const api = { updateParameters: vi.fn() };
    const props = { params: { elementId: "el" }, api } as unknown as Parameters<typeof RbsPanel>[0];
    render(
      <ProjectContext.Provider value={projectCtx}>
        <Provider>
          <RbsPanel {...props} />
        </Provider>
      </ProjectContext.Provider>,
    );
    await waitFor(() => expect(document.querySelector(".rbs-path")).toHaveTextContent("(unsaved)"));
    await act(async () => {
      control.update("el", { kind: "rbs", path: "/tmp/sim.cannet_rbs" } as never);
    });
    expect(document.querySelector(".rbs-path")).toHaveTextContent("sim.cannet_rbs");
  });
});
