// @vitest-environment jsdom
//
// The chronological view's row identity and its gridview base
// (ADR 0044). Its display positions move — the window slides as the
// capture grows and timeline events interleave — so every piece of row
// state keys by the frame's absolute index in the capture instead.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

let storedSettings: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...storedSettings } : null)),
}));

import { hydrateSettings } from "./hostSettings";
import { TraceView } from "./TraceView";
import { defaultColumns } from "./traceColumns";
import { SIGNAL_DND_MIME } from "./dragSignals";
import type { TraceRow } from "./trace";
import type { TimelineEvent } from "./notes";

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

function eventRow(id: string, label: string): TraceRow {
  return {
    row: "event",
    event: {
      id,
      label,
      kind: "note",
      timestampNs: 0,
      color: null,
      editable: true,
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
