// @vitest-environment jsdom
//
// The chronological view's row identity and its gridview base
// (ADR 0044). Its display positions move — the window slides as the
// capture grows and timeline events interleave — so every piece of row
// state keys by the frame's absolute index in the capture instead.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let storedSettings: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...storedSettings } : null)),
}));

import { hydrateSettings } from "./hostSettings";
import { TraceView, type EventActions } from "./TraceView";
import { defaultColumns } from "./traceColumns";
import { SIGNAL_DND_MIME } from "./dragSignals";
import type { TraceRow } from "./trace";
import type { TimelineEvent } from "./notes";
import type { TraceFrameRecord } from "./types";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const noop = () => {};

/// A frame whose arbitration id names its absolute index, so a row can
/// be identified by the frame it is showing rather than by where it sits.
function frameRow(index: number, signals = 2): TraceRow {
  return {
    row: "frame",
    frame: {
      index,
      timestamp_seconds: index / 1000,
      channel: 0,
      id: 0x100 + index,
      extended: false,
      direction: "Rx",
      kind: { kind: "classic" },
      data: [1, 2],
      decoded:
        signals === 0
          ? null
          : {
              name: `Msg${index}`,
              signals: Array.from({ length: signals }, (_, s) => ({
                name: `Sig${s}`,
                value: s,
                unit: "km/h",
                label: null,
              })),
            },
      bus_id: "b1",
    },
  } as unknown as TraceRow;
}

const EVENT_TS = 5_000_000_000;

function eventRow(id: string, label: string, editable = true): TraceRow {
  return {
    row: "event",
    event: {
      id,
      label,
      // The derived events are the ones that take no edits (ADR 0035);
      // the truncation marker is the one in this view's own space.
      kind: editable ? "note" : "truncation",
      timestampNs: EVENT_TS,
      color: null,
      editable,
      subjects: [],
    } as unknown as TimelineEvent,
  };
}

/** Minimal stand-in for the DataTransfer the drag events carry. */
function fakeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? "",
    get types() {
      return Object.keys(store);
    },
    effectAllowed: "",
    dropEffect: "",
  };
}

function view(props: {
  count: number;
  getRow: (i: number) => TraceRow | null;
  autoScroll?: boolean;
  onAutoScrollDisabled?: () => void;
  eventActions?: EventActions;
  onFrameContextMenu?: (frame: TraceFrameRecord, e: React.MouseEvent) => void;
}) {
  return (
    <TraceView
      count={props.count}
      version={0}
      autoScroll={props.autoScroll ?? false}
      baseTimestampSeconds={0}
      columns={defaultColumns()}
      onColumnResize={noop}
      onColumnToggle={noop}
      onColumnReorder={noop}
      resolveColor={null}
      busLookup={new Map([["b1", "Chassis"]])}
      getRow={props.getRow}
      ensureVisible={noop}
      onAutoScrollDisabled={props.onAutoScrollDisabled ?? noop}
      eventActions={props.eventActions}
      onFrameContextMenu={props.onFrameContextMenu}
    />
  );
}

/// The arbitration-id cell identifies which frame a row is showing.
const idOf = (el: Element | null) => el?.querySelector(".col-id")?.textContent ?? null;

function rowShowing(index: number): HTMLElement {
  const want = `s:${(0x100 + index).toString(16)}`;
  const el = [...document.querySelectorAll<HTMLElement>(".trace-row")].find(
    (r) => idOf(r) === want,
  );
  if (!el) throw new Error(`no row showing frame ${index}`);
  return el;
}

function expandedIds(): (string | null)[] {
  return [...document.querySelectorAll(".trace-row.expanded")].map(idOf);
}

let restoreHeight: (() => void) | null = null;
const VH = 440; // twenty plain rows

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const prev = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => VH });
  restoreHeight = () => Object.defineProperty(Element.prototype, "clientHeight", prev!);
  storedSettings = {};
  await hydrateSettings();
});
afterEach(() => {
  cleanup();
  restoreHeight?.();
  vi.unstubAllGlobals();
});

describe("chronological row identity", () => {
  it("keeps a row open by its frame when the display space shifts under it", () => {
    // The window slides as the capture's head is truncated, so display
    // row `d` shows a different frame from one render to the next. An
    // index-keyed expansion set opens whatever frame lands in the slot;
    // an id-keyed one follows the frame the user opened.
    const rows = (shift: number) => (d: number) => frameRow(d + shift);
    const { rerender } = render(view({ count: 10, getRow: rows(0) }));
    fireEvent.click(rowShowing(5));
    expect(expandedIds()).toEqual([`s:${(0x105).toString(16)}`]);

    rerender(view({ count: 10, getRow: rows(3) }));

    // Frame 5 now sits at display row 2 — and it is still the open one.
    expect(expandedIds()).toEqual([`s:${(0x105).toString(16)}`]);
    expect(rowShowing(5).style.top).toBe(`${2 * 22}px`);
  });

  it("shuts the row the user shut, not the slot it was in", () => {
    const rows = (shift: number) => (d: number) => frameRow(d + shift);
    const { rerender } = render(view({ count: 10, getRow: rows(0) }));
    fireEvent.click(rowShowing(5));
    rerender(view({ count: 10, getRow: rows(3) }));
    fireEvent.click(rowShowing(5));
    expect(expandedIds()).toEqual([]);
  });

  it("keeps the scroll range grown while the open row is out of the window", () => {
    // The geometry needs every open row's height, and a row scrolled out
    // of the loaded page can no longer be asked for it — so the count
    // travels with the id.
    const { container, rerender } = render(view({ count: 40, getRow: (d) => frameRow(d) }));
    const spacer = () =>
      Number.parseFloat((container.querySelector(".trace-scroll-content") as HTMLElement).style.height);
    const before = spacer();
    fireEvent.click(rowShowing(0));
    expect(spacer() - before).toBe(2 * 18);
    // The page no longer holds frame 0 at all.
    rerender(view({ count: 40, getRow: (d) => (d < 25 ? null : frameRow(d)) }));
    expect(spacer() - before).toBe(2 * 18);
  });
});

function grid(): HTMLElement {
  const el = document.querySelector(".trace-rows");
  if (!el) throw new Error("no rows container");
  return el as HTMLElement;
}

/// The row `aria-activedescendant` names, resolved through the DOM id
/// the row actually carries.
function activeRow(): HTMLElement | null {
  const id = grid().getAttribute("aria-activedescendant");
  return id == null ? null : document.getElementById(id);
}

function selectedIds(): (string | null)[] {
  return [...document.querySelectorAll('.trace-row[aria-selected="true"]')].map(idOf);
}

describe("chronological cursor and selection", () => {
  it("marks the rows viewport as a gridview and names the active row there", () => {
    render(view({ count: 10, getRow: (d) => frameRow(d) }));
    expect(grid()).toHaveAttribute("data-gridview");
    expect(grid()).toHaveAttribute("tabindex", "0");
    expect(activeRow()).toBeNull();
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toBe(rowShowing(0));
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toBe(rowShowing(1));
    fireEvent.keyDown(grid(), { key: "ArrowUp" });
    expect(activeRow()).toBe(rowShowing(0));
  });

  it("discloses the row's content with Right and retracts it with Left", () => {
    render(view({ count: 10, getRow: (d) => frameRow(d) }));
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    expect(expandedIds()).toEqual([`s:${(0x100).toString(16)}`]);
    // What it disclosed is rows: the two signals joined the space
    // (ADR 0044), and Right again steps onto the first of them.
    expect(document.querySelectorAll(".trace-content-row")).toHaveLength(2);
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    expect(activeRow()).toBe(document.querySelectorAll(".trace-content-row")[0]);
    fireEvent.keyDown(grid(), { key: "ArrowLeft" });
    expect(activeRow()).toBe(rowShowing(0));
    fireEvent.keyDown(grid(), { key: "ArrowLeft" });
    expect(expandedIds()).toEqual([]);
  });

  it("replaces on a plain click, follows the cursor, and ranges with Ctrl+Shift", () => {
    render(view({ count: 10, getRow: (d) => frameRow(d) }));
    fireEvent.click(rowShowing(3));
    expect(selectedIds()).toEqual([idOf(rowShowing(3))]);
    fireEvent.keyDown(grid(), { key: "Home" });
    expect(selectedIds()).toEqual([idOf(rowShowing(0))]);
    fireEvent.click(rowShowing(1));
    fireEvent.click(rowShowing(4), { ctrlKey: true, shiftKey: true });
    expect(selectedIds()).toHaveLength(4);
  });

  it("says where focus is on the row, not on the box, once a cursor exists", () => {
    // The container is what holds DOM focus (ADR 0044), so a UA focus
    // ring goes round the whole scroll viewport — "the entire box gets
    // highlighted". `[data-gridview][aria-activedescendant]:focus` drops
    // it in favour of the row indicator, which means what the container
    // *names* decides whether the box is ringed. Pin both states.
    render(view({ count: 10, getRow: (d) => frameRow(d, 0) }));
    grid().focus();
    // Tab in, cursor nowhere: no row is named and no row is marked, so
    // the box ring is the only focus indication there is and it stays.
    expect(document.activeElement).toBe(grid());
    expect(grid()).not.toHaveAttribute("aria-activedescendant");
    expect(document.querySelectorAll(".trace-row.selected")).toHaveLength(0);

    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(grid()).toHaveAttribute("aria-activedescendant");
    expect(activeRow()).toHaveClass("selected");

    // Left on a top-level row with nothing to collapse and no parent to
    // walk out to. The grid consumes the press either way — a no-op Left
    // must not scroll the viewport sideways instead — so nothing in the
    // panel's own markup moves, and without the rule above the container
    // ring would be the only thing on screen that changed.
    const before = document.body.innerHTML;
    fireEvent.keyDown(grid(), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(grid());
    expect(document.body.innerHTML).toBe(before);
  });

  it("takes the loaded page on Ctrl+A, not the whole capture", () => {
    // The row space is millions of host-paged rows; walking it on every
    // click is not affordable and the frontend does not hold it anyway.
    render(view({ count: 5_000_000, getRow: (d) => frameRow(d) }));
    fireEvent.keyDown(grid(), { key: "a", ctrlKey: true });
    expect(selectedIds().length).toBe(document.querySelectorAll(".trace-row").length);
  });

  it("leaves a timeline event out of the selection but on the cursor's path", () => {
    render(
      view({ count: 3, getRow: (d) => (d === 1 ? eventRow("n1", "note") : frameRow(d)) }),
    );
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toHaveClass("trace-event-row");
    expect(selectedIds()).toEqual([]);
    fireEvent.keyDown(grid(), { key: "a", ctrlKey: true });
    expect(selectedIds()).toHaveLength(2); // the two frame rows
  });

  it("releases the live pin only when the cursor has to move the window", () => {
    const released = vi.fn();
    render(
      view({
        count: 400,
        autoScroll: true,
        onAutoScrollDisabled: released,
        getRow: (d) => frameRow(d, 0),
      }),
    );
    // Placing and stepping the cursor inside the tail the view is
    // already showing leaves it pinned — the window never moves.
    const shown = [...document.querySelectorAll<HTMLElement>(".trace-row")];
    fireEvent.click(shown[1]);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    fireEvent.keyDown(grid(), { key: "ArrowUp" });
    expect(released).not.toHaveBeenCalled();
    // Home leaves the window behind, so the pin goes first — the same
    // rule the wheel follows when it scrolls back to look at history.
    fireEvent.keyDown(grid(), { key: "Home" });
    expect(released).toHaveBeenCalled();
  });
});

describe("event rows on the gridview action keys (ADR 0044)", () => {
  /// The three event-row surfaces a keypress can reach, all mocked so a
  /// test can say which one fired.
  function actions(): EventActions & { onGoto: ReturnType<typeof vi.fn> } {
    return {
      onRename: vi.fn(),
      onRecolor: vi.fn(),
      onRemove: vi.fn(),
      onGoto: vi.fn(),
      onRetag: vi.fn(),
      onDescribe: vi.fn(),
    } as EventActions & { onGoto: ReturnType<typeof vi.fn> };
  }

  /// A capture of three rows whose middle one is a timeline event.
  function withEvent(a: EventActions, editable = true) {
    return render(
      view({
        count: 3,
        getRow: (d) => (d === 1 ? eventRow("n1", "boom", editable) : frameRow(d)),
        eventActions: a,
      }),
    );
  }

  /// Put the cursor on the event row: two steps down from nothing.
  function cursorToEvent() {
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toHaveClass("trace-event-row");
  }

  it("marks the event row the cursor lands on, not only the one clicked", () => {
    // The row's own click-focus state was a second cursor beside the
    // layer's; arrowing onto the row left it unmarked, so nothing said
    // which row Space and F2 were about to act on.
    const a = actions();
    withEvent(a);
    const row = () => document.querySelector(".trace-event-row") as HTMLElement;
    expect(row()).not.toHaveClass("trace-event-focused");
    cursorToEvent();
    expect(row()).toHaveClass("trace-event-focused");
    // …and it lets go when the cursor moves off.
    fireEvent.keyDown(grid(), { key: "ArrowUp" });
    expect(row()).not.toHaveClass("trace-event-focused");
    // A click still marks it, because a click still moves the cursor.
    fireEvent.click(row());
    expect(row()).toHaveClass("trace-event-focused");
  });

  it("broadcasts the row's goto on Space, exactly as its button does", () => {
    const a = actions();
    withEvent(a);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    fireEvent.keyDown(grid(), { key: " " });
    // A frame row has no primary action of its own.
    expect(a.onGoto).not.toHaveBeenCalled();

    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    fireEvent.keyDown(grid(), { key: " " });
    expect(a.onGoto).toHaveBeenCalledWith(EVENT_TS);
    // The same call the button makes — the key is the button's keyboard
    // equivalent, not a second path with its own target.
    fireEvent.click(screen.getByLabelText("go to this event"));
    expect(a.onGoto).toHaveBeenCalledTimes(2);
    expect(a.onGoto.mock.calls[1]).toEqual(a.onGoto.mock.calls[0]);
  });

  it("begins the row's rename on F2, and commits it like the button's does", () => {
    const a = actions();
    withEvent(a);
    cursorToEvent();
    expect(screen.queryByLabelText("event label")).toBeNull();
    fireEvent.keyDown(grid(), { key: "F2" });
    const input = screen.getByLabelText("event label") as HTMLInputElement;
    expect(input.value).toBe("boom");
    fireEvent.change(input, { target: { value: "crunch" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(a.onRename).toHaveBeenCalledWith("n1", "crunch");
  });

  it("takes no F2 on a derived event, which the mouse cannot edit either", () => {
    // The gate is editability, not the keybinding: a row with no rename
    // control must not grow one because the cursor is on it.
    const a = actions();
    withEvent(a, false);
    cursorToEvent();
    expect(screen.queryByLabelText("rename event")).toBeNull();
    fireEvent.keyDown(grid(), { key: "F2" });
    expect(screen.queryByLabelText("event label")).toBeNull();
    expect(a.onRename).not.toHaveBeenCalled();
  });

  it("still goes to a derived event on Space", () => {
    // Read-only is about editing. Every event is a place in time.
    const a = actions();
    withEvent(a, false);
    cursorToEvent();
    fireEvent.keyDown(grid(), { key: " " });
    expect(a.onGoto).toHaveBeenCalledWith(EVENT_TS);
  });

  it("hands the keyboard back to the grid when the rename ends", () => {
    // The field unmounts when the edit ends, and focus with nowhere to
    // go lands on the document body — where the grid's keys are dead
    // and the next Tab restarts from the top of the page (ADR 0044).
    const a = actions();
    withEvent(a);
    cursorToEvent();
    fireEvent.keyDown(grid(), { key: "F2" });
    const input = screen.getByLabelText("event label") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("event label")).toBeNull();
    expect(document.activeElement).toBe(grid());
    // …and the cursor is still on the row that was renamed, so F2 opens
    // it again rather than nothing.
    fireEvent.keyDown(grid(), { key: "F2" });
    expect(screen.getByLabelText("event label")).toBeInTheDocument();
  });

  it("hands the keyboard back to the grid when a body field's edit ends", () => {
    // Same defect the rename field above had, one level down: the tag
    // and description editors unmount on Enter / Escape while they are
    // still the focused element, so the layer's own recovery — which
    // looks for `body` during the press — cannot see it, and focus
    // lands nowhere. The arrows are then dead until the user clicks.
    const a = actions();
    withEvent(a);
    cursorToEvent();
    fireEvent.keyDown(grid(), { key: "ArrowRight" });

    for (const [field, key] of [
      ["event tag", "Escape"],
      ["event description", "Enter"],
    ] as const) {
      const label = field === "event tag" ? "tag" : "description";
      fireEvent.click(screen.getByTitle(`click to edit the ${label}`));
      const input = screen.getByLabelText(field) as HTMLInputElement;
      input.focus();
      fireEvent.keyDown(input, { key });
      expect(screen.queryByLabelText(field)).toBeNull();
      expect(document.activeElement).toBe(grid());
    }

    // …and the cursor never left the event row, so its keys still act
    // on it rather than on nothing.
    expect(activeRow()).toHaveClass("trace-event-row");
    fireEvent.keyDown(grid(), { key: "F2" });
    expect(screen.getByLabelText("event label")).toBeInTheDocument();
  });

  it("leaves focus where the user put it when a body edit ends elsewhere", () => {
    // A click into another control ends the edit too, and that focus is
    // the user's — the recovery is only for the press that dropped it.
    const a = actions();
    withEvent(a);
    cursorToEvent();
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.click(screen.getByTitle("click to edit the tag"));
    const input = screen.getByLabelText("event tag") as HTMLInputElement;
    input.focus();
    const elsewhere = screen.getByLabelText("go to this event");
    elsewhere.focus();
    fireEvent.blur(input);
    expect(screen.queryByLabelText("event tag")).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("leaves the keys alone where the view supplies no event actions", () => {
    // The events an unwired view shows are read-only and go nowhere;
    // the keys must not half-work.
    render(
      view({ count: 3, getRow: (d) => (d === 1 ? eventRow("n1", "boom") : frameRow(d)) }),
    );
    cursorToEvent();
    fireEvent.keyDown(grid(), { key: "F2" });
    fireEvent.keyDown(grid(), { key: " " });
    expect(screen.queryByLabelText("event label")).toBeNull();
    expect(screen.queryByLabelText("go to this event")).toBeNull();
  });
});

describe("chronological content rows", () => {
  /// The rows a message discloses, by the signal name each one shows.
  function contentNames(): (string | null)[] {
    return [...document.querySelectorAll(".trace-content-row")].map(
      (el) => el.querySelector(".signal-name")?.textContent ?? null,
    );
  }

  it("selects a disclosed signal rather than collapsing the message", () => {
    render(view({ count: 10, getRow: (d) => frameRow(d) }));
    fireEvent.click(rowShowing(3));
    expect(expandedIds()).toEqual([`s:${(0x103).toString(16)}`]);

    const line = document.querySelectorAll<HTMLElement>(".trace-content-row")[1];
    fireEvent.click(line);

    // The message the user was reading is still open, and the row they
    // clicked is the one that is selected.
    expect(expandedIds()).toEqual([`s:${(0x103).toString(16)}`]);
    expect(line).toHaveAttribute("aria-selected", "true");
    expect(selectedIds()).toEqual([]); // no message row is selected
    expect(activeRow()).toBe(line);
  });

  it("still collapses the message when the message line is clicked", () => {
    render(view({ count: 10, getRow: (d) => frameRow(d) }));
    fireEvent.click(rowShowing(3));
    expect(contentNames()).toEqual(["Sig0", "Sig1"]);
    fireEvent.click(rowShowing(3).querySelector(".col-id")!);
    expect(expandedIds()).toEqual([]);
    expect(contentNames()).toEqual([]);
  });

  it("puts the disclosed rows in the space, between the message and the next", () => {
    render(view({ count: 10, getRow: (d) => frameRow(d) }));
    fireEvent.click(rowShowing(1));
    fireEvent.keyDown(grid(), { key: "Home" });
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toBe(rowShowing(1));
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()?.querySelector(".signal-name")?.textContent).toBe("Sig0");
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()?.querySelector(".signal-name")?.textContent).toBe("Sig1");
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toBe(rowShowing(2));
  });

  it("ranges across content rows like any other rows", () => {
    render(view({ count: 10, getRow: (d) => frameRow(d) }));
    fireEvent.click(rowShowing(1)); // opens it and anchors the range
    fireEvent.click(rowShowing(2), { shiftKey: true });
    // The message, the two rows it disclosed, and the message after them.
    expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(4);
  });

  it("stacks the disclosed rows under the message, one line each", () => {
    render(view({ count: 10, getRow: (d) => frameRow(d) }));
    fireEvent.click(rowShowing(2));
    const lines = [...document.querySelectorAll<HTMLElement>(".trace-content-row")];
    expect(lines.map((el) => el.style.top)).toEqual([`${2 * 22 + 22}px`, `${2 * 22 + 40}px`]);
    // The row after the open one starts below the whole block.
    expect(rowShowing(3).style.top).toBe(`${3 * 22 + 2 * 18}px`);
  });

});

describe("chronological drag identity (D9)", () => {
  it("drags the message from the row itself", () => {
    render(view({ count: 10, getRow: (d) => frameRow(d) }));
    const row = rowShowing(2);
    expect(row).toHaveAttribute("draggable", "true");
    const dt = fakeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    const payload = JSON.parse(dt.getData(SIGNAL_DND_MIME));
    expect(payload.signals).toEqual([
      {
        busId: "b1",
        messageId: 0x102,
        extended: false,
        signalName: "Sig0",
        messageName: "Msg2",
        unit: "km/h",
      },
      {
        busId: "b1",
        messageId: 0x102,
        extended: false,
        signalName: "Sig1",
        messageName: "Msg2",
        unit: "km/h",
      },
    ]);
  });

  it("drags the whole selection when the grabbed row is in it", () => {
    render(view({ count: 10, getRow: (d) => frameRow(d) }));
    fireEvent.click(rowShowing(0));
    fireEvent.click(rowShowing(2), { ctrlKey: true });
    const dt = fakeDataTransfer();
    fireEvent.dragStart(rowShowing(2), { dataTransfer: dt });
    const payload = JSON.parse(dt.getData(SIGNAL_DND_MIME));
    expect(payload.signals.map((s: { messageId: number }) => s.messageId)).toEqual([
      0x100, 0x100, 0x102, 0x102,
    ]);
  });

  it("still drags one signal from a line inside the expanded block", () => {
    render(view({ count: 10, getRow: (d) => frameRow(d) }));
    fireEvent.click(rowShowing(0));
    const line = document.querySelectorAll<HTMLElement>(".trace-content-row")[1];
    const dt = fakeDataTransfer();
    fireEvent.dragStart(line, { dataTransfer: dt });
    const payload = JSON.parse(dt.getData(SIGNAL_DND_MIME));
    expect(payload.signals.map((s: { signalName: string }) => s.signalName)).toEqual(["Sig1"]);
  });
});

describe("an error frame is not an ordinary empty data frame", () => {
  /// A bus error frame as it arrives from the host: no payload, and —
  /// with the `type` column hidden by default — nothing in the default
  /// column set that distinguishes it from a zero-byte data frame.
  function errorRow(index: number): TraceRow {
    return {
      row: "frame",
      frame: {
        index,
        timestamp_seconds: index / 1000,
        channel: 0,
        id: 0x100 + index,
        extended: false,
        direction: "Rx",
        kind: { kind: "error" },
        data: [],
        decoded: null,
        bus_id: "b1",
      },
    } as unknown as TraceRow;
  }

  /// The control: an ordinary frame that also carries no payload. If the
  /// assertions below passed for this one too they would be reading
  /// "empty", not "error".
  function emptyDataRow(index: number): TraceRow {
    return {
      row: "frame",
      frame: {
        index,
        timestamp_seconds: index / 1000,
        channel: 0,
        id: 0x100 + index,
        extended: false,
        direction: "Rx",
        kind: { kind: "classic" },
        data: [],
        decoded: null,
        bus_id: "b1",
      },
    } as unknown as TraceRow;
  }

  it("says what it is in the default columns, and marks the row", () => {
    render(view({ count: 1, getRow: () => errorRow(0) }));
    const row = rowShowing(0);
    expect(row).toHaveClass("trace-row-error-frame");
    expect(row.querySelector(".col-msg")?.textContent).toBe("Bus error");
    expect(row).toHaveAttribute("title", expect.stringContaining("error"));
  });

  it("leaves a zero-byte data frame alone", () => {
    render(view({ count: 1, getRow: () => emptyDataRow(0) }));
    const row = rowShowing(0);
    expect(row).not.toHaveClass("trace-row-error-frame");
    expect(row.querySelector(".col-msg")?.textContent).toBe("");
  });
});

describe("a frame row's context menu (ADR 0056)", () => {
  it("hands the right-clicked frame to the owner and stops there", () => {
    // The panel opens its sources picker on any right-click, so a row
    // that offers its own menu has to stop the event reaching it — the
    // column header's settled precedent.
    const onFrameContextMenu = vi.fn();
    const outer = vi.fn();
    render(
      <div onContextMenu={outer}>
        {view({ count: 5, getRow: (i) => frameRow(i), onFrameContextMenu })}
      </div>,
    );
    fireEvent.contextMenu(rowShowing(2));
    expect(onFrameContextMenu).toHaveBeenCalledTimes(1);
    expect(onFrameContextMenu.mock.calls[0][0]).toMatchObject({ index: 2, id: 0x102 });
    expect(outer).not.toHaveBeenCalled();
  });

  it("lets the right-click through when no owner wants it", () => {
    // Every other trace-like view — the events view, the by-id table —
    // keeps the panel's sources picker on every right-click.
    const outer = vi.fn();
    render(<div onContextMenu={outer}>{view({ count: 5, getRow: (i) => frameRow(i) })}</div>);
    fireEvent.contextMenu(rowShowing(2));
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("offers nothing on an event row, which is about no message", () => {
    const onFrameContextMenu = vi.fn();
    const outer = vi.fn();
    render(
      <div onContextMenu={outer}>
        {view({
          count: 1,
          getRow: () => eventRow("n1", "boom"),
          onFrameContextMenu,
        })}
      </div>,
    );
    const evRow = document.querySelector(".trace-event-row");
    expect(evRow).toBeTruthy();
    fireEvent.contextMenu(evRow!);
    expect(onFrameContextMenu).not.toHaveBeenCalled();
    expect(outer).toHaveBeenCalledTimes(1);
  });
});
