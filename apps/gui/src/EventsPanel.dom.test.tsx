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
import { TraceDataContext, type TraceData } from "./traceData";
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

function renderPanel(notes: Note[]) {
  const props = {} as Parameters<typeof EventsPanel>[0];
  return render(
    <TraceDataContext.Provider value={traceData}>
      <NotesContext.Provider value={notesCtx(notes)}>
        <EventsPanel {...props} />
      </NotesContext.Provider>
    </TraceDataContext.Provider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("EventsPanel goto", () => {
  it("broadcasts the event's absolute timestamp on the goto bus", () => {
    renderPanel([{ id: "n1", timestampNs: 5_000_000_000, label: "boom", kind: "note" }]);
    fireEvent.click(screen.getByLabelText("go to this event"));
    expect(emit).toHaveBeenCalledWith(GOTO_EVENT, 5_000_000_000);
  });
});
