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
  describeNote: vi.fn(),
  retagNote: vi.fn(),
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
  function cursorToFirstRow() {
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(document.querySelector(".trace-event-row")).toHaveClass("trace-event-focused");
  }

  it("goes to the cursor's event on Space", () => {
    renderPanel([note]);
    cursorToFirstRow();
    fireEvent.keyDown(grid(), { key: " " });
    expect(emit).toHaveBeenCalledWith(GOTO_EVENT, 5_000_000_000);
  });

  it("renames the cursor's event on F2, and commits it to the host", () => {
    const ctx = notesCtx([note]);
    render(
      <TraceDataProvider value={traceData}>
        <NotesContext.Provider value={ctx}>
          <EventsPanel {...({} as Parameters<typeof EventsPanel>[0])} />
        </NotesContext.Provider>
      </TraceDataProvider>,
    );
    cursorToFirstRow();
    fireEvent.keyDown(grid(), { key: "F2" });
    const input = screen.getByLabelText("event label") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "crunch" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ctx.renameNote).toHaveBeenCalledWith("n1", "crunch");
  });

  it("takes no F2 on the truncation marker, which offers no rename either", () => {
    // The derived event of this view's own space (ADR 0035).
    renderPanel([], { ...traceData, truncationTsNs: 3_000_000_000, count: 1, firstIndex: 1 });
    expect(screen.queryByLabelText("rename event")).toBeNull();
    cursorToFirstRow();
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

    const box = screen.getByLabelText("Bus Errors") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByLabelText("Bus Errors").closest("label")?.textContent).toContain("1");

    fireEvent.click(box);
    expect(labels()).toEqual(["bus error x40", "boom"]);
  });

  it("offers no edit controls on a host-derived event", () => {
    renderPanel([busError]);
    fireEvent.click(screen.getByLabelText("Bus Errors") as HTMLInputElement);
    expect(labels()).toEqual(["bus error x40"]);
    expect(screen.queryByLabelText("rename event")).toBeNull();
    expect(screen.queryByLabelText("remove event")).toBeNull();
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

  it("keeps the body collapsed until the row is disclosed", () => {
    renderPanel([tagged]);
    expect(screen.queryByText("opened under load")).toBeNull();
    fireEvent.click(screen.getByLabelText("show event details"));
    expect(screen.getByText("opened under load")).toBeInTheDocument();
    expect(screen.getByText("fault")).toBeInTheDocument();
    // ...and folds back up.
    fireEvent.click(screen.getByLabelText("hide event details"));
    expect(screen.queryByText("opened under load")).toBeNull();
  });

  it("edits the description in place and commits it to the host", () => {
    const ctx = notesCtx([tagged]);
    render(
      <TraceDataProvider value={traceData}>
        <NotesContext.Provider value={ctx}>
          <EventsPanel {...({} as Parameters<typeof EventsPanel>[0])} />
        </NotesContext.Provider>
      </TraceDataProvider>,
    );
    fireEvent.click(screen.getByLabelText("show event details"));
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

  it("shows a host-derived event's body but takes no edits on it", () => {
    renderPanel([
      {
        id: "e1",
        timestampNs: 4_000_000_000,
        label: "bus error x40",
        kind: "busError",
        description: "bit errors on powertrain over 1.2 s",
      },
    ]);
    fireEvent.click(screen.getByLabelText("Bus Errors") as HTMLInputElement);
    fireEvent.click(screen.getByLabelText("show event details"));
    expect(screen.getByText("bit errors on powertrain over 1.2 s")).toBeInTheDocument();
    fireEvent.click(screen.getByText("bit errors on powertrain over 1.2 s"));
    expect(screen.queryByLabelText("event description")).toBeNull();
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

  it("states its expanded state on the row the container names, not only on the caret", () => {
    // The caret is a nested node; the cursor is on the *row*, so a
    // reader following `aria-activedescendant` never reaches the caret's
    // own `aria-expanded` and was told nothing about the disclosure.
    renderPanel([tagged]);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toHaveClass("trace-event-row");
    expect(activeRow()).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    expect(activeRow()).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(grid(), { key: "ArrowLeft" });
    expect(activeRow()).toHaveAttribute("aria-expanded", "false");
  });

  it("says nothing about expansion on an event with nothing to disclose", () => {
    // The truncation marker: derived, and carrying neither tag nor
    // description, so there is no body behind it to open.
    renderPanel([], { ...traceData, truncationTsNs: 3_000_000_000, count: 1, firstIndex: 1 });
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toHaveClass("trace-event-row");
    expect(activeRow()).not.toHaveAttribute("aria-expanded");
  });

  it("advertises no selection, because an event row is not selectable", () => {
    // A frame row carries `aria-selected`; an event row is not a message
    // and takes no part in the selection (ADR 0044), so claiming the
    // attribute would say it does.
    renderPanel([tagged]);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).not.toHaveAttribute("aria-selected");
  });

  it("keeps the caret out of the tab order, so Tab lands on a control that needs it", () => {
    // The layer's Tab moves into the cursor row's first tab stop
    // (ADR 0044). The caret's job is already Left/Right's, so it opts
    // out the way every other gridview's caret does — otherwise Tab
    // spends its first press on a control the keyboard already has.
    renderPanel([tagged]);
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
  it("narrows to the events carrying a matching tag", () => {
    // jsdom lays nothing out; give the row virtualizer a viewport so all
    // three rows are drawn.
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    renderPanel([
      { id: "a", timestampNs: 1_000_000_000, label: "one", kind: "note", tag: "fault" },
      { id: "b", timestampNs: 2_000_000_000, label: "two", kind: "note", tag: "contactor" },
      { id: "c", timestampNs: 3_000_000_000, label: "three", kind: "note" },
    ]);
    const labels = () =>
      Array.from(document.querySelectorAll(".trace-event-label")).map((e) => e.textContent);
    expect(labels()).toEqual(["one", "two", "three"]);

    fireEvent.change(screen.getByLabelText("filter by tag"), { target: { value: "cont" } });
    expect(labels()).toEqual(["two"]);

    // The suggestions are the tags actually in use.
    expect(
      Array.from(document.querySelectorAll("#events-panel-tags option")).map(
        (o) => (o as HTMLOptionElement).value,
      ),
    ).toEqual(["contactor", "fault"]);

    fireEvent.change(screen.getByLabelText("filter by tag"), { target: { value: "" } });
    expect(labels()).toEqual(["one", "two", "three"]);
    ch.mockRestore();
  });
});

describe("EventsPanel record types", () => {
  it("lists both BLF annotation records and filters them apart", () => {
    // The record a kind rides is a property of the kind, so the kind
    // checklist is the record-type filter — and it names the record.
    renderPanel([
      { id: "n1", timestampNs: 1_000_000_000, label: "a marker", kind: "note" },
      { id: "c1", timestampNs: 2_000_000_000, label: "a comment", kind: "messageBound" },
    ]);
    const labels = () =>
      Array.from(document.querySelectorAll(".trace-event-label")).map((e) => e.textContent);
    expect(labels()).toEqual(["a marker", "a comment"]);
    expect(screen.getByLabelText("Notes").closest("label")?.title).toContain("GLOBAL_MARKER");
    expect(screen.getByLabelText("Comments").closest("label")?.title).toContain("EVENT_COMMENT");

    fireEvent.click(screen.getByLabelText("Notes"));
    expect(labels()).toEqual(["a comment"]);
  });
});
