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

describe("EventsPanel goto", () => {
  it("broadcasts the event's absolute timestamp on the goto bus", () => {
    renderPanel([{ id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" }]);
    fireEvent.click(screen.getByLabelText("go to this event"));
    expect(emit).toHaveBeenCalledWith(GOTO_EVENT, 5_000_000_000);
  });
});
