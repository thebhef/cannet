// @vitest-environment jsdom
//
// The screenshot harness's `window.__shot` helpers (ADR 0031), driven
// against the REAL components they claim to reach.
//
// Every selector in `shot-prelude.js` is a claim about the app's markup,
// and until now nothing checked those claims: the helpers are only
// exercised by a real capture run, so a markup change broke them
// silently. `importIdle()` once returned true *mid-import* because the
// label it polled for had been restyled away, and the walk photographed
// a half-imported app without complaint.
//
// So the prelude is loaded here as the file the Rust harness embeds, and
// each helper is driven at real markup rendered by the real components.
// Breaking a selector fails this test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
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
    return () => {};
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
    onResized: async () => () => {},
    setTitle: async () => {},
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

vi.mock("uplot", () => {
  class FakeUPlot {
    over = document.createElement("div");
    scales = { x: {}, y: {} };
    constructor(_opts: unknown, _data: unknown, el: HTMLElement) {
      el.appendChild(document.createElement("canvas"));
    }
    setData() {}
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

import PRELUDE from "../../../crates/cannet-perf-measurement/src/shot-prelude.js?raw";

import { App } from "./App";
import { CloseConfirmModal } from "./CloseConfirmModal";
import { hydrateState } from "./hostState";
import { Toolbar } from "./Toolbar";

/** The helpers as this test drives them. */
interface ShotHelpers {
  sleep: (ms: number) => Promise<void>;
  settle: () => Promise<void>;
  toolbar: (label: string) => Promise<void>;
  openPalette: () => Promise<void>;
  command: (label: string) => Promise<void>;
  waitFor: <T>(what: string, fn: () => T, ms: number) => Promise<T>;
  openSeededCapture: () => Promise<void>;
  hoverPlot: (which: "numeric" | "lanes", fracX: number) => Promise<void>;
  modal: (label: string) => Promise<void>;
  state: () => { status: string; plot: string };
  importIdle: () => boolean;
}

function shot(): ShotHelpers {
  return (window as unknown as { __shot: ShotHelpers }).__shot;
}

/** Evaluate the prelude, then shorten its waits. The 400 ms settle is
 * there so a real browser has painted — not a claim about markup, and
 * the whole runtime of this file if honoured. It stays a real timer,
 * though: `settle` is what lets React flush between a helper's click and
 * the helper's next query, exactly as it does in a browser. */
function installPrelude(): ShotHelpers {
  new Function(PRELUDE)();
  const s = shot();
  s.sleep = () => new Promise((r) => setTimeout(r, 5));
  return s;
}

/** Run a `__shot` helper the way the real harness runs it: outside
 * React's act scope. A helper clicks, waits out its own `settle`, then
 * queries what the click produced — which only works if React's own
 * scheduler flushed in between, as it does in a browser. Inside `act`
 * the flush is deferred to the end of the scope and every helper would
 * query a stale DOM. */
async function drive<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const was = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    return await fn();
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = was;
  }
}

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  localStorage.clear();
  await hydrateState();
  installPrelude();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { __shot?: unknown }).__shot;
  // `__shotLog` deliberately survives: the prelude installs its console
  // tap only when the log is absent, so clearing it would wrap the
  // already-wrapped `console.log` once per test.
});

const RECENT = "C:/captures/drive-cycle-08.blf";

function renderBar(over: Partial<Parameters<typeof Toolbar>[0]> = {}) {
  const onRun = vi.fn();
  const onOpenRecent = vi.fn();
  render(
    <Toolbar
      onRun={onRun}
      captureEmpty={false}
      importing={false}
      recentCaptures={[RECENT]}
      onOpenRecent={onOpenRecent}
      recentProjects={[]}
      onOpenRecentProject={vi.fn()}
      {...over}
    />,
  );
  return { onRun, onOpenRecent };
}

async function mountApp() {
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
}

describe("__shot against the real toolbar", () => {
  it("clicks a toolbar chip by the words it shows", async () => {
    const { onRun } = renderBar();
    await drive(() => shot().toolbar("Import"));
    expect(onRun.mock.calls).toEqual([["trace.import"]]);
  });

  it("says so when a toolbar label it was given is not there", async () => {
    renderBar();
    await expect(shot().toolbar("Imprt")).rejects.toThrow(/no toolbar button/);
  });

  it("reads the import chip's busy state, not its label", async () => {
    // The bug this pins: the chip keeps saying "Import" throughout the
    // import — the busy state is an attribute, and a helper that watched
    // the label reported idle from the first byte.
    renderBar({ importing: true });
    expect(shot().importIdle()).toBe(false);
    cleanup();
    renderBar({ importing: false });
    expect(shot().importIdle()).toBe(true);
  });

  it("opens the Recent menu and takes its one seeded entry", async () => {
    // The dialog-free way into a capture: the file picker is a native
    // dialog the page cannot reach, so the walk drives Recent instead.
    const { onOpenRecent } = renderBar();
    await drive(() => shot().openSeededCapture());
    expect(onOpenRecent.mock.calls).toEqual([[RECENT]]);
  });

  it("says so when the profile's recents were never seeded", async () => {
    renderBar({ recentCaptures: [] });
    await expect(shot().openSeededCapture()).rejects.toThrow(/recents were not seeded/);
  });
});

describe("__shot against the real app", () => {
  it("opens the command palette with the real chord and runs an entry", async () => {
    await mountApp();
    await drive(() => shot().openPalette());
    expect(document.querySelector(".palette-input")).not.toBeNull();
    await drive(() => shot().command("Add plot panel"));
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("no plot panel");
    });
  }, 30_000);

  it("says so when the palette has no such command", async () => {
    await mountApp();
    await expect(shot().command("Summon a pony")).rejects.toThrow(/no palette item/);
  }, 30_000);

  it("reads the status line and the plot panel it puts in its notes", async () => {
    // `state()` is what a run quotes when a frame comes out wrong — an
    // empty plot over a full buffer has to be distinguishable from an
    // import that never landed, and both readings come from here.
    await mountApp();
    await drive(async () => {
      await shot().openPalette();
      await shot().command("Add plot panel");
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("no plot panel");
    });
    const state = shot().state();
    expect(typeof state.status).toBe("string");
    expect(typeof state.plot).toBe("string");
    // Both readings are `innerText` of an element found by these two
    // selectors, and jsdom implements no `innerText` — so what this can
    // pin is that the selectors still resolve. If either stops matching,
    // a capture's notes go permanently blank without saying why.
    expect(document.querySelector(".status")).not.toBeNull();
    expect(document.querySelector(".plot-panel")).not.toBeNull();
    // The area the hover steps aim at (`.plot-area[data-area-id]`); the
    // overlay they dispatch on is uPlot's own `.u-over`, which the fake
    // uPlot this suite mounts does not render.
    expect(document.querySelector(".plot-area[data-area-id]")).not.toBeNull();
  }, 30_000);
});

describe("__shot against a real modal", () => {
  it("clicks a modal button by its exact label", async () => {
    const onChoice = vi.fn();
    render(<CloseConfirmModal onChoice={onChoice} />);
    await drive(() => shot().modal("Cancel"));
    expect(onChoice.mock.calls).toEqual([["cancel"]]);
  });

  it("says so when the modal has no such button", async () => {
    render(<CloseConfirmModal onChoice={vi.fn()} />);
    await expect(shot().modal("Proceed")).rejects.toThrow(/no modal button/);
  });
});

describe("__shot's own plumbing", () => {
  it("polls until the condition holds, and names what it waited for", async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 5);
    await expect(shot().waitFor("the thing", () => ready, 2000)).resolves.toBe(true);
    await expect(shot().waitFor("the other thing", () => false, 10)).rejects.toThrow(
      /timed out waiting for the other thing/,
    );
  });

  it("taps the console without swallowing it", () => {
    // The tap is what lets a wrong frame be explained from the app's own
    // `[diag]` lines rather than only re-run.
    const log = (window as unknown as { __shotLog: string[] }).__shotLog;
    const before = log.length;
    // eslint-disable-next-line no-console
    console.log("[diag] lag=0ms", { a: 1 });
    expect(log.slice(before)).toEqual(['[diag] lag=0ms {"a":1}']);
  });
});
