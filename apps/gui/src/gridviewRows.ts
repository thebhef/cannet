/// The gridview's row-space contract and cursor arithmetic (ADR 0044).
/// Pure: no DOM, no React. `useGridview` binds this to a container
/// element; each panel supplies the row space through the adapter below,
/// so the two virtualizers and the non-virtualized panels sit unchanged
/// beneath one interaction model.
///
/// Everything here is keyed by **stable row id**, never by index: row
/// indexes recycle under scroll, sort and refresh, so index-keyed
/// interaction state is either broken already or one sort away from it.

/// A row either structures other rows or it doesn't. A **branch**'s
/// children appear in and disappear from the space as it opens. A
/// **leaf**'s content is rows too wherever that content is a list — a
/// trace row's decoded signals are rows of the space, each with an id
/// and a place in the order (`gridviewContentRows.ts` is the arithmetic
/// that splices them in); content that is an editor face instead stays
/// a block reached by Tab. Either way the toggle is the row's own line,
/// never the footprint of what it disclosed (ADR 0044).
export type GridviewRowKind = "branch" | "leaf";

/// One row of the space. `kind` and `expandable` are orthogonal: a
/// childless branch is not expandable, and a leaf is expandable exactly
/// when it owns a content block.
export interface GridviewRow {
  id: string;
  kind: GridviewRowKind;
  expandable: boolean;
  /// Nesting depth, 0 at the top level. The cursor's Left/Right tree
  /// moves read this rather than a parent pointer, so a panel that
  /// flattens a tree into rows doesn't have to keep one.
  depth: number;
}

/// The ordered row space: what the cursor arithmetic reads. A panel
/// implements it over whatever it already has — an array of rendered
/// rows, or a host-paged window's index math.
export interface GridviewRowSpace {
  /// How many rows the space holds right now (with the current
  /// expansion applied).
  count: number;
  /// The id of the row at `index`, or `null` when out of range.
  rowIdAt(index: number): string | null;
  /// Where `id` sits in the space, or `-1` when it isn't in it (its
  /// branch collapsed, a filter dropped it).
  indexOf(id: string): number;
  /// The row model for `id`, or `null` when it isn't in the space.
  rowAt(id: string): GridviewRow | null;
  /// Is `id` open — a branch showing its children, or a leaf showing
  /// its content block?
  isExpanded(id: string): boolean;
}

/// The full contract a panel hands `useGridview`: the row space plus
/// the two things only the panel can do — move its own viewport, and
/// change its own expansion state — and its declaration of which rows
/// may be selected.
export interface GridviewAdapter extends GridviewRowSpace {
  /// Bring the row at `index` into view. Rendering and scrolling stay
  /// per-panel; the layer only says which row has to be visible.
  scrollToRow(index: number): void;
  /// Open or close `id`.
  setExpanded(id: string, expanded: boolean): void;
  /// May this row be selected? Declared per row rather than per kind
  /// because branch-ness doesn't decide it — the DBC tree's message
  /// nodes are selectable branches while its bus / file / ECU nodes are
  /// not.
  isSelectable(row: GridviewRow): boolean;
  /// The selectable rows in display order, when the panel can answer
  /// without being walked. Omitted ⇒ the layer walks the space and asks
  /// `isSelectable` for each row, which is right wherever `count` is
  /// what the panel holds.
  ///
  /// A view over a *host-paged* row space has to supply it: the walk
  /// runs on every click and on Ctrl/Cmd+A, and a chronological trace's
  /// `count` is the whole capture — millions of rows the frontend does
  /// not hold. The honest answer there is the page it does hold.
  selectionOrder?(): string[];
}

/// A row space over an array of already-flattened rows — the shape the
/// panels that hold their whole row set client-side (the DBC and RBS
/// trees, the transmit list) build directly.
export function arrayRowSpace(
  rows: readonly GridviewRow[],
  isExpanded: (id: string) => boolean,
): GridviewRowSpace {
  return {
    count: rows.length,
    rowIdAt: (index) => rows[index]?.id ?? null,
    indexOf: (id) => rows.findIndex((r) => r.id === id),
    rowAt: (id) => rows.find((r) => r.id === id) ?? null,
    isExpanded,
  };
}

/// The navigation keys the cursor arithmetic answers for. Spelled as
/// `KeyboardEvent.key` values so the container hook can pass a press
/// straight through.
export type GridviewNavKey =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

/// What a navigation key does. Returned rather than applied so the
/// arithmetic stays pure — the hook moves the cursor or calls the
/// adapter's `setExpanded`.
///
/// A move carries the target's `index` as well as its id: the hook
/// scrolls by index, and asking the space to find the id again is both
/// redundant and, in a host-paged space, impossible — the row it is
/// scrolling *to* is by definition one the panel does not hold yet.
export type GridviewCursorAction =
  | { type: "move"; id: string; index: number }
  | { type: "expand"; id: string }
  | { type: "collapse"; id: string }
  | { type: "none" };

const NONE: GridviewCursorAction = { type: "none" };

/// Where one navigation key press takes the cursor (ADR 0044's key
/// table). `pageRows` is how many rows a viewport holds, for
/// PageUp/PageDown; a viewport too short to hold one row still advances
/// by one, so the key is never inert.
///
/// A cursor that has left the row space — its branch collapsed, a
/// filter dropped it — restarts from the first row rather than losing
/// the press.
export function cursorAction(
  space: GridviewRowSpace,
  cursor: string | null,
  key: GridviewNavKey,
  pageRows: number,
): GridviewCursorAction {
  if (space.count === 0) return NONE;
  const moveTo = (index: number): GridviewCursorAction => {
    const clamped = Math.min(Math.max(index, 0), space.count - 1);
    const id = space.rowIdAt(clamped);
    return id == null ? NONE : { type: "move", id, index: clamped };
  };
  if (key === "Home") return moveTo(0);
  if (key === "End") return moveTo(space.count - 1);

  const index = cursor == null ? -1 : space.indexOf(cursor);
  const row = index < 0 || cursor == null ? null : space.rowAt(cursor);
  if (index < 0 || row == null) return moveTo(0);

  const page = Math.max(1, pageRows);
  switch (key) {
    case "ArrowDown":
      return moveTo(index + 1);
    case "ArrowUp":
      return moveTo(index - 1);
    case "PageDown":
      return moveTo(index + page);
    case "PageUp":
      return moveTo(index - page);
    case "ArrowRight": {
      if (row.expandable && !space.isExpanded(row.id)) return { type: "expand", id: row.id };
      // An open row steps into its first child — a branch's children or
      // the rows a leaf discloses, which are rows of the space either
      // way. A plain leaf has nothing at all.
      if (space.isExpanded(row.id)) {
        const nextId = space.rowIdAt(index + 1);
        const next = nextId == null ? null : space.rowAt(nextId);
        if (next != null && next.depth === row.depth + 1) {
          return { type: "move", id: next.id, index: index + 1 };
        }
      }
      return NONE;
    }
    case "ArrowLeft": {
      if (row.expandable && space.isExpanded(row.id)) return { type: "collapse", id: row.id };
      // Closed (or nothing to close): walk out to the parent — the
      // nearest preceding row shallower than this one.
      for (let i = index - 1; i >= 0; i -= 1) {
        const id = space.rowIdAt(i);
        const candidate = id == null ? null : space.rowAt(id);
        if (candidate != null && candidate.depth < row.depth) {
          return { type: "move", id: candidate.id, index: i };
        }
      }
      return NONE;
    }
  }
}
