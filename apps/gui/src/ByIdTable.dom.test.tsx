// @vitest-environment jsdom
//
// Consumption test for signal value→color maps (ADR 0029): an expanded
// by-id row tints its decoded signal-value cell when the resolver
// returns a color, and leaves it untinted otherwise. The resolver and
// tint string are unit-tested in colorMap.test.ts; this guards that the
// row renderer actually applies them.
//
// Also the scroll geometry of an expanded row. jsdom does no layout, so
// these assert the heights the component *writes* — the scroll spacer
// and the sticky viewport — not what a browser would paint from them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

/// The `id` column's format is the `can_id_format` setting.
let storedSettings: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...storedSettings } : null)),
}));

import { hydrateSettings } from "./hostSettings";
import { ByIdTable } from "./ByIdTable";
import { byIdRowKey } from "./ByIdTable";
import { contentWidth, defaultColumns } from "./traceColumns";
import { ROW_HEIGHT, SIGNAL_LINE_HEIGHT } from "./traceViewport";
import type { ByIdSnapshotRecord, TraceFrameRecord } from "./types";
import type { ColorResolver } from "./colorMap";

const frame: TraceFrameRecord = {
  index: 0,
  timestamp_seconds: 0,
  channel: 0,
  id: 0x100,
  extended: false,
  direction: "Rx",
  kind: { kind: "classic" },
  data: [2],
  decoded: { name: "GearBox", signals: [{ name: "Gear", value: 2, unit: "", label: "Drive" }] },
  bus_id: "b1",
};
const row: ByIdSnapshotRecord = { frame, rate: 0, count: 1 };

// ByIdTable virtualizes (like TraceView), so it needs a ResizeObserver.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderTable(resolveColor: ColorResolver | null) {
  return render(
    <ByIdTable
      count={1}
      version={0}
      getRow={(i) => (i === 0 ? row : null)}
      ensureVisible={() => {}}
      columns={defaultColumns()}
      onColumnResize={() => {}}
      onColumnToggle={() => {}}
      onColumnReorder={() => {}}
      resolveColor={resolveColor}
      sort={null}
      onSortColumn={() => {}}
      baseTimestamp={0}
      busLookup={new Map([["b1", "Chassis"]])}
      expanded={new Set([byIdRowKey(frame)])}
      onToggleExpand={() => {}}
    />,
  );
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  storedSettings = {};
  await hydrateSettings();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ByIdTable id column", () => {
  it("spells the arbitration id the way can_id_format says", async () => {
    // The by-id table shares `cellContent` with the chronological
    // trace but reads the setting itself, so it needs its own guard.
    storedSettings = { can_id_format: "decimal" };
    await hydrateSettings();
    const { container } = renderTable(null);
    expect(container.querySelector(".trace-row .col-id")?.textContent).toBe("s:256");
  });
});

describe("ByIdTable scroll extent", () => {
  /// A snapshot of `count` ids, all decoding to `signals` signals.
  function manyRows(count: number, signals: number) {
    const rows: ByIdSnapshotRecord[] = Array.from({ length: count }, (_, i) => ({
      frame: {
        ...frame,
        id: 0x100 + i,
        decoded: {
          name: "GearBox",
          signals: Array.from({ length: signals }, (_, s) => ({
            name: `Sig${s}`,
            value: s,
            unit: "",
            label: null,
          })),
        },
      },
      rate: 0,
      count: 1,
    }));
    return rows;
  }

  function renderRows(rows: ByIdSnapshotRecord[], expanded: Set<string>) {
    return render(
      <ByIdTable
        count={rows.length}
        version={0}
        getRow={(i) => rows[i] ?? null}
        ensureVisible={() => {}}
        columns={defaultColumns()}
        onColumnResize={() => {}}
        onColumnToggle={() => {}}
        onColumnReorder={() => {}}
        resolveColor={null}
        sort={null}
        onSortColumn={() => {}}
        baseTimestamp={0}
        busLookup={new Map([["b1", "Chassis"]])}
        expanded={expanded}
        onToggleExpand={() => {}}
      />,
    );
  }

  const VH = 220; // ten plain rows

  it("grows the scroll spacer by the expanded rows' signal lines", () => {
    // Ten plain rows exactly fill the viewport; expanding one adds six
    // signal lines that have to be inside the scroll range, or nothing
    // below the expanded row can ever be reached.
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(VH);
    const rows = manyRows(10, 6);
    const { container } = renderRows(rows, new Set([byIdRowKey(rows[3].frame)]));
    const spacer = container.querySelector(".trace-rows > div") as HTMLElement;
    expect(spacer.style.height).toBe(
      `${10 * ROW_HEIGHT + 6 * SIGNAL_LINE_HEIGHT}px`,
    );
  });

  it("grows the sticky viewport to the rendered stack, so nothing is clipped away", () => {
    // The sticky element clips (`overflow: hidden`), so it must be at
    // least as tall as the rows stacked inside it.
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(VH);
    const rows = manyRows(10, 6);
    const { container } = renderRows(rows, new Set([byIdRowKey(rows[0].frame)]));
    const sticky = container.querySelector(".trace-rows > div > div") as HTMLElement;
    // Everything stacked inside it: the message rows and the rows they
    // disclosed alike.
    const stack = [
      ...container.querySelectorAll<HTMLElement>(".trace-row, .trace-content-row"),
    ].reduce((h, el) => h + parseFloat(el.style.height), 0);
    expect(stack).toBeGreaterThan(VH);
    expect(parseFloat(sticky.style.height)).toBe(stack);
  });

  it("keeps a plain snapshot's spacer at the plain-row extent", () => {
    // Nothing expanded: the spacer is the snapshot at one row each, and
    // the sticky viewport still covers everything rendered into it.
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(VH);
    const rows = manyRows(40, 6);
    const { container } = renderRows(rows, new Set());
    const spacer = container.querySelector(".trace-rows > div") as HTMLElement;
    const sticky = container.querySelector(".trace-rows > div > div") as HTMLElement;
    const stack = [...container.querySelectorAll<HTMLElement>(".trace-row")].reduce(
      (h, el) => h + parseFloat(el.style.height),
      0,
    );
    expect(spacer.style.height).toBe(`${40 * ROW_HEIGHT}px`);
    expect(parseFloat(sticky.style.height)).toBeGreaterThanOrEqual(stack);
  });

  // The rows are absolutely positioned against the sticky viewport and
  // the viewport clips, so the scrolled content has to carry the
  // columns' own total width or the columns past the panel's right edge
  // are cut off with nothing to scroll. jsdom does no layout: this
  // asserts the width the view publishes, not the scrollbar it earns.
  it("publishes the columns' total width to the rows' scrolled content", () => {
    const { container } = renderTable(null);
    const content = container.querySelector(".trace-scroll-content") as HTMLElement;
    expect(content).toBeTruthy();
    expect(content.style.getPropertyValue("--trace-content-width")).toBe(
      `${contentWidth(defaultColumns())}px`,
    );
  });
});

// A message's decoded signals fold under its ID row, and the *row* is
// the control: click it, or focus it and press Enter / Space. There is
// no caret — a glyph mid-row, beside the message name, said nothing
// about what it did. A row with nothing to expand claims nothing: no
// tab stop, no `aria-expanded`.
describe("ByIdTable row disclosure", () => {
  function renderRow(
    expanded: boolean,
    onToggleExpand: (rowKey: string) => void,
    r: ByIdSnapshotRecord = row,
  ) {
    return render(
      <ByIdTable
        count={1}
        version={0}
        getRow={(i) => (i === 0 ? r : null)}
        ensureVisible={() => {}}
        columns={defaultColumns()}
        onColumnResize={() => {}}
        onColumnToggle={() => {}}
        onColumnReorder={() => {}}
        resolveColor={null}
        sort={null}
        onSortColumn={() => {}}
        baseTimestamp={0}
        busLookup={new Map([["b1", "Chassis"]])}
        expanded={expanded ? new Set([byIdRowKey(r.frame)]) : new Set()}
        onToggleExpand={onToggleExpand}
      />,
    );
  }

  it("carries no caret and no button in the message cell", () => {
    const { container } = renderRow(false, () => {});
    const msg = container.querySelector(".trace-row .col-msg") as HTMLElement;
    expect(msg.querySelector("button")).toBeNull();
    // The cell is the message name and nothing else — no ▸ / ▾.
    expect(msg.textContent).toBe("GearBox");
  });

  it("keeps the name alone when the row is open, too", () => {
    const { container } = renderRow(true, () => {});
    const msg = container.querySelector(".trace-row .col-msg") as HTMLElement;
    expect(msg.textContent).toBe("GearBox");
    expect(container.querySelector(".trace-row button")).toBeNull();
  });

  it("makes the row itself the focusable control, with aria-expanded on it", () => {
    const collapsed = renderRow(false, () => {});
    const shut = collapsed.container.querySelector(".trace-row") as HTMLElement;
    expect(shut).toHaveAttribute("tabindex", "0");
    expect(shut).toHaveAttribute("aria-expanded", "false");
    cleanup();
    const open = renderRow(true, () => {});
    expect(open.container.querySelector(".trace-row")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("toggles from the keyboard on Enter and on Space", () => {
    const onToggle = vi.fn();
    const { container } = renderRow(false, onToggle);
    const el = container.querySelector(".trace-row") as HTMLElement;
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.keyDown(el, { key: " " });
    expect(onToggle.mock.calls).toEqual([[byIdRowKey(frame)], [byIdRowKey(frame)]]);
    // Something the row does not answer for leaves it alone.
    fireEvent.keyDown(el, { key: "a" });
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("keeps the mouse path unchanged", () => {
    const onToggle = vi.fn();
    const { container } = renderRow(false, onToggle);
    fireEvent.click(container.querySelector(".trace-row")!);
    expect(onToggle.mock.calls).toEqual([[byIdRowKey(frame)]]);
  });

  it("claims nothing on a row with nothing to expand", () => {
    const undecoded: ByIdSnapshotRecord = {
      frame: { ...frame, decoded: null },
      rate: 0,
      count: 1,
    };
    const onToggle = vi.fn();
    const { container } = renderRow(false, onToggle, undecoded);
    const el = container.querySelector(".trace-row") as HTMLElement;
    expect(el).not.toHaveAttribute("tabindex");
    expect(el).not.toHaveAttribute("aria-expanded");
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.click(el);
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("ByIdTable color-map tint", () => {
  it("tints the signal-value cell when a colormap matches the value", () => {
    const resolve: ColorResolver = (t, v) =>
      t.signalName === "Gear" && v === 2 ? "#abcdef" : null;
    const { container } = renderTable(resolve);
    const value = container.querySelector(".signal-value") as HTMLElement;
    expect(value).toBeTruthy();
    // #abcdef → rgb(171, 205, 239) at low opacity.
    expect(value.style.background).toContain("rgba(171, 205, 239");
  });

  it("leaves the cell untinted when nothing matches", () => {
    const { container } = renderTable(() => null);
    const value = container.querySelector(".signal-value") as HTMLElement;
    expect(value.style.background).toBe("");
  });
});
