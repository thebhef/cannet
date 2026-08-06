// The gridview's row-space contract and cursor arithmetic (ADR 0044).
// A tree fixture is flattened into the ordered row space for a given
// expansion set, so "expanding a branch edits the row space" is exercised
// for real rather than asserted about a hand-written array.

import { describe, expect, it } from "vitest";

import {
  arrayRowSpace,
  cursorAction,
  type GridviewRow,
  type GridviewRowKind,
  type GridviewRowSpace,
} from "./gridviewRows";

interface Node {
  id: string;
  kind: GridviewRowKind;
  /// Branch children — present in the row space only while expanded.
  children?: Node[];
  /// Leaf content block — expanding it adds no rows.
  content?: boolean;
}

const TREE: Node[] = [
  {
    id: "bus",
    kind: "branch",
    children: [
      { id: "msg", kind: "branch", children: [{ id: "sig", kind: "leaf" }] },
      { id: "frame", kind: "leaf", content: true },
    ],
  },
  { id: "empty-branch", kind: "branch" },
  { id: "plain", kind: "leaf" },
];

/// The visible rows for an expansion set: a collapsed branch hides its
/// subtree, an expanded leaf still occupies exactly one row.
function flatten(nodes: readonly Node[], expanded: ReadonlySet<string>, depth = 0): GridviewRow[] {
  const out: GridviewRow[] = [];
  for (const n of nodes) {
    const children = n.children ?? [];
    out.push({
      id: n.id,
      kind: n.kind,
      expandable: n.kind === "branch" ? children.length > 0 : n.content === true,
      depth,
    });
    if (n.kind === "branch" && expanded.has(n.id)) {
      out.push(...flatten(children, expanded, depth + 1));
    }
  }
  return out;
}

function space(...expandedIds: string[]) {
  const expanded = new Set(expandedIds);
  return arrayRowSpace(flatten(TREE, expanded), (id) => expanded.has(id));
}

/// The `move` action onto `id`: the arithmetic hands the hook the index
/// as well, because that is what it scrolls by — and in a host-paged
/// space the target row is one the panel has yet to load.
function move(s: GridviewRowSpace, id: string) {
  return { type: "move", id, index: s.indexOf(id) };
}

describe("row space", () => {
  it("orders rows by id and reports positions", () => {
    const s = space();
    expect(s.count).toBe(3);
    expect(s.rowIdAt(0)).toBe("bus");
    expect(s.rowIdAt(3)).toBeNull();
    expect(s.indexOf("empty-branch")).toBe(1);
    expect(s.indexOf("sig")).toBe(-1);
    expect(s.rowAt("plain")).toEqual({
      id: "plain",
      kind: "leaf",
      expandable: false,
      depth: 0,
    });
  });

  it("grows when a branch expands and not when a leaf's content does", () => {
    expect(space().count).toBe(3);
    expect(space("bus").count).toBe(5);
    expect(space("bus", "msg").count).toBe(6);
    // `frame` is a leaf with content: expanding it grows the row, not
    // the row space.
    expect(space("bus", "frame").count).toBe(5);
  });

  it("reports a childless branch as not expandable", () => {
    expect(space().rowAt("empty-branch")?.expandable).toBe(false);
  });
});

describe("cursor movement", () => {
  it("steps down and up, clamped at both ends", () => {
    const s = space();
    expect(cursorAction(s, "bus", "ArrowDown", 10)).toEqual(move(s, "empty-branch"));
    expect(cursorAction(s, "empty-branch", "ArrowUp", 10)).toEqual(move(s, "bus"));
    expect(cursorAction(s, "bus", "ArrowUp", 10)).toEqual(move(s, "bus"));
    expect(cursorAction(s, "plain", "ArrowDown", 10)).toEqual(move(s, "plain"));
  });

  it("starts at the first row when there is no cursor", () => {
    const s = space();
    expect(cursorAction(s, null, "ArrowDown", 10)).toEqual(move(s, "bus"));
    expect(cursorAction(s, null, "ArrowUp", 10)).toEqual(move(s, "bus"));
  });

  it("restarts at the first row when the cursor left the row space", () => {
    // `sig` was visible while `msg` was open; collapsing it took the row
    // away without the cursor moving.
    expect(cursorAction(space("bus"), "sig", "ArrowDown", 10)).toEqual(move(space("bus"), "bus"));
  });

  it("does nothing in an empty row space", () => {
    const empty = arrayRowSpace([], () => false);
    expect(cursorAction(empty, null, "ArrowDown", 10)).toEqual({ type: "none" });
    expect(cursorAction(empty, null, "Home", 10)).toEqual({ type: "none" });
  });

  it("jumps to the first and last row", () => {
    const s = space("bus", "msg");
    expect(cursorAction(s, "frame", "Home", 10)).toEqual(move(s, "bus"));
    expect(cursorAction(s, "bus", "End", 10)).toEqual(move(s, "plain"));
    // Home/End work from no cursor at all.
    expect(cursorAction(s, null, "End", 10)).toEqual(move(s, "plain"));
  });

  it("moves by a viewport of rows, clamped", () => {
    const s = space("bus", "msg"); // bus, msg, sig, frame, empty-branch, plain
    expect(cursorAction(s, "bus", "PageDown", 2)).toEqual(move(s, "sig"));
    expect(cursorAction(s, "sig", "PageUp", 2)).toEqual(move(s, "bus"));
    expect(cursorAction(s, "bus", "PageDown", 100)).toEqual(move(s, "plain"));
    expect(cursorAction(s, "plain", "PageUp", 100)).toEqual(move(s, "bus"));
    // A viewport too short to hold a row still advances by one.
    expect(cursorAction(s, "bus", "PageDown", 0)).toEqual(move(s, "msg"));
  });
});

describe("cursor expansion (Right)", () => {
  it("expands a closed branch, then steps into its first child", () => {
    expect(cursorAction(space(), "bus", "ArrowRight", 10)).toEqual({ type: "expand", id: "bus" });
    expect(cursorAction(space("bus"), "bus", "ArrowRight", 10)).toEqual(
      move(space("bus"), "msg"),
    );
  });

  it("expands a leaf's content block and then does nothing", () => {
    expect(cursorAction(space("bus"), "frame", "ArrowRight", 10)).toEqual({
      type: "expand",
      id: "frame",
    });
    expect(cursorAction(space("bus", "frame"), "frame", "ArrowRight", 10)).toEqual({
      type: "none",
    });
  });

  it("does nothing on a plain leaf or a childless branch", () => {
    expect(cursorAction(space(), "plain", "ArrowRight", 10)).toEqual({ type: "none" });
    expect(cursorAction(space(), "empty-branch", "ArrowRight", 10)).toEqual({ type: "none" });
  });

  it("does nothing on an open branch whose last child is the last row", () => {
    // `sig` is `msg`'s only child and the row after `msg`; stepping in
    // works, but from `msg` open with no following child row it must not
    // walk into a sibling.
    const s = space("bus", "msg");
    expect(cursorAction(s, "msg", "ArrowRight", 10)).toEqual(move(s, "sig"));
    expect(cursorAction(s, "sig", "ArrowRight", 10)).toEqual({ type: "none" });
  });
});

describe("cursor collapse (Left)", () => {
  it("collapses an open branch", () => {
    expect(cursorAction(space("bus"), "bus", "ArrowLeft", 10)).toEqual({
      type: "collapse",
      id: "bus",
    });
  });

  it("collapses an open leaf's content block", () => {
    expect(cursorAction(space("bus", "frame"), "frame", "ArrowLeft", 10)).toEqual({
      type: "collapse",
      id: "frame",
    });
  });

  it("walks to the parent from a closed row", () => {
    const s = space("bus", "msg");
    expect(cursorAction(s, "msg", "ArrowLeft", 10)).toEqual({ type: "collapse", id: "msg" });
    expect(cursorAction(s, "sig", "ArrowLeft", 10)).toEqual(move(s, "msg"));
    expect(cursorAction(s, "frame", "ArrowLeft", 10)).toEqual(move(s, "bus"));
  });

  it("does nothing at the top level with nothing to collapse", () => {
    expect(cursorAction(space(), "plain", "ArrowLeft", 10)).toEqual({ type: "none" });
    expect(cursorAction(space(), "bus", "ArrowLeft", 10)).toEqual({ type: "none" });
  });
});
