// @vitest-environment jsdom
//
// Wiring test for the color-map config panel (ADR 0029): picking a
// target signal patches the element's target fields, and — when the
// signal has a DBC value table — seeds one color rule per enum value.
// The resolver + rule-seeding maths are unit-tested in colorMap.test.ts;
// this guards the panel→registry/host plumbing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { openCombobox } from "./comboboxTestKit";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "list_signals") {
      return [
        {
          bus_id: "b1",
          message_id: 0x100,
          extended: false,
          message_name: "GearBox",
          signal_name: "Gear",
          unit: "",
          is_enum: true,
        },
        {
          bus_id: "b1",
          message_id: 0x100,
          extended: false,
          message_name: "GearBox",
          signal_name: "Counter",
          unit: "count",
          is_enum: false,
        },
      ];
    }
    if (cmd === "list_value_tables") {
      // A single-member table (SNA sentinel) for Counter — labels stay
      // available, but the signal is not an enum.
      if (args?.signalName === "Counter") return [{ raw: 65535, label: "SNA" }];
      return [
        { raw: 0, label: "Park" },
        { raw: 1, label: "Reverse" },
        { raw: 2, label: "Drive" },
      ];
    }
    return [];
  }),
}));
// The signal catalog provider listens for `dbc-changed`; give it a
// resolved unsubscriber (this suite doesn't fire the event).
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { invoke } from "@tauri-apps/api/core";
import { ColorMapPanel } from "./ColorMapPanel";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import { freshTrace } from "./trace";
import type { ProjectElement } from "./types";
import { SignalCatalogProvider } from "./signalCatalogContext";
import { makeLiveRegistry } from "./registryTestKit";

const projectCtx = {
  buses: [{ id: "b1", name: "Chassis" }],
} as unknown as ProjectContextValue;

function renderPanel(over: Partial<Extract<ProjectElement, { kind: "colormap" }>> = {}) {
  const element: ProjectElement = {
    kind: "colormap",
    id: "cm1",
    busId: null,
    messageId: 0,
    extended: false,
    signalName: "",
    rules: [],
    ...over,
  };
  const map = new Map<string, RegistryEntry>([["cm1", { element, trace: freshTrace(0) }]]);
  const update = vi.fn();
  const registry = {
    get entries() {
      return [...map.values()];
    },
    get: (id: string) => map.get(id),
    create: () => "",
    ensure: () => {},
    updateTrace: () => {},
    update,
    remove: () => {},
  } as unknown as ElementRegistry;

  const props = { params: { elementId: "cm1" } } as unknown as Parameters<typeof ColorMapPanel>[0];
  render(
    <ProjectContext.Provider value={projectCtx}>
      <SignalCatalogProvider>
        <ElementRegistryContext.Provider value={registry}>
          <ColorMapPanel {...props} />
        </ElementRegistryContext.Provider>
      </SignalCatalogProvider>
    </ProjectContext.Provider>,
  );
  return { update };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("ColorMapPanel", () => {
  it("lists DBC signals and, on pick, patches the target + seeds enum rules", async () => {
    const { update } = renderPanel();

    // The catalog loads from list_signals → with the picker open, the
    // signal appears as an option under its bus → message ancestry.
    openCombobox(screen.getByRole("combobox"));
    const option = await waitFor(() => {
      const el = document.querySelector('[role="option"][data-value="b1|256|s|Gear"]');
      if (!el) throw new Error("option not yet rendered");
      return el as HTMLElement;
    });
    expect(option.textContent).toBe("Gear");
    const headers = Array.from(document.querySelectorAll(".combobox-group")).map(
      (h) => h.textContent,
    );
    expect(headers).toContain("Chassis");
    expect(headers).toContain("GearBox");

    fireEvent.click(option);

    // Picking the signal patches the target fields…
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("cm1", {
        busId: "b1",
        messageId: 0x100,
        extended: false,
        signalName: "Gear",
      }),
    );
    // …and seeds one rule per enum value (degenerate [v, v] ranges).
    await waitFor(() => {
      const seeded = update.mock.calls.find((c) => c[1] && Array.isArray(c[1].rules));
      expect(seeded).toBeTruthy();
      const rules = seeded![1].rules as { min: number; max: number; color: string }[];
      expect(rules.map((r) => [r.min, r.max])).toEqual([
        [0, 0],
        [1, 1],
        [2, 2],
      ]);
      expect(rules.every((r) => /^#[0-9a-fA-F]{6}$/.test(r.color))).toBe(true);
    });
  });

  it("renders one row per enum value — its name + a color picker", async () => {
    renderPanel({
      busId: "b1",
      messageId: 0x100,
      extended: false,
      signalName: "Gear",
      rules: [
        { min: 0, max: 0, color: "#111111" },
        { min: 1, max: 1, color: "#222222" },
        { min: 2, max: 2, color: "#333333" },
      ],
    });

    // The value table loads → one row per enum name (no min/max boxes).
    await waitFor(() => expect(document.body.textContent).toContain("Park"));
    expect(document.body.textContent).toContain("Reverse");
    expect(document.body.textContent).toContain("Drive");

    const colors = document.querySelectorAll('input[type="color"]');
    expect(colors.length).toBe(3);
    // Each picker shows that value's stored color.
    expect((colors[0] as HTMLInputElement).value).toBe("#111111");
    expect((colors[2] as HTMLInputElement).value).toBe("#333333");
    // The sparse enum editor has no numeric range inputs.
    expect(document.querySelectorAll('input[type="number"]').length).toBe(0);
  });

  it("a single-member value table is not an enum — the numeric range editor renders", async () => {
    renderPanel({
      busId: "b1",
      messageId: 0x100,
      extended: false,
      signalName: "Counter",
      rules: [],
    });

    // The one-row (SNA) table must not switch the panel into the
    // sparse enum editor: the numeric range empty-state shows instead.
    await waitFor(() =>
      expect(document.body.textContent).toContain("No ranges yet"),
    );
    expect(document.body.textContent).not.toContain("SNA");
  });
});

describe("ColorMapPanel rehydration", () => {
  it("repaints from an externally rewritten element — it reads the registry live", async () => {
    // A colormap panel keeps no mirrored copy of its element, so it
    // needs no resync path of its own: the rules it renders are the
    // registry's, every render.
    const { Provider, control } = makeLiveRegistry([
      {
        kind: "colormap",
        id: "cm1",
        busId: "b1",
        messageId: 0x100,
        extended: false,
        signalName: "Gear",
        rules: [
          { min: 0, max: 0, color: "#111111" },
          { min: 1, max: 1, color: "#222222" },
          { min: 2, max: 2, color: "#333333" },
        ],
      } as ProjectElement,
    ]);
    const props = { params: { elementId: "cm1" } } as unknown as Parameters<
      typeof ColorMapPanel
    >[0];
    render(
      <ProjectContext.Provider value={projectCtx}>
        <SignalCatalogProvider>
          <Provider>
            <ColorMapPanel {...props} />
          </Provider>
        </SignalCatalogProvider>
      </ProjectContext.Provider>,
    );
    await waitFor(() =>
      expect((document.querySelectorAll('input[type="color"]')[0] as HTMLInputElement).value).toBe(
        "#111111",
      ),
    );
    act(() => {
      control.update("cm1", {
        rules: [
          { min: 0, max: 0, color: "#aabbcc" },
          { min: 1, max: 1, color: "#222222" },
          { min: 2, max: 2, color: "#333333" },
        ],
      } as never);
    });
    expect((document.querySelectorAll('input[type="color"]')[0] as HTMLInputElement).value).toBe(
      "#aabbcc",
    );
  });
});

describe("view-signals push", () => {
  it("pushes nothing before a target is picked, and its target once one is", () => {
    renderPanel({ signalName: "PackCurrent", messageId: 0x2a0, busId: "b1" });
    expect(invoke).toHaveBeenCalledWith(
      "set_view_signals",
      expect.objectContaining({
        viewId: "cm1",
        signals: [{ busId: "b1", messageId: 0x2a0, extended: false, signalName: "PackCurrent" }],
      }),
    );
  });

  it("pushes no signals for an element with no target yet", () => {
    renderPanel();
    expect(invoke).toHaveBeenCalledWith(
      "set_view_signals",
      expect.objectContaining({ viewId: "cm1", signals: [] }),
    );
  });

  it("un-pushes on unmount", () => {
    renderPanel({ signalName: "PackCurrent" });
    cleanup();
    expect(invoke).toHaveBeenCalledWith("remove_view_signals", { viewId: "cm1" });
  });
});
