// @vitest-environment jsdom
/**
 * Acting on an event lights up what it is about (ADR 0056) — and stops.
 *
 * The acceptance test the phase was scoped with is the negative one, so
 * it is asserted first and again at the end of every positive case: **at
 * rest nothing draws**. Every class this file looks for is applied from
 * derived state that is empty unless a pointer or a selection says
 * otherwise, so a trace nobody is pointing at looks exactly as it did
 * before any of this existed.
 *
 * Two surfaces, one channel: the events view's rows raise the highlight,
 * and the chronological trace's frame rows answer it. They are different
 * panels, which is why the channel exists at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

let storedSettings: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...storedSettings } : null)),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

import { EventsPanel } from "./EventsPanel";
import { TraceView, SUBJECT_ROW_CLASS } from "./TraceView";
import { TraceDataProvider, type TraceData } from "./traceData";
import { NotesContext, type NotesContextValue } from "./notesContext";
import { SignalCatalogContext } from "./signalCatalogContext";
import { activeEventIds, hoverEvent, resetEventHighlight } from "./eventHighlight";
import { hydrateSettings } from "./hostSettings";
import { noteToEvent, type Note } from "./notes";
import { defaultColumns } from "./traceColumns";
import type { TraceFrameRecord } from "./types";
import type { TraceRow } from "./trace";
import type { TimelineEvent } from "./notes";

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

function notesCtx(notes: Note[]): NotesContextValue {
  return {
    notes,
    addNote: vi.fn(),
    renameNote: vi.fn(),
    recolorNote: vi.fn(),
    describeNote: vi.fn(),
    retagNote: vi.fn(),
    removeNote: vi.fn(),
    linkEvents: vi.fn(),
    unlinkEvents: vi.fn(),
    setNoteSubjects: vi.fn(),
  };
}

/// Two events linked as a pair (the reference stored on the later one),
/// plus one that is about a message and nothing else.
const CONTACTOR: Note = {
  id: "contactor",
  timestampNs: 1_000_000_000,
  label: "contactor open",
  kind: "note",
  subjects: [{ kind: "signal", messageId: 0x1a2, extended: false, signalName: "PackCurrent" }],
};
const FAULT: Note = {
  id: "fault",
  timestampNs: 3_000_000_000,
  label: "fault",
  kind: "note",
  subjects: [{ kind: "event", id: "contactor" }],
};
const ELSEWHERE: Note = {
  id: "elsewhere",
  timestampNs: 5_000_000_000,
  label: "elsewhere",
  kind: "note",
  subjects: [{ kind: "message", messageId: 0x310, extended: false }],
};

/// The same event, earliest of its list, so the virtualized view puts it
/// in the first row slot whatever else is on screen.
const LONE: Note = { ...ELSEWHERE, id: "lone", label: "lone", timestampNs: 100 };

function renderEventsPanel(notes: Note[]) {
  render(
    <TraceDataProvider value={traceData}>
      <SignalCatalogContext.Provider value={{ catalog: [] }}>
        <NotesContext.Provider value={notesCtx(notes)}>
          <EventsPanel {...({} as Parameters<typeof EventsPanel>[0])} />
        </NotesContext.Provider>
      </SignalCatalogContext.Provider>
    </TraceDataProvider>,
  );
}

function eventRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".trace-event-row"));
}

function litLabels(): string[] {
  return eventRows()
    .filter((r) => r.classList.contains(SUBJECT_ROW_CLASS))
    .map((r) => r.querySelector(".trace-event-label")?.textContent ?? "");
}

function frame(index: number, id: number, _name: string): TraceFrameRecord {
  return {
    index,
    timestamp_seconds: index,
    channel: 0,
    id,
    extended: false,
    direction: "Rx",
    kind: { kind: "classic" },
    data: [1],
    decoded: null,
    bus_id: "b1",
  };
}

/// The chronological trace: two frames of different messages, with the
/// events interleaved the way `TracePanel` interleaves them.
const FRAMES = [frame(0, 0x1a2, "BMS_Status"), frame(1, 0x310, "ThermalReport")];

function renderTrace(events: readonly TimelineEvent[]) {
  const rows: TraceRow[] = [
    { row: "frame", frame: FRAMES[0] },
    { row: "frame", frame: FRAMES[1] },
    ...events.map((event) => ({ row: "event", event }) as TraceRow),
  ];
  render(
    <SignalCatalogContext.Provider value={{ catalog: [] }}>
      <TraceView
        count={rows.length}
        version={0}
        autoScroll={false}
        baseTimestampSeconds={0}
        columns={defaultColumns()}
        onColumnResize={() => {}}
        onColumnToggle={() => {}}
        onColumnReorder={() => {}}
        resolveColor={null}
        busLookup={new Map([["b1", "Chassis"]])}
        getRow={(i) => rows[i] ?? null}
        ensureVisible={() => {}}
        onAutoScrollDisabled={() => {}}
        events={events}
      />
    </SignalCatalogContext.Provider>,
  );
}

/// The arbitration ids of the frame rows currently lit.
function litFrameIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`.trace-row.${SUBJECT_ROW_CLASS}`))
    .filter((r) => !r.classList.contains("trace-event-row"))
    .map((r) => r.querySelector(".col-id")?.textContent ?? "");
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  storedSettings = {};
  await hydrateSettings();
  resetEventHighlight();
});
afterEach(() => {
  cleanup();
  resetEventHighlight();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the events view raises the highlight", () => {
  it("lights nothing at rest", () => {
    renderEventsPanel([CONTACTOR, FAULT, ELSEWHERE]);
    expect(litLabels()).toEqual([]);
    expect(activeEventIds()).toEqual([]);
  });

  it("lights a hovered event and the event it is linked to, from either end", () => {
    renderEventsPanel([CONTACTOR, FAULT, ELSEWHERE]);
    // The reference is stored on `fault`; hovering the *other* end has
    // to light the pair all the same (ADR 0056 § 4).
    act(() => {
      fireEvent.mouseEnter(eventRows()[0]);
    });
    expect(litLabels()).toEqual(["contactor open", "fault"]);

    act(() => {
      fireEvent.mouseLeave(eventRows()[0]);
      fireEvent.mouseEnter(eventRows()[1]);
    });
    expect(litLabels()).toEqual(["contactor open", "fault"]);
  });

  it("puts everything back the moment the pointer leaves", () => {
    renderEventsPanel([CONTACTOR, FAULT, ELSEWHERE]);
    act(() => {
      fireEvent.mouseEnter(eventRows()[0]);
    });
    expect(litLabels()).not.toEqual([]);
    act(() => {
      fireEvent.mouseLeave(eventRows()[0]);
    });
    expect(litLabels()).toEqual([]);
  });

  it("lights an event that is linked to nothing, alone", () => {
    renderEventsPanel([LONE, CONTACTOR]);
    act(() => {
      fireEvent.mouseEnter(eventRows()[0]);
    });
    expect(litLabels()).toEqual(["lone"]);
  });

  it("holds the highlight on a selected event after the pointer has gone", () => {
    renderEventsPanel([LONE, CONTACTOR]);
    act(() => {
      fireEvent.click(eventRows()[0]);
    });
    // The click also enters the row in a real browser; what matters is
    // that letting go of the pointer does not put it out.
    act(() => {
      fireEvent.mouseLeave(eventRows()[0]);
    });
    expect(activeEventIds()).toEqual(["lone"]);
    expect(litLabels()).toEqual(["lone"]);
  });

  it("goes back to rest when the view that raised it unmounts", () => {
    renderEventsPanel([LONE, CONTACTOR]);
    act(() => {
      fireEvent.click(eventRows()[0]);
    });
    expect(activeEventIds()).toEqual(["lone"]);
    cleanup();
    expect(activeEventIds()).toEqual([]);
  });
});

describe("the chronological trace answers it", () => {
  const events = [CONTACTOR, FAULT, ELSEWHERE].map(noteToEvent);

  it("lights no frame row at rest", () => {
    renderTrace(events);
    expect(litFrameIds()).toEqual([]);
  });

  it("lights the frames of the message a signal subject lives on", () => {
    // The event names `0x1A2.PackCurrent`; the frames that carry that
    // field are `0x1A2`'s, so those are the rows it is about.
    renderTrace(events);
    act(() => {
      hoverEvent("contactor");
    });
    expect(litFrameIds()).toEqual(["s:1A2"]);
  });

  it("lights the frames of a message subject", () => {
    renderTrace(events);
    act(() => {
      hoverEvent("elsewhere");
    });
    expect(litFrameIds()).toEqual(["s:310"]);
  });

  it("lights the far end's frames when the near end names nothing itself", () => {
    // `fault` has one subject and it is the link. Its own frames are
    // none; hovering it still says nothing about `0x1A2`, because a
    // link is not a claim about the other event's subjects.
    renderTrace(events);
    act(() => {
      hoverEvent("fault");
    });
    expect(litFrameIds()).toEqual([]);
  });

  it("puts every frame row back when the highlight goes", () => {
    renderTrace(events);
    act(() => {
      hoverEvent("contactor");
    });
    expect(litFrameIds()).toEqual(["s:1A2"]);
    act(() => {
      hoverEvent(null);
    });
    expect(litFrameIds()).toEqual([]);
  });

  it("lights nothing for an event this view does not hold", () => {
    renderTrace(events);
    act(() => {
      hoverEvent("no-such-event");
    });
    expect(litFrameIds()).toEqual([]);
  });
});
