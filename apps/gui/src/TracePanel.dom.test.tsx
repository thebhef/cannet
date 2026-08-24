// @vitest-environment jsdom
//
// Component test for the trace panel's filter wiring. A trace wired to
// a filter pages its *chronological* rows host-side through
// `fetch_filtered_trace` (with the resolved predicate) — it never
// holds the whole filtered set in memory. The host evaluator and the
// predicate builder are covered by `filter.rs` / `sinkPredicate.test.ts`
// and `lib.rs::filtered_trace_page`; this guards the panel→host wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";

/// What the fake host's `settings.json` holds. The view defaults
/// (`trace_mode`, `trace_auto_scroll`, `trace_show_events`) are read
/// from it when a panel seeds its state, so the defaults tests write
/// here and re-hydrate.
let storedSettings: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "fetch_filtered_trace" || cmd === "fetch_by_id_page") {
      return { count: 0, start: 0, rows: [] };
    }
    if (cmd === "get_settings") return { ...storedSettings };
    // The host anchors each timeline event to a frame index (ADR 0035);
    // anchor everything at the window start so the events do splice in.
    if (cmd === "frame_indices_at_ns") {
      return ((args?.timestamps as number[] | undefined) ?? []).map(() => 0);
    }
    return [];
  }),
}));
// The panel subscribes to the cross-panel "goto" bus at mount; the tests
// don't fire it, but `listen()` must resolve to an unsubscriber.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { TracePanel } from "./TracePanel";
import { NotesContext, type NotesContextValue } from "./notesContext";
import type { Note } from "./notes";
import { TraceDataProvider, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import { freshTrace } from "./trace";
import { makeLiveRegistry } from "./registryTestKit";
import { LIVE_TAIL_ROWS, resetLiveTailDemand } from "./liveTailDemand";
import { PAGE_ROWS } from "./useWindowedQuery";
import { hydrateSettings } from "./hostSettings";
import type { ProjectElement } from "./types";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const traceData: TraceData = {
  count: 100,
  firstIndex: 0,
  truncationTsNs: null,
  sessionStartSeconds: 0,
  epoch: 0,
  fetchRange: async () => [],
  liveTail: { start: 0, rows: [] },
};

const projectCtx = {
  projectPath: null,
  dirty: false,
  dbcPaths: [],
  dbcBuses: {},
  buses: [],
  interfaceBindings: [],
  connectedAddresses: [],
  remoteConnected: false,
  blfPath: null,
  onNewProject: () => {},
  onOpenProject: () => {},
  onSaveProject: () => {},
  onSaveProjectAs: () => {},
  onAddDbc: () => {},
  onRemoveDbc: () => {},
  onReloadDbc: () => {},
  onSetDbcBuses: () => {},
  onAddBus: () => {},
  onRemoveBus: () => {},
  onUpdateBus: () => {},
  onAddBinding: () => {},
  onRemoveBinding: () => {},
  onConnect: () => {},
  onDisconnect: () => {},
} as unknown as ProjectContextValue;

function makeRegistry(elements: ProjectElement[]): ElementRegistry {
  const map = new Map<string, RegistryEntry>();
  for (const element of elements) {
    map.set(element.id, { element, trace: freshTrace(0) });
  }
  return {
    get entries() {
      return [...map.values()];
    },
    get: (id: string) => map.get(id),
    create: () => "",
    ensure: () => {},
    updateTrace: () => {},
    update: (id: string, patch: Partial<ProjectElement>) => {
      const e = map.get(id);
      if (e) map.set(id, { ...e, element: { ...e.element, ...patch } as ProjectElement });
    },
    remove: () => {},
  } as unknown as ElementRegistry;
}

/// `mode === null` omits the key entirely — a panel with no saved view
/// config, which is what makes the configured default observable.
function renderPanel(
  elements: ProjectElement[],
  count = 100,
  mode: string | null = "chronological",
) {
  const api = { updateParameters: vi.fn() };
  const props = {
    params: mode === null ? { elementId: "t1" } : { elementId: "t1", mode },
    api,
  } as unknown as Parameters<typeof TracePanel>[0];
  // One registry instance across re-renders so the trace element (and
  // its window) survive a simulated window growth.
  const registry = makeRegistry(elements);
  const tree = (c: number) => (
    <TraceDataProvider value={{ ...traceData, count: c }}>
      <ProjectContext.Provider value={projectCtx}>
        <ElementRegistryContext.Provider value={registry}>
          <TracePanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>
    </TraceDataProvider>
  );
  const { rerender, container } = render(tree(count));
  return { grow: (c: number) => rerender(tree(c)), container, api, registry };
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  resetLiveTailDemand();
  storedSettings = {};
  await hydrateSettings();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const traceAndFilter: ProjectElement[] = [
  { kind: "trace", id: "t1", sources: ["f1"] } as ProjectElement,
  {
    kind: "filter",
    id: "f1",
    sources: ["*"],
    predicate: { id_list: [256] },
  } as ProjectElement,
];

describe("TracePanel live-tail demand", () => {
  /// What the panel last told the host it wants shipped per `trace-grew`.
  const declaredRows = () => {
    const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "set_live_tail_rows");
    return calls.length === 0 ? null : (calls[calls.length - 1][1] as { rows: number }).rows;
  };

  it("asks for a tail only while an unfiltered chronological view follows live", async () => {
    // The host collected and decoded 256 trailing frames on every
    // `trace-grew` regardless of whether anything read them; only this
    // view does.
    renderPanel([{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement]);
    await waitFor(() => expect(declaredRows()).toBe(LIVE_TAIL_ROWS));
  });

  it("withdraws the demand when the view switches to by-id", async () => {
    const { container } = renderPanel([
      { kind: "trace", id: "t1", sources: ["*"] } as ProjectElement,
    ]);
    await waitFor(() => expect(declaredRows()).toBe(LIVE_TAIL_ROWS));
    const byId = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.replace(/\s+/g, " ").trim() === "by ID",
    )!;
    await act(async () => {
      fireEvent.click(byId);
    });
    expect(declaredRows()).toBe(0);
  });

  it("asks for no tail in by-id mode", async () => {
    renderPanel([{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement], 100, "by-id");
    // Give the mount effects a chance to declare something.
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(declaredRows() ?? 0).toBe(0);
  });

  it("asks for no tail when the trace is filtered", async () => {
    // A filtered chronological view pages through `useFilteredTrace`, which
    // has no live-tail overlay — the raw tail would be the wrong rows.
    renderPanel(traceAndFilter);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(declaredRows() ?? 0).toBe(0);
  });
});

describe("TracePanel chronological filtering", () => {
  it("pages the window through fetch_filtered_trace with the resolved predicate", async () => {
    renderPanel(traceAndFilter);
    // A freshly-started trace follows live, so the panel asks for the
    // tail page (`fromEnd`) and the running total in one call.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("fetch_filtered_trace", {
        filter: { id_list: [256] },
        scanStart: 0,
        scanEnd: 100,
        offset: 0,
        limit: PAGE_ROWS,
        fromEnd: true,
        // The follow-live tail resumes from the incremental checkpoint; on
        // the first fetch under a descriptor it's the freshly-reset empty
        // count at the window start (so the host counts the window once and
        // seeds the cursor, then later ticks resume in O(Δ)).
        prevCount: 0,
        prevCountEnd: 0,
      }),
    );
  });

  it("does not filter-fetch when the trace fans in from every bus", () => {
    // `sources=["*"]` → no predicate → the cheap shared chunk cache is
    // used; the panel itself issues no `fetch_filtered_trace`.
    renderPanel([{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement]);
    expect(invoke).not.toHaveBeenCalledWith("fetch_filtered_trace", expect.anything());
  });

  it("right-clicking a column header opens the column menu, not the sources picker", () => {
    // Regression: the panel opens its sources context-menu on any
    // right-click. The header's own show/hide-columns menu must stop
    // the event from bubbling, or the sources menu renders over it and
    // the column menu can't be used.
    const { container } = renderPanel(
      [{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement],
      100,
      "by-id",
    );
    const header = container.querySelector(".trace-header");
    expect(header).toBeTruthy();
    fireEvent.contextMenu(header!);
    expect(container.querySelector(".column-context-menu")).toBeInTheDocument();
    expect(document.querySelector(".sources-context-menu")).not.toBeInTheDocument();
  });

  it("re-pages the tail as the trace window grows", async () => {
    const { grow } = renderPanel(traceAndFilter, 100);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "fetch_filtered_trace",
        expect.objectContaining({ scanEnd: 100, fromEnd: true }),
      ),
    );
    grow(150);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "fetch_filtered_trace",
        expect.objectContaining({ scanEnd: 150, fromEnd: true }),
      ),
    );
  });
});

describe("TracePanel view defaults", () => {
  const oneTrace: ProjectElement[] = [
    { kind: "trace", id: "t1", sources: ["*"] } as ProjectElement,
  ];
  /// Which mode button the panel is showing as selected.
  const activeMode = (container: HTMLElement) =>
    [...container.querySelectorAll(".mode-toggle button.active")]
      .map((b) => b.textContent?.replace(/\s+/g, " ").trim())
      .join();
  /// A toolbar checkbox by its label text ("auto-scroll", "events").
  const toolbarBox = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll<HTMLLabelElement>(".trace-panel-toolbar label.checkbox")]
      .find((l) => l.textContent?.trim() === label)
      ?.querySelector("input") ?? null;

  it("opens a fresh panel in the configured default mode", async () => {
    // `by-id` is the default, so asking for `chronological` proves the
    // mode came from the setting rather than from the hard-coded one.
    storedSettings = { trace_mode: "chronological" };
    await hydrateSettings();
    const { container } = renderPanel(oneTrace, 100, null);
    expect(activeMode(container)).toBe("trace");
  });

  it("takes auto-scroll and the events overlay from the settings", async () => {
    // Both default to on, so both off proves the panel read them.
    storedSettings = {
      trace_mode: "chronological",
      trace_auto_scroll: false,
      trace_show_events: false,
    };
    await hydrateSettings();
    const { container } = renderPanel(oneTrace, 100, null);
    expect(toolbarBox(container, "auto-scroll")?.checked).toBe(false);
    expect(toolbarBox(container, "events")?.checked).toBe(false);
  });

  it("lets a panel's own saved config win over the default", async () => {
    // A `default` setting seeds a *new* view; it must never override
    // what a panel already carries.
    storedSettings = {
      trace_mode: "by-id",
      trace_auto_scroll: false,
      trace_show_events: false,
    };
    await hydrateSettings();
    const el = {
      kind: "trace",
      id: "t1",
      sources: ["*"],
      config: { mode: "chronological", autoScroll: true, showEvents: true },
    } as unknown as ProjectElement;
    const { container } = renderPanel([el], 100, null);
    expect(activeMode(container)).toBe("trace");
    expect(toolbarBox(container, "auto-scroll")?.checked).toBe(true);
    expect(toolbarBox(container, "events")?.checked).toBe(true);
  });

  it("does not retro-fit an open panel when the default changes", async () => {
    // Changing a default is not a broadcast: the panel read it once, at
    // creation, and keeps what it has.
    const { container, grow } = renderPanel(oneTrace, 100, null);
    expect(activeMode(container)).toBe("by ID");
    storedSettings = { trace_mode: "chronological" };
    await act(async () => {
      await hydrateSettings();
    });
    grow(150);
    expect(activeMode(container)).toBe("by ID");
  });
});

describe("TracePanel config persistence", () => {
  it("restores config from the element over bare reopen params", () => {
    // Reopened from the Elements list, params carry only `elementId`
    // (+ the default `mode: by-id`); the real setup lives on the
    // element's `config`, which must win.
    const el = {
      kind: "trace",
      id: "t1",
      sources: ["*"],
      config: { mode: "chronological", autoScroll: false },
    } as unknown as ProjectElement;
    const { api } = renderPanel([el], 100, "by-id");
    const calls = api.updateParameters.mock.calls;
    const last = calls[calls.length - 1]?.[0] ?? {};
    expect(last.mode).toBe("chronological");
    expect(last.autoScroll).toBe(false);
  });

  it("mirrors its config onto the element via the registry", () => {
    const { registry } = renderPanel(
      [{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement],
      100,
      "by-id",
    );
    const cfg = (registry.get("t1")!.element as { config?: { mode?: string } }).config;
    expect(cfg?.mode).toBe("by-id");
  });
});

describe("TracePanel rehydration", () => {
  /// Which mode button the panel is showing as selected.
  const activeMode = (container: HTMLElement) =>
    [...container.querySelectorAll(".mode-toggle button.active")]
      .map((b) => b.textContent?.replace(/\s+/g, " ").trim())
      .join();
  const toolbarBox = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll<HTMLLabelElement>(".trace-panel-toolbar label.checkbox")]
      .find((l) => l.textContent?.trim() === label)
      ?.querySelector("input") ?? null;

  /// The panel over a registry that really applies patches, so a write
  /// from outside the panel reaches it the way the app's would.
  function renderLive(config: Record<string, unknown>) {
    const { Provider, control } = makeLiveRegistry([
      { kind: "trace", id: "t1", sources: ["*"], config } as unknown as ProjectElement,
    ]);
    const api = { updateParameters: vi.fn() };
    const props = { params: { elementId: "t1" }, api } as unknown as Parameters<
      typeof TracePanel
    >[0];
    const { container } = render(
      <TraceDataProvider value={traceData}>
        <ProjectContext.Provider value={projectCtx}>
          <Provider>
            <TracePanel {...props} />
          </Provider>
        </ProjectContext.Provider>
      </TraceDataProvider>,
    );
    return { container, control, api };
  }

  it("repaints from an externally rewritten config", () => {
    // The toolbar's checkboxes belong to the chronological view, so the
    // write that flips them is also the write that switches modes.
    const { container, control } = renderLive({
      mode: "by-id",
      autoScroll: true,
      showEvents: true,
    });
    expect(activeMode(container)).toBe("by ID");
    act(() => {
      control.update("t1", {
        config: { mode: "chronological", autoScroll: false, showEvents: false },
      });
    });
    expect(activeMode(container)).toBe("trace");
    expect(toolbarBox(container, "auto-scroll")?.checked).toBe(false);
    expect(toolbarBox(container, "events")?.checked).toBe(false);
  });

  it("keeps the panel's own edit — a persist is not a resync trigger", () => {
    const { container, control } = renderLive({ mode: "chronological" });
    const byId = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.replace(/\s+/g, " ").trim() === "by ID",
    )!;
    act(() => {
      fireEvent.click(byId);
    });
    expect(activeMode(container)).toBe("by ID");
    // The element followed the panel, not the other way round: the
    // panel's own persist must not have bounced back as a resync to
    // the pre-click config.
    const cfg = (control.entries()[0].element as { config?: { mode?: string } }).config;
    expect(cfg?.mode).toBe("by-id");
  });
});

describe("TracePanel event kinds", () => {
  const notesCtx = (notes: Note[]): NotesContextValue => ({
    notes,
    addNote: vi.fn(),
    renameNote: vi.fn(),
    recolorNote: vi.fn(),
    describeNote: vi.fn(),
    retagNote: vi.fn(),
    removeNote: vi.fn(),
  });

  function renderWithNotes(notes: Note[]) {
    const props = {
      params: { elementId: "t1", mode: "chronological" },
      api: { updateParameters: vi.fn() },
    } as unknown as Parameters<typeof TracePanel>[0];
    render(
      // No frames: the display rows are exactly the events, so what the
      // view shows is what the filter let through.
      <TraceDataProvider value={{ ...traceData, count: 0 }}>
        <ProjectContext.Provider value={projectCtx}>
          <ElementRegistryContext.Provider
            value={makeRegistry([{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement])}
          >
            <NotesContext.Provider value={notesCtx(notes)}>
              <TracePanel {...props} />
            </NotesContext.Provider>
          </ElementRegistryContext.Provider>
        </ProjectContext.Provider>
      </TraceDataProvider>,
    );
  }

  const eventLabels = () =>
    Array.from(document.querySelectorAll(".trace-event-label")).map((e) => e.textContent);

  it("keeps a hidden-by-default kind out of the trace until this trace enables it", async () => {
    // jsdom lays nothing out, so the row virtualizer would see a zero-height
    // viewport and render a single row. Give it one.
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    renderWithNotes([
      { id: "n1", timestampNs: 1_000_000_000, label: "boom", kind: "note" },
      { id: "e1", timestampNs: 500_000_000, label: "bus error x40", kind: "busError" },
    ]);
    // The note splices in; the bus error does not (ADR 0035).
    await waitFor(() => expect(eventLabels()).toEqual(["boom"]));

    const box = document.querySelector<HTMLInputElement>(
      '.event-kind-filter input[aria-label="Bus Errors"]',
    );
    if (!box) throw new Error("no bus-error row in the kind filter");
    expect(box.checked).toBe(false);
    await act(async () => {
      fireEvent.click(box);
    });
    await waitFor(() => expect(eventLabels()).toEqual(["bus error x40", "boom"]));
    ch.mockRestore();
  });
});
