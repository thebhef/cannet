// @vitest-environment jsdom
/**
 * The events view's cross-panel "goto" control (ADR 0035): clicking the
 * goto button on an event broadcasts its absolute timestamp on the goto bus,
 * which the trace and plot panels listen for and re-centre on. This guards
 * the wiring from the button to `emit(GOTO_EVENT, timestampNs)`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { emit } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

import { EventsPanel } from "./EventsPanel";
import { GOTO_EVENT } from "./gotoEvent";
import { TraceDataProvider, type TraceData } from "./traceData";
import { diagCounts } from "./diag";
import { NotesContext, type NotesContextValue } from "./notesContext";
import type { Note } from "./notes";

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

const notesCtx = (notes: Note[]): NotesContextValue => ({
  notes,
  addNote: vi.fn(),
  renameNote: vi.fn(),
  recolorNote: vi.fn(),
  removeNote: vi.fn(),
});

function renderPanel(notes: Note[], data: TraceData = traceData) {
  const props = {} as Parameters<typeof EventsPanel>[0];
  // One element object, reused across re-renders. That is how dockview
  // mounts a panel — the element is built when the panel is created and
  // held in the layout's state — so React's same-element bail-out
  // insulates a panel from its host re-rendering, and a context change is
  // the only thing that reaches it. Rebuilding the element here instead
  // would re-render the panel unconditionally and prove nothing.
  const child = (
    <NotesContext.Provider value={notesCtx(notes)}>
      <EventsPanel {...props} />
    </NotesContext.Provider>
  );
  const tree = (d: TraceData) => <TraceDataProvider value={d}>{child}</TraceDataProvider>;
  const { rerender } = render(tree(data));
  return { rerender: (d: TraceData) => rerender(tree(d)) };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("EventsPanel", () => {
  it("does not re-render when only the live half of the capture moves", () => {
    // A `trace-grew` tick moved `count` / `firstIndex` / `liveTail` ~10x a
    // second and re-rendered every consumer of the trace context — this
    // view among them, though it reads none of those fields. Splitting the
    // context puts the events view on the half that only changes when the
    // model's identity does.
    const { rerender } = renderPanel([
      { id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" },
    ]);
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

  /// The one event row on screen.
  function row(): HTMLElement {
    const el = document.querySelector<HTMLElement>(".trace-event-row");
    if (!el) throw new Error("no event row rendered");
    return el;
  }

  it("focuses the row that was clicked, and only that row", () => {
    renderPanel([note, { ...note, id: "n2", timestampNs: 6_000_000_000, label: "thud" }]);
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".trace-event-row"));
    expect(rows.map((r) => r.classList.contains("trace-event-focused"))).toEqual([false, false]);

    fireEvent.click(rows[1]);
    expect(rows.map((r) => r.classList.contains("trace-event-focused"))).toEqual([false, true]);
    // The row is a focus target in its own right, not just a styled div.
    expect(rows[1].tabIndex).toBe(0);

    fireEvent.click(rows[0]);
    expect(rows.map((r) => r.classList.contains("trace-event-focused"))).toEqual([true, false]);
  });

  it("does not start editing when the row is clicked", () => {
    renderPanel([note]);
    fireEvent.click(screen.getByText("boom"));
    expect(screen.queryByLabelText("event label")).toBeNull();
  });

  it("enables the field from the edit button, and commits the new label", () => {
    const ctx = notesCtx([note]);
    render(
      <TraceDataProvider value={traceData}>
        <NotesContext.Provider value={ctx}>
          <EventsPanel {...({} as Parameters<typeof EventsPanel>[0])} />
        </NotesContext.Provider>
      </TraceDataProvider>,
    );

    fireEvent.click(screen.getByLabelText("rename event"));
    const input = screen.getByLabelText("event label") as HTMLInputElement;
    expect(input.value).toBe("boom");

    fireEvent.change(input, { target: { value: "crunch" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ctx.renameNote).toHaveBeenCalledWith("n1", "crunch");
    expect(screen.queryByLabelText("event label")).toBeNull();
  });

  it("abandons a rename on Escape without committing the draft", () => {
    // The row sits inside a gridview, whose Escape takes focus back to
    // the container (ADR 0044) — and this field commits on blur. The
    // editor consumes the press for that reason; if it stopped doing so
    // the abandoned draft would be committed by the blur that follows.
    const ctx = notesCtx([note]);
    render(
      <TraceDataProvider value={traceData}>
        <NotesContext.Provider value={ctx}>
          <EventsPanel {...({} as Parameters<typeof EventsPanel>[0])} />
        </NotesContext.Provider>
      </TraceDataProvider>,
    );

    fireEvent.click(screen.getByLabelText("rename event"));
    const input = screen.getByLabelText("event label") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "crunch" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(ctx.renameNote).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("event label")).toBeNull();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("still takes a double-click on the label as a rename", () => {
    renderPanel([note]);
    fireEvent.doubleClick(screen.getByText("boom"));
    expect((screen.getByLabelText("event label") as HTMLInputElement).value).toBe("boom");
  });

  it("offers no edit button on a derived event", () => {
    // The truncation marker is not user-editable (ADR 0035).
    renderPanel([], { ...traceData, truncationTsNs: 3_000_000_000, count: 1, firstIndex: 1 });
    expect(row()).toBeTruthy();
    expect(screen.queryByLabelText("rename event")).toBeNull();
  });
});

describe("EventsPanel goto", () => {
  it("broadcasts the event's absolute timestamp on the goto bus", () => {
    renderPanel([{ id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" }]);
    fireEvent.click(screen.getByLabelText("go to this event"));
    expect(emit).toHaveBeenCalledWith(GOTO_EVENT, 5_000_000_000);
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
  it("renders the rename and remove controls after the label", () => {
    renderPanel([{ id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" }]);
    const row = document.querySelector(".trace-event-row") as HTMLElement;
    const classes = Array.from(row.children).map((c) => c.className);
    expect(classes.slice(-3)).toEqual([
      "trace-event-label trace-event-label-editable",
      "trace-event-edit",
      "trace-event-remove",
    ]);
  });
});

describe("EventsPanel kind filter", () => {
  const busError: Note = {
    id: "e1",
    timestampNs: 4_000_000_000,
    label: "bus error x40",
    kind: "busError",
  };
  const note: Note = { id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" };

  const labels = () =>
    Array.from(document.querySelectorAll(".trace-event-label")).map((e) => e.textContent);

  it("hides a kind that declares itself hidden, and shows it when asked", () => {
    // "By default not shown anywhere" — but findable: the checklist lists
    // the kind with its count even while it is off (ADR 0035).
    renderPanel([busError, note]);
    expect(labels()).toEqual(["boom"]);

    const box = screen.getByTitle("Bus Errors").querySelector("input") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByTitle("Bus Errors").textContent).toContain("1");

    fireEvent.click(box);
    expect(labels()).toEqual(["bus error x40", "boom"]);
  });

  it("offers no edit controls on a host-derived event", () => {
    renderPanel([busError]);
    fireEvent.click(screen.getByTitle("Bus Errors").querySelector("input") as HTMLInputElement);
    expect(labels()).toEqual(["bus error x40"]);
    expect(screen.queryByLabelText("rename event")).toBeNull();
    expect(screen.queryByLabelText("remove event")).toBeNull();
  });
});
