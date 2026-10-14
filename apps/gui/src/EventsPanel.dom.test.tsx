// @vitest-environment jsdom
/**
 * The Events panel (ADR 0035): one list of the authored events and every
 * bus's bus-error episodes, by time, oldest first, paged from the host
 * (`events_page`) — and the controls on its rows, among them the
 * cross-panel "goto" that broadcasts an event's absolute timestamp on the
 * goto bus for the trace and plot panels to re-centre on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import { answerEventsPage, fakeEventsHost, type FakeEventsHost } from "./eventsPageFake";

/// The host behind the panel: `events_page` answers from `host` the way
/// `events_page.rs` would; `get_bus_health` / `get_settings` answer `{}`
/// unless a test says otherwise.
let host: FakeEventsHost = fakeEventsHost();
let busHealthFixture: Record<string, { errorCount: number }> = {};
let settingsFixture: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "events_page") return answerEventsPage(host, args);
    if (cmd === "get_bus_health") return busHealthFixture;
    if (cmd === "get_settings") return settingsFixture;
    return [];
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

import { EventsPanel } from "./EventsPanel";
import { activeEventIds, resetEventHighlight } from "./eventHighlight";
import { formatLocalTimestamp } from "./format";
import { GOTO_EVENT } from "./gotoEvent";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { TraceDataProvider, type TraceData } from "./traceData";
import { maxScrollTop, ROW_HEIGHT } from "./traceViewport";
import { diagCounts } from "./diag";
import { hydrateSettings } from "./hostSettings";
import { NotesContext, type NotesContextValue } from "./notesContext";
import type { Note } from "./notes";
import type { Bus } from "./types";
import type { BusErrorEpisodeWire } from "./useBusErrorMarkers";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const traceData: TraceData = {
  count: 0,
  firstIndex: 0,
  truncationTsNs: null,
  sessionStartSeconds: 0,
  epoch: 0,
  fetchRange: async () => [],
  liveTail: { start: 0, rows: [] },
};

const projectCtx: ProjectContextValue = {
  projectPath: null,
  dirty: false,
  dbcPaths: [],
  dbcBuses: {},
  buses: [],
  interfaceBindings: [],
  connectedAddresses: [],
  connectedBusIds: [],
  remoteConnected: false,
  blfPath: null,
  onNewProject: () => {},
  onOpenProject: () => {},
  onImportCapture: () => {},
  onSaveProject: () => {},
  onSaveProjectAs: () => {},
  onAddDbc: () => {},
  onRemoveDbc: () => {},
  onReloadDbc: () => {},
  onSetDbcBuses: () => {},
  onAddBus: () => {},
  onRemoveBus: () => {},
  onUpdateBus: () => {},
  busesWithPendingHwConfig: [],
  onAddBinding: () => {},
  onRemoveBinding: () => {},
  localVirtualBuses: [],
  onAddVirtualBus: () => {},
  onRemoveVirtualBus: () => {},
  onUpdateVirtualBus: () => {},
  signalColors: {},
  onSetSignalColor: () => {},
  onSetSignalColors: () => {},
};

const CAN1: Bus = { id: "b1", name: "CAN1" };

/// A wall-clock session origin (2023-11-14T22:06:40Z), for the time-cell
/// hover tests — `traceData.sessionStartSeconds` (0) is below
/// `WALL_CLOCK_FLOOR_SECONDS`, so it never anchors on its own.
const SESSION_START = 1_699_999_600;

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
  setNoteSubjects: vi.fn(),
});

/// A dockview panel's props, faked — the panel reads none of them.
function panelProps(): Parameters<typeof EventsPanel>[0] {
  return {
    api: { onDidVisibilityChange: vi.fn(() => ({ dispose: vi.fn() })) },
  } as unknown as Parameters<typeof EventsPanel>[0];
}

/// The project's bus list — the buses whose episodes join the list.
/// Defaults to none, like `projectCtx` itself.
function withProject(buses: Bus[] = []) {
  return buses.length === 0 ? projectCtx : { ...projectCtx, buses };
}

/// The model the host serves from follows what the test hands the panel:
/// the notes store holds `notes`, and history is truncated where the
/// trace data says.
function hostHolds(notes: Note[], data: TraceData) {
  host.notes = notes;
  host.truncationTsNs = data.truncationTsNs;
}

function renderPanel(notes: Note[], data: TraceData = traceData, buses: Bus[] = []) {
  hostHolds(notes, data);
  // One element object, reused across re-renders. That is how dockview
  // mounts a panel — the element is built when the panel is created and
  // held in the layout's state — so React's same-element bail-out
  // insulates a panel from its host re-rendering, and a context change is
  // the only thing that reaches it. Rebuilding the element here instead
  // would re-render the panel unconditionally and prove nothing.
  const child = (
    <ProjectContext.Provider value={withProject(buses)}>
      <NotesContext.Provider value={notesCtx(notes)}>
        <EventsPanel {...panelProps()} />
      </NotesContext.Provider>
    </ProjectContext.Provider>
  );
  const tree = (d: TraceData) => <TraceDataProvider value={d}>{child}</TraceDataProvider>;
  const { rerender } = render(tree(data));
  return { rerender: (d: TraceData) => rerender(tree(d)) };
}

/// The shape every direct (non-`renderPanel`) render in this file shares:
/// a notes context plus the trace/project providers `EventsPanel` needs.
function renderWithNotes(ctx: NotesContextValue, data: TraceData = traceData) {
  hostHolds(ctx.notes as Note[], data);
  render(
    <TraceDataProvider value={data}>
      <ProjectContext.Provider value={projectCtx}>
        <NotesContext.Provider value={ctx}>
          <EventsPanel {...panelProps()} />
        </NotesContext.Provider>
      </ProjectContext.Provider>
    </TraceDataProvider>,
  );
}

/// Every event row on screen.
function eventRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".trace-event-row"));
}

/// The rows arrive from the host: wait for `n` of them.
async function rowsShown(n: number): Promise<HTMLElement[]> {
  await waitFor(() => expect(eventRows()).toHaveLength(n));
  return eventRows();
}

const labels = () =>
  Array.from(document.querySelectorAll(".trace-event-label")).map((e) => e.textContent);

function eventsPageCalls(): Record<string, unknown>[] {
  return vi
    .mocked(invoke)
    .mock.calls.filter((c) => c[0] === "events_page")
    .map((c) => c[1] as Record<string, unknown>);
}

/// The latest `events_page` ask.
function lastEventsPageCall(): Record<string, unknown> | undefined {
  const calls = eventsPageCalls();
  return calls[calls.length - 1];
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  host = fakeEventsHost();
  busHealthFixture = {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("EventsPanel", () => {
  it("does not re-render when only the live half of the capture moves", async () => {
    // A `trace-grew` tick moved `count` / `firstIndex` / `liveTail` ~10x a
    // second and re-rendered every consumer of the trace context — this
    // view among them, though it reads none of those fields. Splitting the
    // context puts the events view on the half that only changes when the
    // model's identity does.
    const { rerender } = renderPanel([
      { id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" },
    ]);
    await rowsShown(1);
    // The first page, then the one refresh the mount marks owed.
    await waitFor(() => expect(eventsPageCalls().length).toBeGreaterThanOrEqual(2));
    await act(async () => {});
    const before = diagCounts().get("render.EventsPanel") ?? 0;
    for (let n = 1; n <= 5; n++) {
      rerender({ ...traceData, count: n * 10, firstIndex: n, liveTail: { start: n, rows: [] } });
    }
    expect((diagCounts().get("render.EventsPanel") ?? 0) - before).toBe(0);
  });
});

describe("event row focus and editing", () => {
  // The same `EventRow` renderer draws the events interleaved into the
  // chronological trace panel, so this covers both surfaces.
  const note: Note = { id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" };

  it("focuses the row that was clicked, and only that row", async () => {
    renderPanel([note, { ...note, id: "n2", timestampNs: 6_000_000_000, label: "thud" }]);
    const rows = await rowsShown(2);
    expect(rows.map((r) => r.classList.contains("trace-event-focused"))).toEqual([false, false]);

    fireEvent.click(rows[1]);
    expect(rows.map((r) => r.classList.contains("trace-event-focused"))).toEqual([false, true]);
    // Turned around: the row used to be a tab stop of its own, so that a
    // click left the keyboard on it. That was a second focus model
    // beside the one every other gridview uses — the container holds
    // focus and *names* the active row — and it put an event row in the
    // page's tab order, which no other trace row is in. The mark is the
    // cursor's, and the keyboard is the container's (ADR 0044).
    expect(rows[1]).not.toHaveAttribute("tabindex");
    expect(rows[1].getAttribute("role")).toBe("treeitem");
    const container = document.querySelector(".trace-rows") as HTMLElement;
    expect(document.activeElement).toBe(container);
    expect(container.getAttribute("aria-activedescendant")).toBe(rows[1].id);

    fireEvent.click(rows[0]);
    expect(rows.map((r) => r.classList.contains("trace-event-focused"))).toEqual([true, false]);
  });

  it("does not start editing when the row is clicked", async () => {
    renderPanel([note]);
    fireEvent.click(await screen.findByText("boom"));
    expect(screen.queryByLabelText("event label")).toBeNull();
  });

  it("enables the field from the edit button, and commits the new label", async () => {
    const ctx = notesCtx([note]);
    renderWithNotes(ctx);

    fireEvent.click(await screen.findByLabelText("rename event"));
    const input = screen.getByLabelText("event label") as HTMLInputElement;
    expect(input.value).toBe("boom");

    fireEvent.change(input, { target: { value: "crunch" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ctx.renameNote).toHaveBeenCalledWith("n1", "crunch");
    expect(screen.queryByLabelText("event label")).toBeNull();
  });

  it("abandons a rename on Escape without committing the draft", async () => {
    // The row sits inside a gridview, whose Escape takes focus back to
    // the container (ADR 0044) — and this field commits on blur. The
    // editor consumes the press for that reason; if it stopped doing so
    // the abandoned draft would be committed by the blur that follows.
    const ctx = notesCtx([note]);
    renderWithNotes(ctx);

    fireEvent.click(await screen.findByLabelText("rename event"));
    const input = screen.getByLabelText("event label") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "crunch" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(ctx.renameNote).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("event label")).toBeNull();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("still takes a double-click on the label as a rename", async () => {
    renderPanel([note]);
    fireEvent.doubleClick(await screen.findByText("boom"));
    expect((screen.getByLabelText("event label") as HTMLInputElement).value).toBe("boom");
  });

  it("offers no edit button on a derived event", async () => {
    // The truncation marker is not user-editable (ADR 0035).
    renderPanel([], { ...traceData, truncationTsNs: 3_000_000_000, count: 1, firstIndex: 1 });
    await rowsShown(1);
    expect(screen.queryByLabelText("rename event")).toBeNull();
  });

  it("draws goto/rename/remove as the registry's icons, not the retired text glyphs", async () => {
    renderPanel([note]);
    await rowsShown(1);
    for (const label of ["go to this event", "rename event", "remove event"]) {
      const btn = screen.getByLabelText(label);
      // The old glyphs (⇥ ✎ ×) were the button's entire text content;
      // the drawn icon is decorative (aria-hidden) and leaves none.
      expect(btn.textContent).toBe("");
      const svg = btn.querySelector("svg");
      expect(svg).toBeTruthy();
      expect(svg).toHaveAttribute("viewBox", "0 0 14 14");
    }
  });
});

describe("EventsPanel goto", () => {
  it("broadcasts the event's absolute timestamp on the goto bus", async () => {
    renderPanel([{ id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" }]);
    fireEvent.click(await screen.findByLabelText("go to this event"));
    expect(emit).toHaveBeenCalledWith(GOTO_EVENT, 5_000_000_000);
  });
});

describe("EventsPanel event rows on the keyboard", () => {
  // The gridview action keys on this surface (ADR 0044). The trace
  // panel's interleaved event rows are the other one, covered in
  // `TracePanel.dom.test.tsx` — the keys must work in both.
  const note: Note = { id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" };

  function grid(): HTMLElement {
    const el = document.querySelector(".trace-rows");
    if (!el) throw new Error("no rows container");
    return el as HTMLElement;
  }

  /// Step the gridview cursor onto the view's first row.
  async function cursorToFirstRow() {
    await rowsShown(1);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(document.querySelector(".trace-event-row")).toHaveClass("trace-event-focused");
  }

  it("goes to the cursor's event on Space", async () => {
    renderPanel([note]);
    await cursorToFirstRow();
    fireEvent.keyDown(grid(), { key: " " });
    expect(emit).toHaveBeenCalledWith(GOTO_EVENT, 5_000_000_000);
  });

  it("renames the cursor's event on F2, and commits it to the host", async () => {
    const ctx = notesCtx([note]);
    renderWithNotes(ctx);
    await cursorToFirstRow();
    fireEvent.keyDown(grid(), { key: "F2" });
    const input = screen.getByLabelText("event label") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "crunch" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ctx.renameNote).toHaveBeenCalledWith("n1", "crunch");
  });

  it("takes no F2 on the truncation marker, which offers no rename either", async () => {
    // The derived event of this view's own space (ADR 0035).
    renderPanel([], { ...traceData, truncationTsNs: 3_000_000_000, count: 1, firstIndex: 1 });
    await cursorToFirstRow();
    expect(screen.queryByLabelText("rename event")).toBeNull();
    fireEvent.keyDown(grid(), { key: "F2" });
    expect(screen.queryByLabelText("event label")).toBeNull();
    // …and Space still goes to it: read-only is about editing.
    fireEvent.keyDown(grid(), { key: " " });
    expect(emit).toHaveBeenCalledWith(GOTO_EVENT, 3_000_000_000);
  });
});

describe("EventsPanel in a narrow panel", () => {
  // Reported from a narrow *vertical* dock: the ✎ and × controls were off
  // the row's right edge and horizontal scrolling would not bring them
  // back. The rows are `position: absolute; left: 0; right: 0` inside the
  // sticky viewport, so their width is the width of `.trace-scroll-content`
  // — which is `min-width: calc(var(--trace-content-width) + 2 *
  // padding)`, the *columns'* total. This view has no columns, but it was
  // handing TraceView `columnsFromParams(undefined)`, which is the default
  // frame layout: 1144 px of tracks that are never drawn.
  //
  // Measured in headless Edge (the WebView2 engine) with the real
  // `index.css` and this panel's own rendered DOM, in a 220 px group: the
  // row laid out 1163 px wide, `.trace-rows` reported `scrollWidth` 1163
  // against a `clientWidth` of 220, and the controls sat at x 1105-1128
  // (✎) and 1136-1154 (×) — 885 px past the panel's right edge, behind
  // 943 px of empty scroll. (They were *reachable* at `scrollLeft` 943 —
  // the row is not clipped at the viewport, it is simply laid out for
  // columns that do not exist.) With no columns declared:
  // `--trace-content-width` 0, `.trace-scroll-content` 220 px,
  // `scrollWidth === clientWidth === 220` and `maxScrollLeft` 0 (nothing
  // to scroll at all), the label ellipsised to 40 px, and both controls
  // rendered inside the panel at x 161-185 and 193-210.
  //
  // jsdom does no layout, so this asserts the width the view publishes —
  // the fact the measurement traces the geometry back to.
  it("declares no column width, so its rows lay out at the panel's own width", () => {
    renderPanel([{ id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" }]);
    const content = document.querySelector(".trace-scroll-content") as HTMLElement;
    expect(content).toBeTruthy();
    expect(content.style.getPropertyValue("--trace-content-width")).toBe("0px");
  });

  // The controls come after the label in the row, which is what
  // `margin-left: auto` pins to the right edge; the label is the flex item
  // that gives way (`flex: 0 1 auto; min-width: 0; overflow: hidden`).
  it("renders the rename and remove controls after the label", async () => {
    renderPanel([{ id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" }]);
    const [row] = await rowsShown(1);
    const classes = Array.from(row.children).map((c) => c.className);
    expect(classes.slice(-3)).toEqual([
      "trace-event-label trace-event-label-editable",
      "trace-event-edit",
      "trace-event-remove",
    ]);
  });
});

describe("EventsPanel kind filter", () => {
  const note: Note = { id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" };

  it("counts the bus errors off the host's totals, and hides what a row covers", async () => {
    busHealthFixture = { [CAN1.id]: { errorCount: 1 } };
    host.episodes = [episode(1, 4)];
    renderPanel([note], traceData, [CAN1]);
    await rowsShown(2);

    const box = () => screen.getByLabelText("Diagnostics") as HTMLInputElement;
    expect(box().checked).toBe(true);
    await waitFor(() => expect(box().closest("label")?.textContent).toContain("1"));

    fireEvent.click(box());
    await waitFor(() => expect(labels()).toEqual(["boom"]));
    // The filter is the host's: the next page is asked without the kind.
    expect(lastEventsPageCall()?.kinds).toEqual(["messageBound", "note"]);
  });

  it("counts every kind a row covers, not just the first", async () => {
    // Two Diagnostics-group kinds present at once: the number beside the
    // row has to be their sum, or it under-reports what the checkbox is
    // hiding. Bus errors come off the host's totals; the truncation
    // marker is the group's other kind.
    busHealthFixture = { [CAN1.id]: { errorCount: 1 } };
    renderPanel([note], { ...traceData, truncationTsNs: 3_000_000_000, count: 1, firstIndex: 1 }, [
      CAN1,
    ]);
    await waitFor(() =>
      expect(screen.getByLabelText("Diagnostics").closest("label")?.textContent).toContain("2"),
    );
  });

  it("offers no edit controls on a host-derived event", async () => {
    renderPanel([], { ...traceData, truncationTsNs: 3_000_000_000, count: 1, firstIndex: 1 });
    await waitFor(() => expect(labels()).toEqual(["history truncated here"]));
    expect(screen.queryByLabelText("rename event")).toBeNull();
    expect(screen.queryByLabelText("remove event")).toBeNull();
  });

  it("says on the Diagnostics row's tooltip the gap bus errors are grouped at", async () => {
    // The hint the separate bus-error section's header carried.
    renderPanel([note], traceData, [CAN1]);
    await rowsShown(1);
    expect(screen.getByLabelText("Diagnostics").closest("label")).toHaveAttribute(
      "title",
      expect.stringContaining("episodes at 5 s"),
    );
  });
});

describe("EventsPanel event body", () => {
  const tagged: Note = {
    id: "n1",
    timestampNs: 5_000_000_000,
    label: "contactor",
    kind: "note",
    tag: "fault",
    description: "opened under load",
  };

  it("keeps the body collapsed until the row is disclosed", async () => {
    renderPanel([tagged]);
    fireEvent.click(await screen.findByLabelText("show event details"));
    expect(screen.getByText("opened under load")).toBeInTheDocument();
    expect(screen.getByText("fault")).toBeInTheDocument();
    // ...and folds back up.
    fireEvent.click(screen.getByLabelText("hide event details"));
    expect(screen.queryByText("opened under load")).toBeNull();
  });

  it("edits the description in place and commits it to the host", async () => {
    const ctx = notesCtx([tagged]);
    renderWithNotes(ctx);
    fireEvent.click(await screen.findByLabelText("show event details"));
    fireEvent.click(screen.getByText("opened under load"));
    const input = screen.getByLabelText("event description") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "welded shut" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ctx.describeNote).toHaveBeenCalledWith("n1", "welded shut");

    // Clearing the field clears the description rather than storing "".
    fireEvent.click(screen.getByText("opened under load"));
    const again = screen.getByLabelText("event description") as HTMLInputElement;
    fireEvent.change(again, { target: { value: "  " } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(ctx.describeNote).toHaveBeenLastCalledWith("n1", null);
  });
});

describe("EventsPanel event row ARIA", () => {
  // Measured against what the other gridviews put on a row (the database
  // and RBS trees, `ByIdTable`): the DOM id `aria-activedescendant`
  // names, `aria-expanded` where the row discloses something, and
  // `aria-selected` only where the row can be selected.
  const tagged: Note = {
    id: "n1",
    timestampNs: 5_000_000_000,
    label: "contactor",
    kind: "note",
    tag: "fault",
    description: "opened under load",
  };

  function grid(): HTMLElement {
    const el = document.querySelector(".trace-rows");
    if (!el) throw new Error("no rows container");
    return el as HTMLElement;
  }

  /// The row the container currently names as active.
  function activeRow(): HTMLElement | null {
    const id = grid().getAttribute("aria-activedescendant");
    return id == null ? null : document.getElementById(id);
  }

  it("states its expanded state on the row the container names, not only on the caret", async () => {
    // The caret is a nested node; the cursor is on the *row*, so a
    // reader following `aria-activedescendant` never reaches the caret's
    // own `aria-expanded` and was told nothing about the disclosure.
    renderPanel([tagged]);
    await rowsShown(1);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toHaveClass("trace-event-row");
    expect(activeRow()).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    expect(activeRow()).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(grid(), { key: "ArrowLeft" });
    expect(activeRow()).toHaveAttribute("aria-expanded", "false");
  });

  it("says nothing about expansion on an event with nothing to disclose", async () => {
    // The truncation marker: derived, and carrying neither tag nor
    // description, so there is no body behind it to open.
    renderPanel([], { ...traceData, truncationTsNs: 3_000_000_000, count: 1, firstIndex: 1 });
    await rowsShown(1);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toHaveClass("trace-event-row");
    expect(activeRow()).not.toHaveAttribute("aria-expanded");
  });

  it("advertises its selection, because this view's event rows are selectable", async () => {
    // An event row takes no part in the selection where it is drawn
    // beside frames (ADR 0044) — but this view's Link Events control
    // acts on exactly two selected events, so here the adapter declares
    // them selectable and the row says which it is.
    renderPanel([tagged]);
    await rowsShown(1);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the caret out of the tab order, so Tab lands on a control that needs it", async () => {
    // The layer's Tab moves into the cursor row's first tab stop
    // (ADR 0044). The caret's job is already Left/Right's, so it opts
    // out the way every other gridview's caret does — otherwise Tab
    // spends its first press on a control the keyboard already has.
    renderPanel([tagged]);
    await rowsShown(1);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    grid().focus();
    fireEvent.keyDown(grid(), { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByLabelText("go to this event"));
    // …and the caret is still a real control for the mouse.
    const caret = document.querySelector(".trace-event-disclose") as HTMLElement;
    expect(caret.tagName).toBe("BUTTON");
    expect(caret.tabIndex).toBe(-1);
  });
});

describe("EventsPanel tag filter", () => {
  it("carries the gridview filter box's shape, not the bare word 'tag'", () => {
    // Owner ruling 2026-10-03: the label's bare "tag" prefix goes, in
    // favour of the same chip-shaped box the trace's own filter uses.
    renderPanel([]);
    const input = screen.getByLabelText("filter by tag");
    expect(input).toHaveAttribute("placeholder", "filter by tag");
    expect(screen.queryByText("tag")).toBeNull();
  });

  it("narrows to the events carrying a matching tag", async () => {
    // jsdom lays nothing out; give the row virtualizer a viewport so all
    // three rows are drawn.
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    renderPanel([
      { id: "a", timestampNs: 1_000_000_000, label: "one", kind: "note", tag: "fault" },
      { id: "b", timestampNs: 2_000_000_000, label: "two", kind: "note", tag: "contactor" },
      { id: "c", timestampNs: 3_000_000_000, label: "three", kind: "note" },
    ]);
    await waitFor(() => expect(labels()).toEqual(["one", "two", "three"]));

    fireEvent.change(screen.getByLabelText("filter by tag"), { target: { value: "cont" } });
    await waitFor(() => expect(labels()).toEqual(["two"]));
    // The filter is the host's: the query carries it.
    expect(lastEventsPageCall()?.tagQuery).toBe("cont");

    // The suggestions are the tags actually in use.
    expect(
      Array.from(document.querySelectorAll("#events-panel-tags option")).map(
        (o) => (o as HTMLOptionElement).value,
      ),
    ).toEqual(["contactor", "fault"]);

    fireEvent.change(screen.getByLabelText("filter by tag"), { target: { value: "" } });
    await waitFor(() => expect(labels()).toEqual(["one", "two", "three"]));
    ch.mockRestore();
  });
});

describe("EventsPanel record types", () => {
  it("files a comment beside the notes, with no row of its own", async () => {
    // A `messageBound` event differs from a note only in the BLF record
    // it is written as, and nothing in the application can author one.
    // A checkbox for it offered the reader a category they cannot
    // produce and cannot tell apart on the row.
    renderPanel([
      { id: "n1", timestampNs: 1_000_000_000, label: "a marker", kind: "note" },
      { id: "c1", timestampNs: 2_000_000_000, label: "a comment", kind: "messageBound" },
    ]);
    await waitFor(() => expect(labels()).toEqual(["a marker", "a comment"]));
    expect(screen.queryByLabelText("Comments")).toBeNull();
    // Both counted on the one row, and both hidden by it.
    expect(screen.getByLabelText("Notes").closest("label")?.textContent).toContain("2");

    fireEvent.click(screen.getByLabelText("Notes"));
    await waitFor(() => expect(labels()).toEqual([]));
  });
});

/// Episode `k` on `bus`, at `1000 + 2k` s: three errors over 4 ms
/// (750/s), its last error the bus's `3(k + 1)`th — except a single
/// error when `single`.
function episode(k: number, at = 1_000 + 2 * k, bus = "b1", single = false): BusErrorEpisodeWire {
  return {
    bus,
    firstT: at,
    lastT: at + (single ? 0 : 0.004),
    count: single ? 1 : 3,
    span: single ? 0 : 0.004,
    rate: single ? null : 750,
    lastOrdinal: 3 * (k + 1),
  };
}

describe("EventsPanel bus-error episodes in the one list", () => {
  afterEach(async () => {
    settingsFixture = {};
    await hydrateSettings();
    resetEventHighlight();
  });

  /// The row standing for event `id`, out of the gridview DOM ids.
  function rowFor(id: string): HTMLElement | null {
    return eventRows().find((r) => r.id.endsWith(`-${encodeURIComponent(`e:${id}`)}`)) ?? null;
  }

  it("lists authored events and episodes together, oldest first", async () => {
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    host.episodes = [episode(0), episode(1), episode(2)]; // 1000, 1002, 1004 s
    renderPanel(
      [
        { id: "a", timestampNs: 999_000_000_000, label: "before", kind: "note" },
        { id: "b", timestampNs: 1_003_000_000_000, label: "between", kind: "note" },
      ],
      traceData,
      [CAN1],
    );
    const ep = "CAN1: 3 bus errors over 0.004 s (750/s)";
    await waitFor(() => expect(labels()).toEqual(["before", ep, ep, "between", ep]));
    const rows = eventRows();
    expect(rows[1]).toHaveClass("trace-event-busError");
    expect(eventsPageCalls()[0]).toMatchObject({
      buses: ["b1"],
      gapSeconds: 5,
      kinds: ["busError", "messageBound", "note", "truncation"],
      tagQuery: "",
    });
    ch.mockRestore();
  });

  it("has no edit controls on an episode, but selects it — and the plot's highlight hears", async () => {
    host.episodes = [episode(0)];
    renderPanel([], traceData, [CAN1]);
    const [row] = await rowsShown(1);
    expect(row.querySelector(".trace-event-edit")).toBeNull();
    expect(row.querySelector(".trace-event-remove")).toBeNull();
    expect(screen.queryByLabelText("pick event color")).toBeNull();
    fireEvent.doubleClick(row.querySelector(".trace-event-label")!);
    expect(screen.queryByLabelText("event label")).toBeNull();

    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-selected", "true");
    // Selecting an episode is acting on it (ADR 0056): the plot lights it
    // and draws its extent.
    expect(activeEventIds()).toEqual(["bus-error:b1:3"]);
  });

  it("hides every episode under a tag query, which they cannot match", async () => {
    host.episodes = [episode(0)];
    renderPanel(
      [{ id: "a", timestampNs: 999_000_000_000, label: "tagged", kind: "note", tag: "fault" }],
      traceData,
      [CAN1],
    );
    await rowsShown(2);
    fireEvent.change(screen.getByLabelText("filter by tag"), { target: { value: "fau" } });
    await waitFor(() => expect(labels()).toEqual(["tagged"]));
  });

  it("hides the episodes when Diagnostics is unticked", async () => {
    host.episodes = [episode(0)];
    renderPanel(
      [{ id: "a", timestampNs: 999_000_000_000, label: "kept", kind: "note" }],
      traceData,
      [CAN1],
    );
    await rowsShown(2);
    fireEvent.click(screen.getByLabelText("Diagnostics"));
    await waitFor(() => expect(labels()).toEqual(["kept"]));
  });

  it("asks the host for no episodes without project buses", async () => {
    host.episodes = [episode(0)];
    renderPanel([{ id: "a", timestampNs: 999_000_000_000, label: "only", kind: "note" }]);
    await waitFor(() => expect(labels()).toEqual(["only"]));
    expect(eventsPageCalls()[0]?.buses).toEqual([]);
  });

  it("re-asks at the new gap when the setting changes", async () => {
    host.episodes = [episode(0)];
    renderPanel([], traceData, [CAN1]);
    await rowsShown(1);
    settingsFixture = { bus_error_episode_gap_s: 1 };
    await act(async () => {
      await hydrateSettings();
    });
    await waitFor(() => expect(lastEventsPageCall()?.gapSeconds).toBe(1));
    expect(screen.getByLabelText("Diagnostics").closest("label")).toHaveAttribute(
      "title",
      expect.stringContaining("episodes at 1 s"),
    );
  });

  describe("over a long fault", () => {
    // The trace's own windowed test, mirrored (`TraceView.anchor.dom.test.tsx`):
    // a stubbed viewport, a thumb dragged to the bottom.
    const VH = 440; // exactly 20 rows
    let restore: (() => void) | null = null;
    beforeEach(() => {
      const prev = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
      Object.defineProperty(Element.prototype, "clientHeight", {
        configurable: true,
        get: () => VH,
      });
      restore = () => Object.defineProperty(Element.prototype, "clientHeight", prev!);
    });
    afterEach(() => restore?.());

    const N = 10_000;
    const all = Array.from({ length: N }, (_, k) => episode(k, 1_000 + 2 * k, "b1", k === N - 1));

    it("holds one page and fetches the page under the viewport as it scrolls", async () => {
      host.episodes = all;
      renderPanel([], traceData, [CAN1]);
      await waitFor(() => expect(eventRows().length).toBeGreaterThan(0));
      // Never the list: every ask is one page.
      expect(eventsPageCalls().every((c) => Number(c.limit) <= 1024)).toBe(true);
      expect(rowFor("bus-error:b1:3")).not.toBeNull();

      const rowsEl = document.querySelector(".trace-rows") as HTMLElement;
      Object.defineProperty(rowsEl, "scrollTop", { value: 0, writable: true });
      rowsEl.scrollTop = maxScrollTop(N, VH); // drag the thumb to the bottom
      fireEvent.scroll(rowsEl);

      await waitFor(() =>
        expect(eventsPageCalls().some((c) => Number(c.offset) > N - 1024 - 1)).toBe(true),
      );
      await waitFor(() => expect(rowFor(`bus-error:b1:${3 * N}`)).not.toBeNull());
      expect(rowFor(`bus-error:b1:${3 * N}`)?.textContent).toContain(
        "CAN1: 1 bus error over 0 s (—)",
      );
      expect(eventsPageCalls().every((c) => Number(c.limit) <= 1024)).toBe(true);
      expect(ROW_HEIGHT).toBe(22);
    });
  });

  it("shows an episode row's local date and time on hover (owner ruling 2026-09-25)", async () => {
    host.episodes = [episode(0)];
    renderPanel([], { ...traceData, sessionStartSeconds: SESSION_START }, [CAN1]);
    const [row] = await rowsShown(1);

    const cell = row.querySelector(".trace-event-time") as HTMLElement;
    fireEvent.mouseOver(cell);
    expect(cell).toHaveAttribute("title", formatLocalTimestamp(1_000, SESSION_START)!);
  });

  it("shows no tooltip on an episode row without a wall-clock origin", async () => {
    host.episodes = [episode(0)];
    renderPanel([], traceData, [CAN1]); // sessionStartSeconds: 0 — capture-relative
    const [row] = await rowsShown(1);

    const cell = row.querySelector(".trace-event-time") as HTMLElement;
    fireEvent.mouseOver(cell);
    expect(cell).not.toHaveAttribute("title");
  });
});
