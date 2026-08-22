// @vitest-environment jsdom
//
// The plot toolbar, driven with a spy for every callback. The bar is
// pinned against the literal table below rather than against the array
// the component renders from — a test that reads the component's own
// list cannot tell "this chip moved" from "this chip was always here".
//
// What jsdom cannot do is lay anything out, so nothing here proves the
// bar *fits*; the overflow arithmetic is `useToolbarFit`'s test, driven
// at widths this file supplies in the "spills" block at the bottom.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";

import { PlotToolbar, plotToolbarItems, type PlotToolbarProps } from "./PlotToolbar";

afterEach(cleanup);

/// Every callback the bar can reach, so a press can be attributed.
function spies() {
  return {
    onAddArea: vi.fn(),
    onFitX: vi.fn(),
    onFitY: vi.fn(),
    onFollowLive: vi.fn(),
    onShowPoints: vi.fn(),
    onCursorMode: vi.fn(),
    onClearCursors: vi.fn(),
    onOpenMenu: vi.fn(),
    onPattern: vi.fn(),
    onStep: vi.fn(),
    onClear: vi.fn(),
    onOpenMatches: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onTraceClear: vi.fn(),
    onAllData: vi.fn(),
  };
}

type Spies = ReturnType<typeof spies>;

function props(s: Spies, over: Partial<PlotToolbarProps> = {}): PlotToolbarProps {
  return {
    traceControls: {
      status: "stopped",
      onStart: s.onStart,
      onStop: s.onStop,
      onPause: s.onPause,
      onResume: s.onResume,
      onClear: s.onTraceClear,
      onAllData: s.onAllData,
    },
    onAddArea: s.onAddArea,
    onFitX: s.onFitX,
    onFitY: s.onFitY,
    followLive: true,
    onFollowLive: s.onFollowLive,
    showPoints: "auto",
    onShowPoints: s.onShowPoints,
    solo: {
      pattern: "",
      invalid: false,
      pages: 0,
      positionLabel: "",
      hasMatches: false,
      inputRef: createRef<HTMLInputElement>(),
      onPattern: s.onPattern,
      onStep: s.onStep,
      onClear: s.onClear,
      onOpenMatches: s.onOpenMatches,
    },
    cursorMode: "off",
    onCursorMode: s.onCursorMode,
    onClearCursors: s.onClearCursors,
    perfText: null,
    onOpenMenu: s.onOpenMenu,
    ...over,
  };
}

function renderBar(over: Partial<PlotToolbarProps> = {}): Spies {
  cleanup();
  const s = spies();
  render(<PlotToolbar {...props(s, over)} />);
  return s;
}

/// The chips on the bar with no solo pattern typed, in order: their
/// accessible name and the tooltip behind it.
const BAR: readonly [string, string][] = [
  ["Fit Data", "fit x axis to the data"],
  [
    "Fit Y",
    "fit each area's y-axis to its currently visible data — useful after zooming in",
  ],
  ["Add Plot Area", "add plot area"],
  ["Follow Live", "follow the live edge"],
  ["Show Points", null as unknown as string],
  ["X Cursors", "x cursors — vertical A / B lines placed on click"],
  ["Y Cursors", "y cursors — horizontal H1 / H2 lines placed on click"],
  ["Notes", "notes — click places a timeline note"],
  ["Clear Cursors", "remove all placed cursors"],
];

/// The chips actually on the bar, in DOM order — the run controls are
/// still the shipped buttons and are not chips yet, so they are skipped
/// by asking for chips specifically.
function chips(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(".plot-panel-toolbar .chip-button"),
  );
}

function names(): string[] {
  return chips().map((c) => c.getAttribute("aria-label") ?? "");
}

describe("PlotToolbar", () => {
  it("carries every plot command, in order, on chips", () => {
    renderBar();
    expect(names()).toEqual(BAR.map(([name]) => name));
    for (const [name, title] of BAR) {
      if (title === null) continue;
      expect(screen.getByRole("button", { name }), name).toHaveAttribute("title", title);
    }
  });

  it("no longer offers a signal-catalog reload", () => {
    // Retired: everything it could do the catalog context already does
    // on its own. Pinned so it cannot come back by habit.
    renderBar();
    for (const chip of chips()) {
      expect(chip.getAttribute("title") ?? "").not.toMatch(/reload/i);
      expect(chip.getAttribute("aria-label") ?? "").not.toMatch(/reload/i);
    }
  });

  it("offers no measurements toggle anywhere on the bar", () => {
    // The strip needs rework and stays hidden until it gets it, so the
    // bar carries no way to turn it on.
    renderBar();
    expect(document.querySelector(".plot-panel-toolbar")!.textContent).not.toMatch(
      /measurement/i,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("runs each command from its own chip", () => {
    const s = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Fit Data" }));
    expect(s.onFitX).toHaveBeenCalledTimes(1);
    expect(s.onFitY).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fit Y" }));
    expect(s.onFitY).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
    expect(s.onAddArea).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear Cursors" }));
    expect(s.onClearCursors).toHaveBeenCalledTimes(1);
  });

  it("says whether it is following the live edge, and toggles it", () => {
    const s = renderBar();
    const follow = screen.getByRole("button", { name: "Follow Live" });
    expect(follow).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(follow);
    expect(s.onFollowLive).toHaveBeenCalledWith(false);

    const off = renderBar({ followLive: false });
    expect(screen.getByRole("button", { name: "Follow Live" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Follow Live" }));
    expect(off.onFollowLive).toHaveBeenCalledWith(true);
  });

  it("cycles the points setting through its three states on one chip", () => {
    // A dropdown spends two clicks and a popup on three states nobody
    // hunts for. The chip says which state it is in and steps to the
    // next one.
    for (const [from, label, to] of [
      ["auto", "Points: Auto", "off"],
      ["off", "Points: Off", "on"],
      ["on", "Points: On", "auto"],
    ] as const) {
      const s = renderBar({ showPoints: from });
      const chip = screen.getByRole("button", { name: "Show Points" });
      expect(chip, from).toHaveTextContent(label);
      fireEvent.click(chip);
      expect(s.onShowPoints, from).toHaveBeenCalledWith(to);
    }
  });

  describe("cursor modes", () => {
    it("shows which mode is on, one segment at a time", () => {
      renderBar({ cursorMode: "y" });
      expect(screen.getByRole("button", { name: "X Cursors" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(screen.getByRole("button", { name: "Y Cursors" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Notes" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      // One segmented group, not three loose toggles.
      expect(screen.getByRole("group", { name: "Cursor Mode" })).toBeInTheDocument();
    });

    it("switches to a mode when it is off", () => {
      for (const [name, mode] of [
        ["X Cursors", "x"],
        ["Y Cursors", "y"],
        ["Notes", "note"],
      ] as const) {
        const s = renderBar({ cursorMode: "off" });
        fireEvent.click(screen.getByRole("button", { name }));
        expect(s.onCursorMode, name).toHaveBeenCalledWith(mode);
      }
    });

    it("turns the mode off when the one that is on is pressed again", () => {
      // Without this there is no way back to "off" at all: the segment
      // has no fourth position, deliberately. A test that only checked
      // each mode activates would pass over a segment that cannot be
      // switched off.
      for (const [name, mode] of [
        ["X Cursors", "x"],
        ["Y Cursors", "y"],
        ["Notes", "note"],
      ] as const) {
        const s = renderBar({ cursorMode: mode });
        fireEvent.click(screen.getByRole("button", { name }));
        expect(s.onCursorMode, name).toHaveBeenCalledWith("off");
      }
    });
  });

  describe("the solo control", () => {
    const withPattern = (over: Partial<PlotToolbarProps["solo"]> = {}) =>
      renderBar({
        solo: {
          ...props(spies()).solo,
          pattern: "BMS",
          pages: 3,
          positionLabel: "page 1 / 3",
          hasMatches: true,
          ...over,
        },
      });

    it("is a field alone until there is a pattern to page through", () => {
      renderBar();
      expect(screen.getByLabelText("solo pattern")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "next solo match" })).toBeNull();
      expect(screen.queryByRole("button", { name: "clear solo" })).toBeNull();
    });

    it("grows its paging and its clear once a pattern is typed", () => {
      withPattern();
      expect(screen.getByRole("button", { name: "previous solo match" })).toBeInTheDocument();
      expect(screen.getByLabelText("solo position")).toHaveTextContent("page 1 / 3");
      expect(screen.getByRole("button", { name: "next solo match" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "clear solo" })).toBeInTheDocument();
    });

    it("hides its paging while the pattern does not parse", () => {
      withPattern({ invalid: true });
      expect(screen.getByText("bad regex")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "next solo match" })).toBeNull();
      // Clearing a bad pattern is exactly what is wanted, so that stays.
      expect(screen.getByRole("button", { name: "clear solo" })).toBeInTheDocument();
    });

    it("cannot step a pattern with no pages", () => {
      withPattern({ pages: 0 });
      expect(screen.getByRole("button", { name: "next solo match" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "previous solo match" })).toBeDisabled();
    });
  });

  it("opens the panel menu on a right-click, at the pointer", () => {
    const s = renderBar();
    fireEvent.contextMenu(document.querySelector(".plot-panel-toolbar")!, {
      clientX: 40,
      clientY: 12,
    });
    expect(s.onOpenMenu).toHaveBeenCalledWith({ x: 40, y: 12 });
  });

  it("keeps the performance read-out off until it is asked for", () => {
    // Hidden by default: it is a diagnostic, and its numbers change
    // width every tick beside controls that must not move.
    renderBar();
    expect(document.querySelector(".plot-perf")).toBeNull();
    renderBar({ perfText: "30 Hz · 2 ms" });
    const perf = document.querySelector(".plot-perf")!;
    expect(perf).toHaveTextContent("30 Hz · 2 ms");
    // A read-out, not a command — nothing about it invites a press.
    expect(perf.tagName).toBe("SPAN");
  });

  describe("what the fit planner is told", () => {
    // `plotToolbarItems` is the bar as the planner sees it: order, and
    // which items are tied together. jsdom lays nothing out, so this is
    // the only place the *clustering* can be checked at this bar — and
    // it has to be checked here, because the planner supporting
    // clusters proves nothing about this bar passing it any.
    const items = (over: Partial<PlotToolbarProps> = {}) => {
      const { onOpenMenu: _drop, ...rest } = props(spies(), over);
      return plotToolbarItems(rest);
    };

    it("ties the solo field, its paging and its clear into one cluster", () => {
      const solo = items({
        solo: { ...props(spies()).solo, pattern: "BMS", pages: 2, hasMatches: true },
      }).filter((i) => i.key.startsWith("solo:"));
      expect(solo.map((i) => i.key)).toEqual(["solo:field", "solo:paging", "solo:clear"]);
      // One id, on all three, and contiguous — which is what the
      // planner's contract needs to remove them together.
      expect(solo.map((i) => i.cluster)).toEqual(["solo", "solo", "solo"]);
    });

    it("puts the solo cluster left of Add Plot Area, so the bar gives it up last", () => {
      const keys = items({
        solo: { ...props(spies()).solo, pattern: "BMS", pages: 2, hasMatches: true },
      }).map((i) => i.key);
      expect(keys.indexOf("solo:field")).toBeLessThan(keys.indexOf("add-area"));
      // …and everything that is not the run controls or the fits is to
      // its right, which is the order in which they give way.
      expect(keys).toEqual([
        "run",
        "fit-x",
        "fit-y",
        "solo:field",
        "solo:paging",
        "solo:clear",
        "add-area",
        "follow",
        "points",
        "cursor-mode",
        "clear-cursors",
      ]);
    });

    it("ties nothing else together", () => {
      for (const item of items()) {
        if (item.key.startsWith("solo:")) continue;
        expect(item.cluster, item.key).toBeUndefined();
      }
    });
  });
});
