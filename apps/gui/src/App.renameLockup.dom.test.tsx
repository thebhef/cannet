// @vitest-environment jsdom
//
// DIAGNOSTIC HARNESS (investigation of "GUI locks up on first rename
// keystroke while streaming"). Mounts the REAL App — real contexts,
// real dockview wiring, real effects — with the Tauri IPC mocked, puts
// it into a streaming-session state via synthetic `trace-grew` events,
// then types one character into the project panel's inline rename
// input. If the rename keystroke triggers an unbounded update loop,
// this test hangs or trips React's max-update-depth; either way the
// per-keystroke fan-out (re-renders, host invokes) is measured and
// printed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// ---- Tauri IPC mocks --------------------------------------------------

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
function emitTauri(event: string, payload: unknown) {
  for (const h of listeners.get(event) ?? []) h({ payload });
}

const invokeLog: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    invokeLog.push(cmd);
    switch (cmd) {
      case "fetch_system_log":
      case "fetch_notes":
      case "fetch_trace_range":
      case "list_transmit_frames":
      case "list_signals":
      case "rbs_dirty":
        return [];
      case "fetch_filtered_trace":
      case "fetch_by_id_page":
        return { count: 0, start: 0, rows: [] };
      case "app_version":
        return "0.0.0-test";
      case "get_sidecar_status":
        return { phase: "offline", address: null };
      default:
        return null;
    }
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    const arr = listeners.get(event) ?? [];
    arr.push(handler);
    listeners.set(event, arr);
    return () => {
      const a = listeners.get(event) ?? [];
      const i = a.indexOf(handler);
      if (i >= 0) a.splice(i, 1);
    };
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
    onResized: async () => () => {},
    isMaximized: async () => false,
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    destroy: async () => {},
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

// uPlot touches `matchMedia` at import time, which jsdom lacks — same
// stub the PlotPanel dom test uses. The plot panel isn't part of the
// seeded layout, but App imports it (and thus uplot) unconditionally.
vi.mock("uplot", () => {
  class FakeUPlot {
    over = document.createElement("div");
    scales = { x: {}, y: {} } as Record<string, { min?: number; max?: number }>;
    data: unknown = [[]];
    width = 600;
    constructor(_opts: unknown, data: unknown, el: HTMLElement) {
      this.data = data;
      el.appendChild(document.createElement("canvas"));
    }
    setData(d: unknown) {
      this.data = d;
    }
    setScale() {}
    setSeries() {}
    setSelect() {}
    setSize() {}
    redraw() {}
    destroy() {}
    posToVal() {
      return 0;
    }
    valToPos() {
      return 0;
    }
  }
  return { default: FakeUPlot };
});
vi.mock("uplot/dist/uPlot.min.css", () => ({}));

import { StrictMode } from "react";

import type { TraceFrameRecord, TraceGrew } from "./types";
import { App } from "./App";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function frame(index: number): TraceFrameRecord {
  return {
    index,
    timestamp_seconds: 1000 + index / 1000,
    channel: 0,
    id: 0x100 + (index % 16),
    extended: false,
    direction: "Rx",
    kind: "classic" as unknown as TraceFrameRecord["kind"],
    data: [index % 256, 0, 0, 0],
    decoded: null,
    bus_id: "b1",
  };
}

function grew(count: number): TraceGrew {
  const tailLen = Math.min(256, count);
  return {
    count,
    first_index: 0,
    frames_per_second: 1000,
    frames_per_second_rx: 1000,
    frames_per_second_tx: 0,
    frames_per_second_by_bus: [{ bus_id: null, frames_per_second: 1000 }],
    frames_dropped_before_session: 0,
    session_start_seconds: 1000,
    buffer_seconds: 1,
    scratch_bytes: null,
    mem_bytes: null,
    tail: Array.from({ length: tailLen }, (_, i) => frame(count - tailLen + i)),
  };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeLog.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("rename keystroke under a streaming session", () => {
  it("one keystroke into the rename input terminates and stays bounded", async () => {
    // StrictMode to match the real `main.tsx` mount — dev StrictMode
    // double-invokes effects, which is where a marginal effect loop
    // would tip over.
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    // The seeded default layout mounts the project panel with one
    // trace element row; its inline rename input is the target.
    const input = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>(
        'input[aria-label^="element "]',
      );
      if (!el) throw new Error("rename input not mounted yet");
      return el;
    });

    // The seeded trace element starts *stopped*; the user's live
    // session has it running (Connect starts all elements). Start it
    // through the real toolbar button so the by-id refresh loop and
    // the window arithmetic are live, like the real repro.
    const startButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent === "Start");
    if (!startButton) throw new Error("trace Start button not found");
    await act(async () => {
      fireEvent.click(startButton);
    });

    // Simulate the streaming session: a large, growing capture at
    // 1000 msg/s, ticking the way the host's 10 Hz emitter does.
    for (let tick = 0; tick < 5; tick++) {
      // eslint-disable-next-line no-await-in-loop -- sequential ticks on purpose
      await act(async () => {
        emitTauri("trace-grew", grew(1_000_000 + tick * 100));
      });
    }

    // Prove the synthetic stream actually landed: a *running* by-id
    // trace re-pages its snapshot as the window grows (the windowed
    // primitive's throttled live refresh), so beyond the mount-time
    // fetch the growth must drive more `fetch_by_id_page` calls. The
    // refresh is interval-driven now, so wait for it rather than
    // asserting synchronously. Without this the test could silently
    // exercise an idle app and prove nothing.
    await waitFor(
      () =>
        expect(
          invokeLog.filter((c) => c === "fetch_by_id_page").length,
        ).toBeGreaterThanOrEqual(2),
      { timeout: 3000 },
    );

    const invokesBefore = invokeLog.length;
    const before = performance.now();

    // THE keystroke. If this wedges, the test times out here.
    await act(async () => {
      fireEvent.change(input, { target: { value: "Trace 1x" } });
    });

    const elapsedMs = performance.now() - before;
    const invokesAfter = invokeLog.slice(invokesBefore);

    // Diagnostics for the investigation log.
    // eslint-disable-next-line no-console
    console.log(
      `keystroke flush: ${elapsedMs.toFixed(1)} ms, ` +
        `${invokesAfter.length} host invokes:`,
      JSON.stringify(
        invokesAfter.reduce<Record<string, number>>((acc, c) => {
          acc[c] = (acc[c] ?? 0) + 1;
          return acc;
        }, {}),
      ),
    );

    // The keystroke must echo into the (controlled) input.
    expect(input.value).toBe("Trace 1x");

    // Keep streaming, then type again — the realistic interleave of
    // tick / keystroke / tick the user hits while renaming live.
    await act(async () => {
      emitTauri("trace-grew", grew(1_000_600));
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: "Trace 1xy" } });
    });
    expect(input.value).toBe("Trace 1xy");
    await act(async () => {
      emitTauri("trace-grew", grew(1_000_700));
    });

    // A single keystroke must not fan out into a storm of host calls.
    // (Generous bound — the point is catching unbounded behavior, not
    // pinning an exact count.)
    expect(invokesAfter.length).toBeLessThan(50);
  }, 30_000);
});
