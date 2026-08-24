// @vitest-environment jsdom
/**
 * What an event is about, on the row that draws it (ADR 0056).
 *
 * Two things this file is really about. **Resolution happens here, at
 * render time**: a subject stores a message id and a field name and
 * nothing else, so the name on a chip comes from whatever databases are
 * assigned right now — and a reference no database can name is a state
 * to draw, not a fault. And **a link is read from both ends**: it is
 * stored once, so the event that was merely *named* has to show it too.
 *
 * The same `EventRow` renderer draws the events interleaved into the
 * chronological trace, so what is asserted here holds on both surfaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

import { EventsPanel } from "./EventsPanel";
import { TraceDataProvider, type TraceData } from "./traceData";
import { NotesContext, type NotesContextValue } from "./notesContext";
import { SignalCatalogContext } from "./signalCatalogContext";
import type { Note } from "./notes";
import type { SignalDescriptorRecord } from "./types";

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

function descriptor(
  messageId: number,
  messageName: string,
  signalName: string,
): SignalDescriptorRecord {
  return {
    bus_id: "bus-a",
    message_id: messageId,
    extended: false,
    message_name: messageName,
    transmitter: null,
    signal_name: signalName,
    unit: "",
  };
}

const CATALOG = [
  descriptor(0x1a2, "BMS_Status", "PackCurrent"),
  descriptor(0x2a1, "DriveCmd", "TorqueReq"),
];

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

function renderPanel(notes: Note[], catalog: SignalDescriptorRecord[] = CATALOG) {
  const ctx = notesCtx(notes);
  render(
    <TraceDataProvider value={traceData}>
      <SignalCatalogContext.Provider value={{ catalog }}>
        <NotesContext.Provider value={ctx}>
          <EventsPanel {...({} as Parameters<typeof EventsPanel>[0])} />
        </NotesContext.Provider>
      </SignalCatalogContext.Provider>
    </TraceDataProvider>,
  );
  return ctx;
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".trace-event-row"));
}

/// The chips on the `i`th row, as `[label, resolved]` pairs.
function chipsOn(i: number): [string, boolean][] {
  return Array.from(
    rows()[i].querySelectorAll<HTMLElement>(".event-subject-chip"),
  ).map((el) => [
    el.querySelector(".event-subject-chip-label")?.textContent ?? "",
    !el.classList.contains("event-subject-chip--unresolved"),
  ]);
}

const at = (ns: number, id: string): Note => ({ id, timestampNs: ns, label: id, kind: "note" });

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("subject chips on the event row", () => {
  it("names a signal and a message from the assigned databases", () => {
    renderPanel([
      {
        ...at(1_000, "n1"),
        subjects: [
          { kind: "signal", messageId: 0x1a2, extended: false, signalName: "PackCurrent" },
          { kind: "message", messageId: 0x2a1, extended: false },
        ],
      },
    ]);
    expect(chipsOn(0)).toEqual([
      ["PackCurrent", true],
      ["s:2A1 DriveCmd", true],
    ]);
  });

  it("still shows what an unresolvable reference points at, muted", () => {
    // No assigned database defines this field. The reference is not
    // broken and is not repaired — it renders as what it is.
    renderPanel([
      {
        ...at(1_000, "n1"),
        subjects: [
          { kind: "signal", messageId: 0x1a2, extended: false, signalName: "CellTemp" },
          { kind: "message", messageId: 0x777, extended: false },
        ],
      },
    ]);
    expect(chipsOn(0)).toEqual([
      ["CellTemp", false],
      ["s:777", false],
    ]);
    expect(screen.getByTitle(/BMS_Status\.CellTemp — no assigned database/)).toBeInTheDocument();
  });

  it("resolves against the databases assigned now, not against a stored name", () => {
    // The same event, read against a database set that names nothing.
    renderPanel(
      [
        {
          ...at(1_000, "n1"),
          subjects: [
            { kind: "signal", messageId: 0x1a2, extended: false, signalName: "PackCurrent" },
          ],
        },
      ],
      [],
    );
    expect(chipsOn(0)).toEqual([["PackCurrent", false]]);
  });

  it("draws no chip region at all on an event that is about nothing", () => {
    renderPanel([at(1_000, "n1")]);
    expect(document.querySelector(".event-subject-chips")).toBeNull();
  });
});

describe("event links on the row", () => {
  it("shows the link on both events, though it is stored on one", () => {
    renderPanel([
      at(1_000, "first"),
      { ...at(2_000, "second"), subjects: [{ kind: "event", id: "first" }] },
    ]);
    expect(chipsOn(0)).toEqual([["second", true]]);
    expect(chipsOn(1)).toEqual([["first", true]]);
  });

  it("shows nothing for a link whose event this set does not hold", () => {
    renderPanel([{ ...at(1_000, "n1"), subjects: [{ kind: "event", id: "gone" }] }]);
    expect(document.querySelector(".event-subject-chips")).toBeNull();
  });
});

describe("the disclosed subject line", () => {
  it("lists every subject under the row, which is where the … sends you", () => {
    renderPanel([
      {
        ...at(1_000, "n1"),
        subjects: [
          { kind: "signal", messageId: 0x1a2, extended: false, signalName: "PackCurrent" },
          { kind: "message", messageId: 0x2a1, extended: false },
        ],
      },
    ]);
    fireEvent.click(screen.getByLabelText("show event details"));
    const line = document.querySelector(".trace-event-body-subjects");
    expect(line).not.toBeNull();
    expect(Array.from(line!.querySelectorAll(".event-subject-chip-label")).map((e) => e.textContent))
      .toEqual(["PackCurrent", "s:2A1 DriveCmd"]);
  });

  it("gives an event with subjects something to disclose even when it is not editable", () => {
    // A host-derived event takes no edits, so before subjects it had a
    // body only if it carried a tag or a description.
    renderPanel([
      {
        ...at(1_000, "n1"),
        kind: "busError",
        subjects: [{ kind: "message", messageId: 0x1a2, extended: false }],
      },
    ]);
    // A bus error is hidden until asked for (ADR 0035).
    fireEvent.click(screen.getByLabelText("Bus Errors"));
    expect(screen.getByLabelText("show event details")).toBeInTheDocument();
  });
});

describe("linking two events", () => {
  const two = [at(1_000, "first"), at(2_000, "second")];

  function linkChip(): HTMLButtonElement {
    return screen.getByLabelText(/Link Events|Unlink Events/) as HTMLButtonElement;
  }

  it("is off until exactly two events are selected", () => {
    renderPanel(two);
    expect(linkChip()).toBeDisabled();
    fireEvent.click(rows()[0]);
    expect(linkChip()).toBeDisabled();
  });

  it("links the pair, storing the reference on the later event", () => {
    const ctx = renderPanel(two);
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[1], { ctrlKey: true });
    expect(linkChip()).toBeEnabled();
    fireEvent.click(linkChip());
    expect(ctx.linkEvents).toHaveBeenCalledWith("second", "first");
  });

  it("becomes the unlink control when the two are already linked", () => {
    const ctx = renderPanel([
      at(1_000, "first"),
      { ...at(2_000, "second"), subjects: [{ kind: "event", id: "first" }] },
    ]);
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[1], { ctrlKey: true });
    expect(screen.getByLabelText("Unlink Events")).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Unlink Events"));
    expect(ctx.unlinkEvents).toHaveBeenCalledWith("second", "first");
    expect(ctx.linkEvents).not.toHaveBeenCalled();
  });

  it("goes off again when the selection collapses to one", () => {
    renderPanel(two);
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[1], { ctrlKey: true });
    expect(linkChip()).toBeEnabled();
    fireEvent.click(rows()[1]);
    expect(linkChip()).toBeDisabled();
  });
});

