// Prototype wrapper: mounts the REAL cannet gridview layer (useGridview +
// gridviewRows + gridviewSelection, ADR 0044) over the logger file list.
// Only this file is prototype code; the interaction model is the app's.
// The list is a tree: directories (a logger's File template may carry
// path separators) are branch nodes, .blf files are leaf rows.
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  makeRowGridPropsCache,
  useGridview,
  type Gridview,
} from "../../apps/gui/src/useGridview";
import {
  arrayRowSpace,
  type GridviewAdapter,
  type GridviewRow,
} from "../../apps/gui/src/gridviewRows";

export interface FileNode {
  id: string;
  nm: string;
  mb?: number;
  /// Trace start / end inside the file, ISO timestamps (display strings).
  /// Host-side these come from a cache, not a per-listing header scan.
  st?: string;
  en?: string;
  /// Trace duration in seconds — also the import dialog's range extent.
  durS?: number;
  /// Message count in the file.
  msgs?: number;
  /// Filesystem modified time (display string).
  mo?: string;
  writing?: boolean;
  children?: FileNode[];
}

function fmtDurS(s: number): string {
  if (s >= 5400) return (s / 3600).toFixed(1) + " h";
  if (s >= 60) return Math.round(s / 60) + " min";
  return Math.round(s) + " s";
}

interface Callbacks {
  onImport(node: FileNode): void;
  onContextMenu(node: FileNode, x: number, y: number, isDir: boolean): void;
}

// The app's import icon, shape data verbatim from Icon.tsx's registry.
const importIcon = (
  <svg
    viewBox="0 0 14 14"
    width={14}
    height={14}
    aria-hidden="true"
    focusable="false"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M7 1.5v7M4.5 6L7 8.5 9.5 6" />
    <path d="M1.5 9.5v3h11v-3" />
  </svg>
);

interface FlatRow {
  node: FileNode;
  depth: number;
  isDir: boolean;
}

function flatten(nodes: FileNode[], depth: number, expanded: ReadonlySet<string>, out: FlatRow[]) {
  for (const n of nodes) {
    const isDir = n.children != null;
    out.push({ node: n, depth, isDir });
    if (isDir && expanded.has(n.id)) flatten(n.children!, depth + 1, expanded, out);
  }
}

function FileGrid({
  tree,
  cbs,
  defaultExpanded,
  ensureExpanded,
}: {
  tree: FileNode[];
  cbs: Callbacks;
  defaultExpanded: string[];
  ensureExpanded: string[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(defaultExpanded));
  // A directory named in ensureExpanded opens once (a new logging start's
  // {start} dir); after that the user's collapse wins.
  const seen = useRef(new Set(defaultExpanded));
  useEffect(() => {
    const fresh = ensureExpanded.filter((id) => !seen.current.has(id));
    if (fresh.length > 0) {
      fresh.forEach((id) => seen.current.add(id));
      setExpanded((cur) => new Set([...cur, ...fresh]));
    }
  }, [ensureExpanded]);

  const flat = useMemo(() => {
    const out: FlatRow[] = [];
    flatten(tree, 0, expanded, out);
    return out;
  }, [tree, expanded]);
  const byId = useMemo(() => new Map(flat.map((r) => [r.node.id, r])), [flat]);
  const rows: GridviewRow[] = useMemo(
    () =>
      flat.map((r) => ({
        id: r.node.id,
        kind: r.isDir ? "branch" : "leaf",
        expandable: r.isDir,
        depth: r.depth,
      })),
    [flat],
  );
  const adapter: GridviewAdapter = useMemo(() => {
    const space = arrayRowSpace(rows, (id) => expanded.has(id));
    return {
      ...space,
      scrollToRow(index) {
        // +1 skips the header row; rendering stays the panel's job.
        const el = containerRef.current?.children[index + 1] as HTMLElement | undefined;
        el?.scrollIntoView({ block: "nearest" });
      },
      setExpanded(id, open) {
        setExpanded((cur) => {
          const next = new Set(cur);
          if (open) next.add(id);
          else next.delete(id);
          return next;
        });
      },
      // Directories structure the listing but aren't selectable — the
      // same split the DBC tree's bus/file nodes make.
      isSelectable: (row) => {
        const r = byId.get(row.id);
        return r != null && !r.isDir && !(r.node.writing ?? false);
      },
    };
  }, [rows, byId, expanded]);

  const grid = useGridview({
    adapter,
    pageRows: 8,
    idPrefix: "logfiles",
    onPrimaryAction: (id) => {
      const r = byId.get(id);
      if (r && !r.isDir && !r.node.writing) cbs.onImport(r.node);
    },
  });
  const gridRef = useRef<Gridview>(grid);
  gridRef.current = grid;
  const rowProps = useMemo(() => makeRowGridPropsCache(gridRef, containerRef), []);

  return (
    <div
      ref={containerRef}
      className="grid"
      role="tree"
      aria-label="Files in folder"
      {...grid.containerProps}
    >
      <div className="ghead">
        <span>Name</span>
        <span>Size</span>
        <span>Start</span>
        <span>End</span>
        <span>Duration</span>
        <span>Messages</span>
        <span>Modified</span>
        <span></span>
      </div>
      {flat.map((r) => {
        const f = r.node;
        const p = rowProps(f.id);
        const open = expanded.has(f.id);
        const cls =
          "grow" +
          (f.writing ? " writing" : "") +
          (r.isDir ? " dirrow" : "") +
          (grid.cursor === f.id ? " cursorrow" : "") +
          (grid.selection.has(f.id) ? " selrow" : "");
        return (
          <div
            key={f.id}
            id={p.id}
            onClick={p.onClick}
            role="treeitem"
            aria-selected={grid.selection.has(f.id)}
            aria-expanded={r.isDir ? open : undefined}
            className={cls}
            onContextMenu={(e) => {
              if (f.writing) return;
              e.preventDefault();
              gridRef.current.onRowClick(f.id, { mod: false, shift: false });
              cbs.onContextMenu(f, e.clientX, e.clientY, r.isDir);
            }}
          >
            <span className="nm" style={{ paddingLeft: r.depth * 16 }}>
              {r.isDir && (
                // Decorative caret: Left/Right already do its job, so it
                // opts out of the tab order (tabindex -1, per useGridview).
                <button
                  className="caret"
                  tabIndex={-1}
                  aria-hidden="true"
                  onClick={(e) => {
                    e.stopPropagation();
                    adapter.setExpanded(f.id, !open);
                  }}
                >
                  {open ? "▾" : "▸"}
                </button>
              )}
              {f.nm}
              {r.isDir ? "\\" : ""}
            </span>
            <span className="sz">
              {r.isDir ? `${f.children!.length} file${f.children!.length === 1 ? "" : "s"}`
                       : `${(f.mb ?? 0).toFixed(1)} MB`}
            </span>
            <span className="dt">{f.st ?? ""}</span>
            <span className="dt">{f.en ?? ""}</span>
            <span className="dt">{f.durS != null ? fmtDurS(f.durS) : ""}</span>
            <span className="dt">{f.msgs != null ? f.msgs.toLocaleString("en-US") : ""}</span>
            <span className="dt">{f.mo ?? ""}</span>
            <span>
              {!r.isDir && !f.writing && (
                <button
                  className="mini iconbtn"
                  title="Import"
                  aria-label="Import"
                  onClick={() => cbs.onImport(f)}
                >
                  {importIcon}
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface GridState {
  tree: FileNode[];
  expand: string[];
}

function mount(el: HTMLElement, cbs: Callbacks, defaultExpanded: string[] = []) {
  // render() is async in React 18: a setFiles call before the first
  // render must land in the initial state, not on a not-yet-bound setter.
  let pending: GridState = { tree: [], expand: [] };
  let setter: ((s: GridState) => void) | null = null;
  function App() {
    const [state, setState] = useState<GridState>(pending);
    setter = setState;
    return (
      <FileGrid
        tree={state.tree}
        cbs={cbs}
        defaultExpanded={defaultExpanded}
        ensureExpanded={state.expand}
      />
    );
  }
  createRoot(el).render(<App />);
  return {
    setFiles: (f: FileNode[], expand: string[] = []) => {
      pending = { tree: f, expand: [...pending.expand, ...expand] };
      setter?.(pending);
    },
  };
}

(window as unknown as { CannetFileGrid: unknown }).CannetFileGrid = { mount };
