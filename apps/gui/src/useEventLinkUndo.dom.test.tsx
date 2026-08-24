// @vitest-environment jsdom
//
// The link/unlink dispatchers and their undo steps, driven directly.
// What is worth pinning here is the pairing: which end the host is told
// to store the reference on, and that undo asks for the exact inverse of
// what was done — including after the link's storing end has been
// erased by the unlink itself.

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useRef, type MutableRefObject } from "react";

import { EMPTY_LINK_HISTORY, type LinkHistory, type LinkStep } from "./eventLinkHistory";
import { EMPTY_UNDO_ORDER, popUndo, type UndoOrder } from "./elementHistory";
import { useEventLinkUndo, type EventLinkUndo } from "./useEventLinkUndo";
import type { Note } from "./notes";

const SIG = { kind: "signal", messageId: 0x1a2, extended: false, signalName: "PackCurrent" } as const;
const MSG = { kind: "message", messageId: 0x1a2, extended: false } as const;

const event = (n: { id: string; subjects?: readonly unknown[] }): Note => ({
  id: n.id,
  timestampNs: 0,
  label: n.id,
  subjects: (n.subjects ?? []) as Note["subjects"],
});

const note = (id: string, links: string[] = []): Note => ({
  id,
  timestampNs: 0,
  label: id,
  subjects: links.map((l) => ({ kind: "event", id: l })),
});

/// Mount the hook over a mutable notes list and hand back its API plus
/// the refs, so a test can drive a sequence and read the log after.
function harness(notes: Note[]) {
  const dispatch = vi.fn<(step: LinkStep) => void>();
  const refs: {
    notesRef?: MutableRefObject<Note[]>;
    linkHistoryRef?: MutableRefObject<LinkHistory>;
    undoOrderRef?: MutableRefObject<UndoOrder>;
  } = {};
  let api!: EventLinkUndo;
  function Probe() {
    const notesRef = useRef<Note[]>(notes);
    const linkHistoryRef = useRef<LinkHistory>(EMPTY_LINK_HISTORY);
    const undoOrderRef = useRef<UndoOrder>(EMPTY_UNDO_ORDER);
    refs.notesRef = notesRef;
    refs.linkHistoryRef = linkHistoryRef;
    refs.undoOrderRef = undoOrderRef;
    api = useEventLinkUndo({
      notesRef,
      linkHistoryRef,
      undoOrderRef,
      gestureId: () => undefined,
      dispatch,
    });
    return null;
  }
  render(<Probe />);
  return { api: () => api, dispatch, refs };
}

describe("useEventLinkUndo", () => {
  it("stores a fresh link on the first-named end", () => {
    // The events panel names the later event first, and the host stores
    // the reference there.
    const h = harness([note("first"), note("second")]);
    h.api().linkEvents("second", "first");
    expect(h.dispatch).toHaveBeenCalledWith({ kind: "link", stores: "second", other: "first", linked: true });
  });

  it("undoes a link by unlinking the same pair, same way round", () => {
    const h = harness([note("first"), note("second")]);
    h.api().linkEvents("second", "first");
    h.dispatch.mockClear();
    expect(h.api().applyEventLinkHistory("undo")).toBe(true);
    expect(h.dispatch).toHaveBeenCalledWith({ kind: "link", stores: "second", other: "first", linked: false });
  });

  it("redoes it as it was made", () => {
    const h = harness([note("first"), note("second")]);
    h.api().linkEvents("second", "first");
    h.api().applyEventLinkHistory("undo");
    h.dispatch.mockClear();
    expect(h.api().applyEventLinkHistory("redo")).toBe(true);
    expect(h.dispatch).toHaveBeenCalledWith({ kind: "link", stores: "second", other: "first", linked: true });
  });

  it("puts an undone unlink back on the end that held it", () => {
    // The reference lived on `second`. Unlinking erases that, so the
    // step has to have remembered it — otherwise undo would re-link
    // from `first` and move the chip to the other row.
    const h = harness([note("first"), note("second", ["first"])]);
    h.api().unlinkEvents("first", "second");
    expect(h.dispatch).toHaveBeenCalledWith({ kind: "link", stores: "second", other: "first", linked: false });
    h.dispatch.mockClear();
    h.api().applyEventLinkHistory("undo");
    expect(h.dispatch).toHaveBeenCalledWith({ kind: "link", stores: "second", other: "first", linked: true });
  });

  it("records a subject removal, and undoes it by putting the list back", () => {
    // The × on a signal chip is the same gesture as the × on a link
    // chip. Only one of them being undoable is the surprise.
    const dispatched: unknown[] = [];
    const e = event({ id: "n1", subjects: [SIG, MSG] });
    const h = harness([e as unknown as Note]);
    h.dispatch.mockImplementation((s) => dispatched.push(s));
    h.api().setNoteSubjects("n1", [MSG]);
    expect(dispatched).toEqual([
      { kind: "subjects", eventId: "n1", before: [SIG, MSG], after: [MSG] },
    ]);
    dispatched.length = 0;
    expect(h.api().applyEventLinkHistory("undo")).toBe(true);
    expect(dispatched).toEqual([
      { kind: "subjects", eventId: "n1", before: [MSG], after: [SIG, MSG] },
    ]);
  });

  it("redoes a subject removal as it was made", () => {
    const e = event({ id: "n1", subjects: [SIG, MSG] });
    const h = harness([e as unknown as Note]);
    h.api().setNoteSubjects("n1", [MSG]);
    h.api().applyEventLinkHistory("undo");
    h.dispatch.mockClear();
    h.api().applyEventLinkHistory("redo");
    expect(h.dispatch).toHaveBeenCalledWith({
      kind: "subjects",
      eventId: "n1",
      before: [SIG, MSG],
      after: [MSG],
    });
  });

  it("interleaves subject edits with links on one stack, newest first", () => {
    // "All linking and unlinking on that stack" — one chord walks back
    // through both kinds in the order they were made.
    const e = event({ id: "n1", subjects: [SIG] });
    const h = harness([e as unknown as Note, event({ id: "n2" }) as unknown as Note]);
    h.api().setNoteSubjects("n1", []);
    h.api().linkEvents("n1", "n2");
    h.dispatch.mockClear();
    h.api().applyEventLinkHistory("undo");
    expect(h.dispatch).toHaveBeenLastCalledWith({
      kind: "link",
      stores: "n1",
      other: "n2",
      linked: false,
    });
    h.api().applyEventLinkHistory("undo");
    expect(h.dispatch).toHaveBeenLastCalledWith({
      kind: "subjects",
      eventId: "n1",
      before: [],
      after: [SIG],
    });
  });

  it("treats an event with no subjects as an empty list, not as absent", () => {
    const h = harness([event({ id: "n1" }) as unknown as Note]);
    h.api().setNoteSubjects("n1", [MSG]);
    expect(h.dispatch).toHaveBeenCalledWith({
      kind: "subjects",
      eventId: "n1",
      before: [],
      after: [MSG],
    });
  });

  it("reports nothing to do at either end of the stack", () => {
    const h = harness([note("a"), note("b")]);
    expect(h.api().applyEventLinkHistory("undo")).toBe(false);
    expect(h.api().applyEventLinkHistory("redo")).toBe(false);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("does not record the restore as a new step", () => {
    // Undo then redo then undo has to keep walking one step, not pile
    // up a step per restore.
    const h = harness([note("a"), note("b")]);
    h.api().linkEvents("a", "b");
    h.api().applyEventLinkHistory("undo");
    expect(h.refs.linkHistoryRef!.current.past).toHaveLength(0);
    expect(h.refs.linkHistoryRef!.current.future).toHaveLength(1);
    h.api().applyEventLinkHistory("redo");
    expect(h.refs.linkHistoryRef!.current.past).toHaveLength(1);
    expect(h.refs.linkHistoryRef!.current.future).toHaveLength(0);
    expect(h.api().applyEventLinkHistory("redo")).toBe(false);
  });

  it("puts the step in the shared order log, so one chord reaches it", () => {
    // Without this the link stack is invisible to the chord: the log is
    // what decides which stack the next Ctrl+Z steps.
    const h = harness([note("a"), note("b")]);
    h.api().linkEvents("a", "b");
    const popped = popUndo(h.refs.undoOrderRef!.current, (s) => s === "events");
    expect(popped?.stacks).toEqual(["events"]);
  });

  it("walks a run of links newest-first", () => {
    const h = harness([note("a"), note("b"), note("c")]);
    h.api().linkEvents("a", "b");
    h.api().linkEvents("c", "b");
    h.dispatch.mockClear();
    h.api().applyEventLinkHistory("undo");
    expect(h.dispatch).toHaveBeenLastCalledWith({ kind: "link", stores: "c", other: "b", linked: false });
    h.api().applyEventLinkHistory("undo");
    expect(h.dispatch).toHaveBeenLastCalledWith({ kind: "link", stores: "a", other: "b", linked: false });
    expect(h.api().applyEventLinkHistory("undo")).toBe(false);
  });
});
