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
import type { TraceRow } from "./trace";

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
