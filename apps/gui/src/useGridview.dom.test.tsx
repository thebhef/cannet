// @vitest-environment jsdom
//
// The gridview container hook (ADR 0044): the key table, the roving
// active row named by `aria-activedescendant` while focus stays on the
// container, and the dispatcher suppression that keeps a global chord
// on an arrow key from killing grid navigation.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";

import {
  dispatchStroke,
  isEditableTarget,
  isGridviewTarget,
  parseChord,
  type KeyStroke,
} from "./keybindings";
import { arrayRowSpace, type GridviewRow } from "./gridviewRows";
import { useGridview } from "./useGridview";

afterEach(cleanup);

interface Node {
  id: string;
  kind: "branch" | "leaf";
  children?: Node[];
  content?: boolean;
  selectable?: boolean;
}

const TREE: Node[] = [
  {
    id: "bus",
    kind: "branch",
    selectable: false,
    children: [
      { id: "msg", kind: "branch", children: [{ id: "sig", kind: "leaf" }] },
      { id: "frame", kind: "leaf", content: true },
    ],
  },
  { id: "plain", kind: "leaf" },
];

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

const UNSELECTABLE = new Set(
  TREE.filter((n) => n.selectable === false).map((n) => n.id),
);

const scrolled: number[] = [];
const primaryAction = vi.fn();

/// The chip ids a consumer can put in the same selection set as its
/// rows — ADR 0045's pattern chips, which are selectable alongside rows
/// but live outside the scrolled row space.
const CHIPS = ["chip-a", "chip-b"];

/// A panel-shaped consumer: it owns the expansion state and the
/// rendering, the hook owns the interaction. `rendered` limits how many
/// rows reach the DOM, standing in for a paged viewport where the
/// cursor's row need not exist as a node.
function Harness({
  pageRows = 2,
  rendered = 99,
  chips,
  selectionOrder,
}: {
  pageRows?: number;
  rendered?: number;
  chips?: readonly string[];
  selectionOrder?: () => string[];
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rows = flatten(TREE, expanded);
  const space = arrayRowSpace(rows, (id) => expanded.has(id));
  const grid = useGridview({
    adapter: {
      ...space,
      scrollToRow: (index) => scrolled.push(index),
      setExpanded: (id, open) =>
        setExpanded((prev) => {
          const next = new Set(prev);
          if (open) next.add(id);
          else next.delete(id);
          return next;
        }),
      isSelectable: (row) => !UNSELECTABLE.has(row.id),
      selectionOrder,
    },
    pageRows,
    idPrefix: "harness",
    onPrimaryAction: primaryAction,
    extraSelectableIds: chips,
  });
  return (
    <div data-testid="outside">
      {(chips ?? []).map((id) => (
        <div
          key={id}
          data-testid={`row-${id}`}
          data-selected={grid.selection.has(id) ? "yes" : "no"}
          onClick={(e) => grid.onRowClick(id, { mod: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
        />
      ))}
      <div data-testid="grid" role="tree" {...grid.containerProps}>
        {rows.slice(0, rendered).map((row) => (
          <div
            key={row.id}
            id={grid.rowDomId(row.id)}
            role="treeitem"
            data-testid={`row-${row.id}`}
            data-selected={grid.selection.has(row.id) ? "yes" : "no"}
            onClick={(e) =>
              grid.onRowClick(row.id, { mod: e.ctrlKey || e.metaKey, shift: e.shiftKey })
            }
          >
            {row.id}
            <button type="button">edit</button>
            {/* Stands in for the shared combobox: it consumes Escape
                to close its own dropdown, so the grid must not take
                the press from it. */}
            <div
              data-testid={`combo-${row.id}`}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Escape") e.preventDefault();
              }}
            />
            <input aria-label={`rename ${row.id}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

function setup(
  props: {
    pageRows?: number;
    rendered?: number;
    chips?: readonly string[];
    selectionOrder?: () => string[];
  } = {},
) {
  scrolled.length = 0;
  primaryAction.mockClear();
  const view = render(<Harness {...props} />);
  const grid = view.getByTestId("grid");
  grid.focus();
  return { ...view, grid };
}

/// What `aria-activedescendant` names, back as a row id.
function cursor(grid: HTMLElement): string | null {
  const value = grid.getAttribute("aria-activedescendant");
  return value == null ? null : decodeURIComponent(value.replace(/^harness-/, ""));
}

function selectedRows(view: ReturnType<typeof render>): string[] {
  return Array.from(view.container.querySelectorAll('[data-selected="yes"]')).map(
    (el) => (el as HTMLElement).dataset.testid?.replace("row-", "") ?? "",
  );
}

describe("cursor", () => {
  it("moves with the arrows while focus stays on the container", () => {
    const view = setup();
    expect(cursor(view.grid)).toBeNull();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    expect(cursor(view.grid)).toBe("bus");
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    expect(cursor(view.grid)).toBe("plain");
    fireEvent.keyDown(view.grid, { key: "ArrowUp" });
    expect(cursor(view.grid)).toBe("bus");
    expect(document.activeElement).toBe(view.grid);
  });

  it("names a row that is not in the DOM at all", () => {
    // A paged viewport renders a window; the cursor still has to be
    // nameable, which is why focus never lives on a row.
    const view = setup({ rendered: 0 });
    fireEvent.keyDown(view.grid, { key: "End" });
    expect(cursor(view.grid)).toBe("plain");
    expect(view.queryByTestId("row-plain")).toBeNull();
    expect(document.activeElement).toBe(view.grid);
  });

  it("jumps to the ends and moves by a viewport", () => {
    const view = setup({ pageRows: 2 });
    fireEvent.keyDown(view.grid, { key: "End" });
    expect(cursor(view.grid)).toBe("plain");
    fireEvent.keyDown(view.grid, { key: "Home" });
    expect(cursor(view.grid)).toBe("bus");
    fireEvent.keyDown(view.grid, { key: "ArrowRight" }); // expand bus
    fireEvent.keyDown(view.grid, { key: "PageDown" });
    expect(cursor(view.grid)).toBe("frame");
    fireEvent.keyDown(view.grid, { key: "PageUp" });
    expect(cursor(view.grid)).toBe("bus");
  });

  it("asks the panel to scroll the cursor's row into view", () => {
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "End" });
    expect(scrolled).toEqual([1]);
  });

  it("expands and collapses through Right and Left", () => {
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    fireEvent.keyDown(view.grid, { key: "ArrowRight" });
    expect(view.getByTestId("row-msg")).toBeInTheDocument();
    expect(cursor(view.grid)).toBe("bus");
    fireEvent.keyDown(view.grid, { key: "ArrowRight" });
    expect(cursor(view.grid)).toBe("msg");
    fireEvent.keyDown(view.grid, { key: "ArrowLeft" });
    expect(cursor(view.grid)).toBe("bus");
    fireEvent.keyDown(view.grid, { key: "ArrowLeft" });
    expect(view.queryByTestId("row-msg")).toBeNull();
  });

  it("expands a leaf's content block without adding rows", () => {
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    fireEvent.keyDown(view.grid, { key: "ArrowRight" }); // bus opens
    fireEvent.keyDown(view.grid, { key: "End" });
    fireEvent.keyDown(view.grid, { key: "ArrowUp" });
    expect(cursor(view.grid)).toBe("frame");
    const before = view.container.querySelectorAll('[role="treeitem"]').length;
    fireEvent.keyDown(view.grid, { key: "ArrowRight" });
    expect(view.container.querySelectorAll('[role="treeitem"]').length).toBe(before);
  });
});

describe("keys the layer does not bind", () => {
  it("runs the panel's primary action on Space and nothing on Enter", () => {
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    fireEvent.keyDown(view.grid, { key: "Enter" });
    expect(primaryAction).not.toHaveBeenCalled();
    fireEvent.keyDown(view.grid, { key: " " });
    expect(primaryAction).toHaveBeenCalledWith("bus");
  });

  it("leaves Space to a focused button inside a row", () => {
    // A button is activated by Space — that is the platform behaviour.
    // The transmit panel puts its send button inside the grid, so a
    // layer that also claimed the press would fire the action twice: the
    // button's own, and the panel's primary action on the cursor's row.
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    const button = view.getByTestId("row-bus").querySelector("button") as HTMLElement;
    fireEvent.keyDown(button, { key: " " });
    expect(primaryAction).not.toHaveBeenCalled();
    // The grid still owns the press everywhere else on the row.
    fireEvent.keyDown(view.grid, { key: " " });
    expect(primaryAction).toHaveBeenCalledWith("bus");
  });

  it("leaves an inline editor inside a row its own keys", () => {
    // Rows carry text fields (a section's name, an event row's label).
    // The grid consumes the navigation keys, so without the same
    // exemption the global dispatcher makes, the caret cannot be moved
    // and Ctrl+A selects rows instead of the text being typed.
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    const field = view.getByLabelText("rename bus");
    const handled = fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(handled).toBe(true);
    expect(cursor(view.grid)).toBe("bus");
    fireEvent.keyDown(field, { key: "Home" });
    expect(cursor(view.grid)).toBe("bus");
    fireEvent.keyDown(field, { key: "a", ctrlKey: true });
    expect(selectedRows(view)).toEqual([]);
  });

});

describe("Tab into the row's content", () => {
  it("moves focus to the cursor row's first control", () => {
    // jsdom has no native tab traversal, so the assertion is on what
    // the layer focuses, which is the whole point: without it Tab lands
    // on the container's first tab stop, not the cursor's row.
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    expect(cursor(view.grid)).toBe("plain");
    const handled = fireEvent.keyDown(view.grid, { key: "Tab" });
    // `fireEvent` returns false when a handler called preventDefault.
    expect(handled).toBe(false);
    expect(document.activeElement).toBe(view.getByTestId("row-plain").querySelector("button"));
  });

  it("moves to the row's last control on Shift+Tab", () => {
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    fireEvent.keyDown(view.grid, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(view.getByLabelText("rename bus"));
  });

  it("leaves Tab to the browser once focus is inside a row", () => {
    // Walking between a row's own controls, and out of the last one, is
    // the browser's job — the layer only owns the way in.
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    const button = view.getByTestId("row-bus").querySelector("button") as HTMLElement;
    button.focus();
    expect(fireEvent.keyDown(button, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("leaves Tab to the browser when there is no cursor row on screen", () => {
    // A paged viewport names rows it has not rendered; there is nothing
    // to focus, so the press must not be swallowed.
    const view = setup({ rendered: 0 });
    fireEvent.keyDown(view.grid, { key: "End" });
    expect(cursor(view.grid)).toBe("plain");
    expect(fireEvent.keyDown(view.grid, { key: "Tab" })).toBe(true);
  });

  it("takes the keyboard back when a row's editor ends its edit", () => {
    // `ValidatedInput` and friends commit on Enter and revert on Escape
    // by blurring themselves; without this the keyboard would land on
    // `<body>` and the grid would go dead.
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    const field = view.getByLabelText("rename bus") as HTMLElement;
    for (const key of ["Enter", "Escape"]) {
      field.focus();
      expect(document.activeElement).toBe(field);
      field.blur(); // what the editor does for itself on the same press
      fireEvent.keyDown(field, { key });
      expect(document.activeElement).toBe(view.grid);
    }
    // The cursor survived, so the arrows work straight away.
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    expect(cursor(view.grid)).toBe("plain");
  });

  it("leaves focus alone when a row's editor moved it somewhere itself", () => {
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    const field = view.getByLabelText("rename bus") as HTMLElement;
    const button = view.getByTestId("row-bus").querySelector("button") as HTMLElement;
    button.focus();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(document.activeElement).toBe(button);
  });
});

describe("Escape out of the row's content", () => {
  it("hands the keyboard back to the grid from a row's control", () => {
    // The way out, mirroring Tab's way in: without it a Tab into a row
    // is one-way and the arrows stay dead until the user finds their
    // way back with the mouse.
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    fireEvent.keyDown(view.grid, { key: "Tab" });
    const button = view.getByTestId("row-bus").querySelector("button") as HTMLElement;
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(document.activeElement).toBe(view.grid);
    // The cursor is where it was, so navigation resumes straight away.
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    expect(cursor(view.grid)).toBe("plain");
  });

  it("hands it back from a row's text field too", () => {
    // The editable exemption gives a field its own keys; Escape is the
    // one it does not need, since ending an edit is what it means there.
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    const field = view.getByLabelText("rename bus") as HTMLElement;
    field.focus();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.activeElement).toBe(view.grid);
  });

  it("leaves Escape to content that consumed it", () => {
    // A combobox closes its dropdown on Escape; the first press belongs
    // to the content, and only a press it did not claim reaches the grid.
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    const combo = view.getByTestId("combo-bus");
    combo.focus();
    fireEvent.keyDown(combo, { key: "Escape" });
    expect(document.activeElement).toBe(combo);
  });

  it("leaves Escape alone when the container itself has focus", () => {
    // Nothing to come back from, and Escape is a global chord
    // (`view.exitFullscreen`) the grid must not swallow.
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    expect(fireEvent.keyDown(view.grid, { key: "Escape" })).toBe(true);
    expect(document.activeElement).toBe(view.grid);
  });
});

describe("selection", () => {
  it("replaces on a plain click and follows the cursor", () => {
    const view = setup();
    fireEvent.click(view.getByTestId("row-plain"));
    expect(selectedRows(view)).toEqual(["plain"]);
    expect(cursor(view.grid)).toBe("plain");
    fireEvent.keyDown(view.grid, { key: "ArrowUp" });
    // The cursor lands on an unselectable container, so the selection
    // collapses to nothing rather than picking it up.
    expect(cursor(view.grid)).toBe("bus");
    expect(selectedRows(view)).toEqual([]);
  });

  it("toggles with Ctrl+click and keeps the cursor with it", () => {
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    fireEvent.keyDown(view.grid, { key: "ArrowRight" });
    fireEvent.click(view.getByTestId("row-frame"));
    fireEvent.click(view.getByTestId("row-msg"), { ctrlKey: true });
    expect(selectedRows(view).sort()).toEqual(["frame", "msg"]);
    fireEvent.click(view.getByTestId("row-msg"), { ctrlKey: true });
    expect(selectedRows(view)).toEqual(["frame"]);
  });

  it("replaces the selection with the anchor range on Shift+click", () => {
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    fireEvent.keyDown(view.grid, { key: "ArrowRight" }); // open the container
    fireEvent.click(view.getByTestId("row-msg")); // anchor
    fireEvent.click(view.getByTestId("row-plain"), { shiftKey: true });
    expect(selectedRows(view).sort()).toEqual(["frame", "msg", "plain"]);
    // Re-ranging from the same anchor drops what fell outside.
    fireEvent.click(view.getByTestId("row-frame"), { shiftKey: true });
    expect(selectedRows(view).sort()).toEqual(["frame", "msg"]);
  });

  it("collapses the text selection a Shift+click drags across the rows", () => {
    // Shift+click extends the document's text selection as a side
    // effect, so the range gesture would leave the rows it covered
    // highlighted as text.
    const view = setup();
    fireEvent.click(view.getByTestId("row-plain"));
    const range = document.createRange();
    range.selectNodeContents(view.getByTestId("row-plain"));
    const docSelection = window.getSelection();
    docSelection?.removeAllRanges();
    docSelection?.addRange(range);
    expect(window.getSelection()?.isCollapsed).toBe(false);
    fireEvent.click(view.getByTestId("row-plain"), { shiftKey: true });
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
  });

  it("leaves the text selection alone on an unmodified click", () => {
    // Only Shift+click makes one; a plain click has already collapsed
    // it itself, and clearing regardless would fight a caret the user
    // put somewhere else.
    const view = setup();
    const range = document.createRange();
    range.selectNodeContents(view.getByTestId("row-plain"));
    const docSelection = window.getSelection();
    docSelection?.removeAllRanges();
    docSelection?.addRange(range);
    fireEvent.click(view.getByTestId("row-plain"));
    expect(window.getSelection()?.isCollapsed).toBe(false);
    window.getSelection()?.removeAllRanges();
  });

  it("extends the selection with Shift+Up/Down, from the anchor", () => {
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    fireEvent.keyDown(view.grid, { key: "ArrowRight" }); // open the container
    fireEvent.click(view.getByTestId("row-msg")); // cursor + anchor
    fireEvent.keyDown(view.grid, { key: "ArrowDown", shiftKey: true });
    expect(cursor(view.grid)).toBe("frame");
    expect(selectedRows(view).sort()).toEqual(["frame", "msg"]);
    fireEvent.keyDown(view.grid, { key: "ArrowDown", shiftKey: true });
    expect(selectedRows(view).sort()).toEqual(["frame", "msg", "plain"]);
    // Reversing shrinks the range back through the anchor, then extends
    // the other way past it.
    fireEvent.keyDown(view.grid, { key: "ArrowUp", shiftKey: true });
    expect(selectedRows(view).sort()).toEqual(["frame", "msg"]);
    fireEvent.keyDown(view.grid, { key: "ArrowUp", shiftKey: true });
    expect(selectedRows(view)).toEqual(["msg"]);
    // …and the panel is asked to scroll to each row the cursor reaches.
    expect(scrolled.length).toBeGreaterThan(0);
  });

  it("moves the cursor onto an unselectable row without growing the range", () => {
    // The container row cannot be selected, so it cannot join a range —
    // the press still moves the cursor, and the next one ranges from the
    // anchor across it.
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    fireEvent.keyDown(view.grid, { key: "ArrowRight" }); // open the container
    fireEvent.click(view.getByTestId("row-frame"));
    fireEvent.keyDown(view.grid, { key: "ArrowUp", shiftKey: true });
    expect(cursor(view.grid)).toBe("msg");
    fireEvent.keyDown(view.grid, { key: "ArrowUp", shiftKey: true });
    expect(cursor(view.grid)).toBe("bus");
    expect(selectedRows(view).sort()).toEqual(["frame", "msg"]);
  });

  it("takes every selectable row on Ctrl+A, and no others", () => {
    const view = setup();
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    fireEvent.keyDown(view.grid, { key: "ArrowRight" }); // open the container
    fireEvent.keyDown(view.grid, { key: "a", ctrlKey: true });
    expect(selectedRows(view).sort()).toEqual(["frame", "msg", "plain"]);
  });

  it("puts a consumer's extra selectable items in the same set as the rows", () => {
    // ADR 0045's pattern chips: selectable alongside rows so one drag
    // can carry both, without being rows of the scrolled space.
    const view = setup({ chips: CHIPS });
    fireEvent.click(view.getByTestId("row-plain"));
    fireEvent.click(view.getByTestId("row-chip-a"), { ctrlKey: true });
    expect(selectedRows(view).sort()).toEqual(["chip-a", "plain"]);
    // …and they range and select-all with the rows, in that order.
    fireEvent.click(view.getByTestId("row-chip-b"), { ctrlKey: true, shiftKey: true });
    expect(selectedRows(view).sort()).toEqual(["chip-a", "chip-b", "plain"]);
    // A replacing range spans the same order: the anchor is the row,
    // and the chips sit after it.
    fireEvent.click(view.getByTestId("row-plain"));
    fireEvent.click(view.getByTestId("row-chip-b"), { shiftKey: true });
    expect(selectedRows(view).sort()).toEqual(["chip-a", "chip-b", "plain"]);
    fireEvent.click(view.getByTestId("row-chip-a"), { shiftKey: true });
    expect(selectedRows(view).sort()).toEqual(["chip-a", "plain"]);
    // Ctrl+A takes them too (the tree is closed, so "plain" is the
    // only selectable row in the space).
    fireEvent.keyDown(view.grid, { key: "a", ctrlKey: true });
    expect(selectedRows(view).sort()).toEqual(["chip-a", "chip-b", "plain"]);
  });

  it("takes a paged panel's own selection order instead of walking the space", () => {
    // A host-paged row space cannot be walked — `count` is the whole
    // capture. The panel answers with the page it holds, and the layer
    // asks it rather than `isSelectable`, on clicks and on Ctrl+A alike.
    const asked = vi.fn(() => ["frame", "plain"]);
    const view = setup({ selectionOrder: asked });
    fireEvent.keyDown(view.grid, { key: "a", ctrlKey: true });
    expect(asked).toHaveBeenCalled();
    // "frame" is a child of the closed container, so a walk of the space
    // could not have produced it — and "msg" is not in the page.
    expect(selectedRows(view)).toEqual(["plain"]);
    fireEvent.keyDown(view.grid, { key: "ArrowDown" });
    fireEvent.keyDown(view.grid, { key: "ArrowRight" }); // open the container
    fireEvent.click(view.getByTestId("row-msg"));
    expect(selectedRows(view)).toEqual([]); // not in the panel's order
    fireEvent.click(view.getByTestId("row-frame"));
    expect(selectedRows(view)).toEqual(["frame"]);
  });
});

describe("global dispatcher suppression", () => {
  /// The command framework's listener, wired exactly as `useCommands`
  /// does it: capture phase on `document`, editable and gridview
  /// suppression from the target.
  function installDispatcher(bindings: { chord: string; commandId: string }[]) {
    const fired: string[] = [];
    const parsed = bindings.map((b) => ({
      chord: parseChord(b.chord),
      commandId: b.commandId,
    }));
    const onKeyDown = (e: KeyboardEvent) => {
      const stroke: KeyStroke = {
        key: e.key,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
      };
      const r = dispatchStroke([], stroke, parsed, {
        isMac: false,
        inEditable: isEditableTarget(e.target),
        inGridview: isGridviewTarget(e.target),
      });
      // Exactly what `useCommands` does with a consumed stroke.
      if (r.handled) e.preventDefault();
      if (r.commandId) fired.push(r.commandId);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return { fired, dispose: () => document.removeEventListener("keydown", onKeyDown, true) };
  }

  it("does not fire a globally-bound arrow chord inside a grid, but does outside it", () => {
    const view = setup();
    const dispatcher = installDispatcher([
      { chord: "ArrowDown", commandId: "test.down" },
      { chord: "f", commandId: "test.fit" },
    ]);
    try {
      fireEvent.keyDown(view.grid, { key: "ArrowDown" });
      expect(dispatcher.fired).toEqual([]);
      // …and the grid's own cursor did move.
      expect(cursor(view.grid)).toBe("bus");

      fireEvent.keyDown(view.getByTestId("outside"), { key: "ArrowDown" });
      expect(dispatcher.fired).toEqual(["test.down"]);

      // An unrelated chord still reaches the dispatcher from inside.
      fireEvent.keyDown(view.grid, { key: "f" });
      expect(dispatcher.fired).toEqual(["test.down", "test.fit"]);
    } finally {
      dispatcher.dispose();
    }
  });

  it("leaves an Escape a global command took to that command", () => {
    // Escape is not one of the keys the grid is invisible for: a
    // context-gated global binding (`view.exitFullscreen`) fires first
    // from the capture phase and marks the press handled, and the grid's
    // way out of a row's content stands down on the same rule content
    // does.
    const view = setup();
    const dispatcher = installDispatcher([{ chord: "Escape", commandId: "test.escape" }]);
    try {
      fireEvent.keyDown(view.grid, { key: "ArrowDown" });
      const button = view.getByTestId("row-bus").querySelector("button") as HTMLElement;
      button.focus();
      fireEvent.keyDown(button, { key: "Escape" });
      expect(dispatcher.fired).toEqual(["test.escape"]);
      expect(document.activeElement).toBe(button);
    } finally {
      dispatcher.dispose();
    }
  });
});
