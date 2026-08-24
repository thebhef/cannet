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
// don't fire it, but `listen()` must resolve to an unsubscriber. It also
// *emits* on that bus, from its event rows' goto control.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { emit } from "@tauri-apps/api/event";

import { TracePanel } from "./TracePanel";
import { GOTO_EVENT } from "./gotoEvent";
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
      (b) => b.textContent?.replace(/\s+/g, " ").trim() === "By ID",
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
  /// Which mode chip the panel is showing as pressed.
  const activeMode = (container: HTMLElement) =>
    [
      ...container.querySelectorAll<HTMLButtonElement>(
        '.chip-seg[aria-label="Trace Mode"] button[aria-pressed="true"]',
      ),
    ]
      .map((b) => b.textContent?.replace(/\s+/g, " ").trim())
      .join();
  /// A toolbar toggle chip's pressed state, by its accessible name
  /// ("Auto-Scroll", "Events").
  const chipPressed = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>(".trace-panel-toolbar button[aria-pressed]")]
      .find((b) => b.getAttribute("aria-label") === name)
      ?.getAttribute("aria-pressed") === "true";

  it("opens a fresh panel in the configured default mode", async () => {
    // `by-id` is the default, so asking for `chronological` proves the
    // mode came from the setting rather than from the hard-coded one.
    storedSettings = { trace_mode: "chronological" };
    await hydrateSettings();
    const { container } = renderPanel(oneTrace, 100, null);
    expect(activeMode(container)).toBe("Trace");
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
    expect(chipPressed(container, "Auto-Scroll")).toBe(false);
    expect(chipPressed(container, "Events")).toBe(false);
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
    expect(activeMode(container)).toBe("Trace");
    expect(chipPressed(container, "Auto-Scroll")).toBe(true);
    expect(chipPressed(container, "Events")).toBe(true);
  });

  it("does not retro-fit an open panel when the default changes", async () => {
    // Changing a default is not a broadcast: the panel read it once, at
    // creation, and keeps what it has.
    const { container, grow } = renderPanel(oneTrace, 100, null);
    expect(activeMode(container)).toBe("By ID");
    storedSettings = { trace_mode: "chronological" };
    await act(async () => {
      await hydrateSettings();
    });
    grow(150);
    expect(activeMode(container)).toBe("By ID");
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
  /// Which mode chip the panel is showing as pressed.
  const activeMode = (container: HTMLElement) =>
    [
      ...container.querySelectorAll<HTMLButtonElement>(
        '.chip-seg[aria-label="Trace Mode"] button[aria-pressed="true"]',
      ),
    ]
      .map((b) => b.textContent?.replace(/\s+/g, " ").trim())
      .join();
  const chipPressed = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>(".trace-panel-toolbar button[aria-pressed]")]
      .find((b) => b.getAttribute("aria-label") === name)
      ?.getAttribute("aria-pressed") === "true";

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
    expect(activeMode(container)).toBe("By ID");
    act(() => {
      control.update("t1", {
        config: { mode: "chronological", autoScroll: false, showEvents: false },
      });
    });
    expect(activeMode(container)).toBe("Trace");
    expect(chipPressed(container, "Auto-Scroll")).toBe(false);
    expect(chipPressed(container, "Events")).toBe(false);
  });

  it("keeps the panel's own edit — a persist is not a resync trigger", () => {
    const { container, control } = renderLive({ mode: "chronological" });
    const byId = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.replace(/\s+/g, " ").trim() === "By ID",
    )!;
    act(() => {
      fireEvent.click(byId);
    });
    expect(activeMode(container)).toBe("By ID");
    // The element followed the panel, not the other way round: the
    // panel's own persist must not have bounced back as a resync to
    // the pre-click config.
    const cfg = (control.entries()[0].element as { config?: { mode?: string } }).config;
    expect(cfg?.mode).toBe("by-id");
  });
});

describe("TracePanel run controls", () => {
  // The shared `TraceControls` run chips are icon-only, in a
  // `ChipSegment`, but drive the same `useTrace` handle the old plain
  // buttons did. Pause and Stop both freeze the window at the current
  // session count, so a test that only checks "the window froze" cannot
  // tell one chip from the other wired to the wrong handler — only
  // `isPaused` does.
  function renderRunning() {
    // A freshly seeded element runs (`freshTrace`), so the bar shows
    // Pause / Stop, not Start.
    const { Provider, control } = makeLiveRegistry([
      { kind: "trace", id: "t1", sources: ["*"] } as ProjectElement,
    ]);
    const props = {
      params: { elementId: "t1" },
      api: { updateParameters: vi.fn() },
    } as unknown as Parameters<typeof TracePanel>[0];
    const { container } = render(
      <TraceDataProvider value={traceData}>
        <ProjectContext.Provider value={projectCtx}>
          <Provider>
            <TracePanel {...props} />
          </Provider>
        </ProjectContext.Provider>
      </TraceDataProvider>,
    );
    return { container, control };
  }

  const runChip = (container: HTMLElement, name: string): HTMLButtonElement => {
    const btn = [
      ...container.querySelectorAll<HTMLButtonElement>(".trace-panel-toolbar button"),
    ].find((b) => b.getAttribute("aria-label") === name);
    if (!btn) throw new Error(`run chip "${name}" not found`);
    return btn;
  };

  it("Pause freezes the window but marks it resumable", () => {
    const { container, control } = renderRunning();
    fireEvent.click(runChip(container, "Pause"));
    const state = control.entries()[0].trace;
    expect(state.end).not.toBeNull();
    expect(state.isPaused).toBe(true);
  });

  it("Stop freezes the window without leaving it resumable", () => {
    const { container, control } = renderRunning();
    fireEvent.click(runChip(container, "Stop"));
    const state = control.entries()[0].trace;
    expect(state.end).not.toBeNull();
    expect(state.isPaused).toBe(false);
  });

  it("Clear collapses the window to empty at the current count, keeping it running", () => {
    const { container, control } = renderRunning();
    fireEvent.click(runChip(container, "Clear"));
    const state = control.entries()[0].trace;
    expect(state.end).toBeNull();
    expect(state.start).toBe(traceData.count);
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
    linkEvents: vi.fn(),
    unlinkEvents: vi.fn(),
  });

  function renderWithNotes(notes: Note[], ctx: NotesContextValue = notesCtx(notes)) {
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
            <NotesContext.Provider value={ctx}>
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

describe("TracePanel event rows: the same interactions as the events view", () => {
  // Owner ruling: an event row carries the same content and the same
  // interactions wherever it is drawn. The chronological trace draws
  // them interleaved with frames; these tests are the second surface
  // of the pair, the events view being the first
  // (`EventsPanel.dom.test.tsx`).
  const note: Note = { id: "n1", timestampNs: 1_000_000_000, label: "boom", kind: "note" };

  const notesCtx = (notes: Note[]): NotesContextValue => ({
    notes,
    addNote: vi.fn(),
    renameNote: vi.fn(),
    recolorNote: vi.fn(),
    describeNote: vi.fn(),
    retagNote: vi.fn(),
    removeNote: vi.fn(),
    linkEvents: vi.fn(),
    unlinkEvents: vi.fn(),
  });

  function renderWithNotes(notes: Note[], ctx: NotesContextValue = notesCtx(notes)) {
    const props = {
      params: { elementId: "t1", mode: "chronological" },
      api: { updateParameters: vi.fn() },
    } as unknown as Parameters<typeof TracePanel>[0];
    render(
      <TraceDataProvider value={{ ...traceData, count: 0 }}>
        <ProjectContext.Provider value={projectCtx}>
          <ElementRegistryContext.Provider
            value={makeRegistry([{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement])}
          >
            <NotesContext.Provider value={ctx}>
              <TracePanel {...props} />
            </NotesContext.Provider>
          </ElementRegistryContext.Provider>
        </ProjectContext.Provider>
      </TraceDataProvider>,
    );
  }

  const eventLabels = () =>
    Array.from(document.querySelectorAll(".trace-event-label")).map((e) => e.textContent);

  function grid(): HTMLElement {
    const el = document.querySelector(".trace-rows");
    if (!el) throw new Error("no rows container");
    return el as HTMLElement;
  }

  /// jsdom lays nothing out, so the row virtualizer would see a
  /// zero-height viewport and draw one row. Give it a real one.
  let restoreHeight: (() => void) | null = null;
  beforeEach(() => {
    const spy = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    restoreHeight = () => spy.mockRestore();
  });
  afterEach(() => restoreHeight?.());

  it("carries the goto control, and Space on the cursor's row broadcasts it", async () => {
    // The control was the events view's alone; the trace panel wired no
    // `onGoto`, so the button was hidden there and Space had nothing to
    // run.
    renderWithNotes([note]);
    await waitFor(() => expect(eventLabels()).toEqual(["boom"]));
    const button = document.querySelector<HTMLElement>(".trace-event-goto");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("go to this event");

    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    fireEvent.keyDown(grid(), { key: " " });
    expect(emit).toHaveBeenCalledWith(GOTO_EVENT, 1_000_000_000);

    // …and it is the button's own call, not a second path.
    vi.mocked(emit).mockClear();
    fireEvent.click(button!);
    expect(emit).toHaveBeenCalledWith(GOTO_EVENT, 1_000_000_000);
  });

  it("names the row and states its disclosure the way the events view does", async () => {
    // The row ARIA is the shared renderer's, and this is the surface
    // that proves the sharing rather than assuming it.
    renderWithNotes([note]);
    await waitFor(() => expect(eventLabels()).toEqual(["boom"]));
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    const named = document.getElementById(grid().getAttribute("aria-activedescendant") ?? "");
    expect(named).toHaveClass("trace-event-row");
    expect(named).toHaveAttribute("aria-expanded", "false");
    expect(named).not.toHaveAttribute("aria-selected");
    expect(named?.querySelector(".trace-event-disclose")).toHaveAttribute("tabindex", "-1");
  });

  it("renames the cursor's event row on F2", async () => {
    const ctx = notesCtx([note]);
    renderWithNotes([note], ctx);
    await waitFor(() => expect(eventLabels()).toEqual(["boom"]));
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    fireEvent.keyDown(grid(), { key: "F2" });
    const input = document.querySelector<HTMLInputElement>(".trace-event-label-input");
    if (!input) throw new Error("F2 opened no label editor");
    fireEvent.change(input, { target: { value: "crunch" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ctx.renameNote).toHaveBeenCalledWith("n1", "crunch");
  });

  it("leaves a derived event read-only here too, but still goes to it", async () => {
    const busError: Note = {
      id: "e1",
      timestampNs: 500_000_000,
      label: "bus error x40",
      kind: "busError",
    };
    const ctx = notesCtx([busError]);
    renderWithNotes([busError], ctx);
    const box = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>(
        '.event-kind-filter input[aria-label="Bus Errors"]',
      );
      if (!el) throw new Error("no bus-error row in the kind filter");
      return el;
    });
    await act(async () => {
      fireEvent.click(box);
    });
    await waitFor(() => expect(eventLabels()).toEqual(["bus error x40"]));
    // The mouse is offered no rename here…
    expect(document.querySelector('[aria-label="rename event"]')).toBeNull();

    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    fireEvent.keyDown(grid(), { key: "F2" });
    // …and neither is the keyboard.
    expect(document.querySelector(".trace-event-label-input")).toBeNull();
    expect(ctx.renameNote).not.toHaveBeenCalled();

    // Read-only is about editing; every event is still a place in time.
    fireEvent.keyDown(grid(), { key: " " });
    expect(emit).toHaveBeenCalledWith(GOTO_EVENT, 500_000_000);
  });
});

describe("TracePanel authoring an event from a trace row (ADR 0056)", () => {
  // The trace row's context menu creates an event subjected to that
  // message. It rides the panel's existing right-click menu rather than
  // opening a second one, so the sources picker every right-click has
  // always offered is still there.
  const FRAME_TS_S = 12.5;

  const notesCtx = (addNote: NotesContextValue["addNote"]): NotesContextValue => ({
    notes: [],
    addNote,
    renameNote: vi.fn(),
    recolorNote: vi.fn(),
    describeNote: vi.fn(),
    retagNote: vi.fn(),
    removeNote: vi.fn(),
    linkEvents: vi.fn(),
    unlinkEvents: vi.fn(),
  });

  function frame(index: number, id: number, extended: boolean, name: string | null) {
    return {
      index,
      timestamp_seconds: FRAME_TS_S + index / 1000,
      channel: 0,
      id,
      extended,
      direction: "Rx",
      kind: { kind: "classic" },
      data: [1, 2],
      decoded: name == null ? null : { name, signals: [] },
      bus_id: "b1",
    };
  }

  function renderFrames(
    frames: ReturnType<typeof frame>[],
    addNote: NotesContextValue["addNote"] = vi.fn(),
  ) {
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    const props = {
      params: { elementId: "t1", mode: "chronological" },
      api: { updateParameters: vi.fn() },
    } as unknown as Parameters<typeof TracePanel>[0];
    const data: TraceData = {
      ...traceData,
      count: frames.length,
      fetchRange: async (start: number, end: number) =>
        frames.slice(start, end) as unknown as Awaited<ReturnType<TraceData["fetchRange"]>>,
    };
    render(
      <TraceDataProvider value={data}>
        <ProjectContext.Provider value={projectCtx}>
          <ElementRegistryContext.Provider
            value={makeRegistry([{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement])}
          >
            <NotesContext.Provider value={notesCtx(addNote)}>
              <TracePanel {...props} />
            </NotesContext.Provider>
          </ElementRegistryContext.Provider>
        </ProjectContext.Provider>
      </TraceDataProvider>,
    );
    return { restore: () => ch.mockRestore() };
  }

  const frameRowEl = async () => {
    await waitFor(() => expect(document.querySelector(".trace-row .col-id")).toBeTruthy());
    return document.querySelector(".trace-row") as HTMLElement;
  };

  const createItem = () =>
    Array.from(document.querySelectorAll(".sources-context-menu-action")).find((b) =>
      (b.textContent ?? "").startsWith("Create event from"),
    ) as HTMLElement | undefined;

  it("offers the create action, and keeps the sources picker with it", async () => {
    const { restore } = renderFrames([frame(0, 0x1a2, false, "BMS_Status")]);
    fireEvent.contextMenu(await frameRowEl());
    expect(document.querySelector(".sources-context-menu")).toBeInTheDocument();
    expect(createItem()?.textContent).toBe("Create event from BMS_Status");
    // The checklist the panel has always shown is still on the menu.
    expect(document.querySelector(".sources-picker-header")).toBeInTheDocument();
    restore();
  });

  it("names the arbitration id when no database names the message", async () => {
    const { restore } = renderFrames([frame(0, 0x1a2, false, null)]);
    fireEvent.contextMenu(await frameRowEl());
    expect(createItem()?.textContent).toBe("Create event from s:1A2");
    restore();
  });

  it("creates an event about that message, at that frame's time", async () => {
    const addNote = vi.fn();
    const { restore } = renderFrames([frame(0, 0x1a2, false, "BMS_Status")], addNote);
    fireEvent.contextMenu(await frameRowEl());
    fireEvent.click(createItem()!);
    expect(addNote).toHaveBeenCalledTimes(1);
    const note = addNote.mock.calls[0]![0] as Note;
    expect(note.subjects).toEqual([{ kind: "message", messageId: 0x1a2, extended: false }]);
    expect(note.timestampNs).toBe(Math.round(FRAME_TS_S * 1e9));
    // Provenance-agnostic: the same shape the plot's gesture produces.
    expect(Object.keys(note).sort()).toEqual(["color", "id", "label", "subjects", "timestampNs"]);
    // Acting on it closes the menu.
    expect(document.querySelector(".sources-context-menu")).not.toBeInTheDocument();
    restore();
  });

  it("keeps the extended flag, which is half of message identity", async () => {
    const addNote = vi.fn();
    const { restore } = renderFrames([frame(0, 0x18daf1, true, null)], addNote);
    fireEvent.contextMenu(await frameRowEl());
    fireEvent.click(createItem()!);
    expect((addNote.mock.calls[0]![0] as Note).subjects).toEqual([
      { kind: "message", messageId: 0x18daf1, extended: true },
    ]);
    restore();
  });

  it("offers no create action on a right-click that hit no frame row", async () => {
    const { restore } = renderFrames([frame(0, 0x1a2, false, "BMS_Status")]);
    await frameRowEl();
    fireEvent.contextMenu(document.querySelector(".trace-panel")!);
    expect(document.querySelector(".sources-context-menu")).toBeInTheDocument();
    expect(createItem()).toBeUndefined();
    restore();
  });
});
