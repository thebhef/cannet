// @vitest-environment jsdom
//
// The header status bar, driven to widths a browser would have to be
// resized to reach. jsdom does no layout, so the element sizes the bar
// measures are stubbed per element: the point of the test is that the
// bar reads *some* measurement and removes the right things, and a run
// that only ever showed "everything fits" would prove nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import css from "./index.css?raw";
import { StatusBar, type StatusBarChip } from "./StatusBar";
import type { ConnectionSummary } from "./connectionStates";
import type { StatusMetric } from "./statusLine";

// --- stubbed layout -------------------------------------------------
//
// Every measured element answers from this map. The bar reads
// `clientWidth`, the lead cluster and each droppable item read
// `offsetWidth`, and the notice reads `scrollWidth`; each element uses
// exactly one of the three, so one map covers all of them.
const layout = { bar: 0, lead: 0, notice: 0 } as Record<string, number>;

function sizeOf(el: HTMLElement): number {
  const key = el.dataset.toolbarFit;
  if (key !== undefined) return layout[key] ?? 0;
  if (el.classList.contains("status-bar")) return layout.bar;
  if (el.classList.contains("status-bar-lead")) return layout.lead;
  if (el.classList.contains("status")) return layout.notice;
  return 0;
}

let resizeCallbacks: (() => void)[] = [];

class ControllableResizeObserver {
  constructor(private readonly cb: () => void) {
    resizeCallbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallbacks = resizeCallbacks.filter((c) => c !== this.cb);
  }
}

/// Set the bar's own width and let it re-measure, the way a window
/// resize would.
function resizeBarTo(width: number): void {
  layout.bar = width;
  act(() => {
    for (const cb of resizeCallbacks) cb();
  });
}

beforeEach(() => {
  for (const key of Object.keys(layout)) delete layout[key];
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
  for (const prop of ["offsetWidth", "clientWidth", "scrollWidth"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return sizeOf(this);
      },
    });
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const prop of ["offsetWidth", "clientWidth", "scrollWidth"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value: 0 });
  }
});

// --- the bar under test ---------------------------------------------

const CONNECTION: ConnectionSummary = {
  state: "connected",
  label: "Connected",
  count: "5 / 5",
  detail: "Powertrain: connected",
  action: "disconnect",
  actionLabel: "Disconnect",
};

const METRICS: StatusMetric[] = [
  { id: "fps", value: "18.4k", label: "f/s" },
  { id: "busLoad", value: "34 %", label: "bus load", live: true },
  { id: "frames", value: "1,234,567", label: "frames" },
  { id: "elapsed", value: "41:07", label: "elapsed" },
  { id: "ram", value: "4.2 GB", label: "RAM" },
  { id: "cache", value: "12.1 GB", label: "cache" },
];

const presses: string[] = [];

function chips(): StatusBarChip[] {
  return [
    { id: "system", label: "System messages", badge: 2, onPress: () => presses.push("system") },
    { id: "signals", label: "Signal mapping", badge: 4, onPress: () => presses.push("signals") },
    { id: "rbs", label: "RBS mapping", badge: 3, onPress: () => presses.push("rbs") },
  ];
}

/// Render the bar with every droppable item 100 wide, a 200-wide lead
/// cluster, a notice with no natural width, and a 50-wide overflow
/// control.
function renderBar(barWidth: number, over: Partial<Parameters<typeof StatusBar>[0]> = {}) {
  layout.lead = 200;
  layout.notice = 0;
  layout.overflow = 50;
  for (const m of METRICS) layout[`metric:${m.id}`] = 100;
  for (const c of chips()) layout[`chip:${c.id}`] = 100;
  layout.bar = barWidth;
  return render(
    <StatusBar
      connection={CONNECTION}
      onConnectionPress={() => presses.push("connection")}
      statusText=""
      metrics={METRICS}
      metricsTooltip="18.4k f/s\n34 % bus load"
      chips={chips()}
      {...over}
    />,
  );
}

function visibleMetrics(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".status-bar > .status-metric")).map(
    (el) => el.dataset.toolbarFit!.replace("metric:", ""),
  );
}

function pinnedChips(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".status-bar-pinned")).map(
    (el) => el.textContent ?? "",
  );
}

function menuChips(): string[] {
  return Array.from(document.querySelectorAll("ul.status-bar-menu li")).map(
    (el) => el.textContent ?? "",
  );
}

describe("StatusBar", () => {
  it("carries the bus-health launcher when there is a health model behind it", () => {
    // The launcher was built with nothing to feed it. Given a model it
    // sits in the bar beside the connection chip, tinted and counted.
    renderBar(2000, {
      busHealth: {
        concerns: [{ bus: "Body", state: "bus-off", busOff: true }],
        onOpen: () => presses.push("bus-health"),
      },
    });
    const launcher = document.querySelector<HTMLElement>(".bus-health-launcher");
    expect(launcher).not.toBeNull();
    expect(launcher).toHaveAttribute("data-state", "failed");
    expect(launcher).toHaveAttribute("title", "Bus health — Body is bus-off");
    fireEvent.click(launcher!);
    expect(presses).toContain("bus-health");
  });

  it("leaves the launcher out entirely when nothing reports bus health", () => {
    // The control: an always-present, always-neutral icon would be
    // decoration rather than a readout.
    renderBar(2000);
    expect(document.querySelector(".bus-health-launcher")).toBeNull();
  });

  afterEach(() => {
    presses.length = 0;
  });

  it("shows every metric and every pinned chip when the bar is roomy", () => {
    // 200 lead + 600 metrics + 300 chips.
    renderBar(1100);
    expect(visibleMetrics()).toEqual(["fps", "busLoad", "frames", "elapsed", "ram", "cache"]);
    expect(pinnedChips()).toEqual([
      "System messages2",
      "Signal mapping4",
      "RBS mapping3",
    ]);
    expect(document.querySelector(".status-bar-overflow")).toBeNull();
  });

  it("drops metrics from the right and collapses chips from the right as the window narrows", () => {
    renderBar(1100);

    // 200 lead + 400 metrics + 200 chips + 50 overflow = 850.
    resizeBarTo(850);
    expect(visibleMetrics()).toEqual(["fps", "busLoad", "frames", "elapsed"]);
    expect(pinnedChips()).toEqual(["System messages2", "Signal mapping4"]);
    // Only what is actually inside the menu is summed.
    expect(screen.getByRole("button", { name: /More status chips \(3 need attention\)/ })).toBeInTheDocument();

    // 200 lead + 200 metrics + 0 chips + 50 overflow = 450.
    resizeBarTo(450);
    expect(visibleMetrics()).toEqual(["fps", "busLoad"]);
    expect(pinnedChips()).toEqual([]);
    expect(screen.getByRole("button", { name: /More status chips \(9 need attention\)/ })).toBeInTheDocument();
  });

  it("puts back what fits again when the window widens", () => {
    renderBar(450);
    expect(visibleMetrics()).toEqual(["fps", "busLoad"]);
    resizeBarTo(1100);
    expect(visibleMetrics()).toEqual(["fps", "busLoad", "frames", "elapsed", "ram", "cache"]);
    expect(pinnedChips()).toHaveLength(3);
    expect(document.querySelector(".status-bar-overflow")).toBeNull();
  });

  it("collapses the pinned chips into a menu rather than losing them", () => {
    renderBar(450);
    expect(menuChips()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /More status chips/ }));
    expect(menuChips()).toEqual([
      "System messages2",
      "Signal mapping4",
      "RBS mapping3",
    ]);
    fireEvent.click(screen.getAllByRole("button", { name: "RBS mapping" })[0]);
    expect(presses).toEqual(["rbs"]);
  });

  it("keeps the whole readout on every metric label, dropped metrics included", () => {
    renderBar(450);
    const labels = Array.from(document.querySelectorAll(".status-metric > span"));
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label).toHaveAttribute("title", "18.4k f/s\\n34 % bus load");
    }
  });

  it("presses the connection chip through to its action", () => {
    renderBar(1100);
    fireEvent.click(screen.getByRole("button", { name: "Connected 5 / 5 — Disconnect" }));
    expect(presses).toEqual(["connection"]);
  });

  it("does not offer a press when the project binds no interface", () => {
    renderBar(1100, {
      connection: {
        state: "idle",
        label: "Not connected",
        count: null,
        detail: "No interface bindings — add one in the project panel first.",
        action: null,
        actionLabel: "Connect",
      },
    });
    expect(screen.getByRole("button", { name: "Not connected — Connect" })).toBeDisabled();
  });

  it("carries a notice and its buttons in the bar", () => {
    renderBar(1100, {
      notices: <button type="button">Reload</button>,
      statusText: "Project changed on disk",
    });
    expect(screen.getByText("Project changed on disk")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("gives the notice room before the numbers give way", () => {
    renderBar(1100, { statusText: "Streaming from 2 servers (5 interfaces)" });
    // Everything fits while the notice wants nothing.
    expect(visibleMetrics()).toHaveLength(6);
    // A notice with real natural width is guaranteed its own space:
    // 200 lead + 180 notice reserve leaves 720 of the same 1100, which
    // is two metrics and a chip's worth less than the bar was showing.
    layout.notice = 400;
    resizeBarTo(1100);
    expect(visibleMetrics()).toEqual(["fps", "busLoad", "frames", "elapsed"]);
    expect(pinnedChips()).toHaveLength(2);
  });

  it("never wraps, and never clips — a clipping bar swallows its own dropdown", () => {
    const start = css.indexOf("\n.status-bar {");
    expect(start).toBeGreaterThan(-1);
    const decls = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", css.indexOf("{", start)));
    expect(decls).toContain("flex-wrap: nowrap");
    expect(decls).not.toContain("overflow");
  });
});
