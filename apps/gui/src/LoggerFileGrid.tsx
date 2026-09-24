// The logger folder's file gridview (ADR 0044): a recursive listing of
// the folder's `.blf` files, subdirectories as branches, built on the
// app's real gridview layer — `useGridview` / `arrayRowSpace` /
// `gridviewSelection` — nothing reinvented.
//
// The tree and every file's header metadata (start, end, message count)
// come from the host (`list_logger_files`), cached there per file and
// invalidated by the file's modified time; this view holds only what is
// view-local — which directories are open, the context menu's position —
// and shapes the host's rows for rendering (CLAUDE.md § GUI
// architecture). The file a logger is writing right now is the host's
// live status, not a header scan, and needs no separate status line: it
// is this gridview's own writing row.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { Icon } from "./Icon";
import { arrayRowSpace, type GridviewAdapter, type GridviewRow } from "./gridviewRows";
import { GridviewHeader, GridviewRow as GridviewRowLine } from "./gridviewColumns";
import { isMacPlatform, isWindowsPlatform } from "./keybindings";
import {
  LOG_FILE_COLUMN_DEFS,
  logFileColumnsFromParams,
  logFileGridTemplateColumns,
  type LogFileColumnKey,
  type LogFileColumnState,
} from "./logFileColumns";
import { reorderColumn, resizeColumn, toggleColumn, visibleColumns } from "./traceColumns";
import { useGridview } from "./useGridview";
import { useHostMirror } from "./useHostMirror";
import { LOG_FILES_SCANNED_EVENT, LOGGERS_CHANGED_EVENT } from "./logger";
import {
  findLogNode,
  flattenLogTree,
  formatLogDuration,
  formatLogModified,
  formatLogSize,
  formatLogTimestamp,
  isSelectableLogNode,
  logPathSeparator,
  MESSAGE_COUNT_HINT,
  PENDING_CELL,
  PENDING_CELL_HINT,
  revealLabel,
  type LogFileNode,
} from "./logFileGrid";

const NO_NODES: readonly LogFileNode[] = [];

export interface LoggerFileGridProps {
  /// The logger's resolved absolute folder, or `null` while the folder
  /// template has not resolved to one (an error, or the panel is still
  /// loading). `null` renders nothing rather than listing the host's
  /// interpretation of an empty path.
  folder: string | null;
  /// Poll the listing while true. A logger that is writing may be
  /// growing the open file or about to roll to the next part, and only
  /// a start, a stop or a failure fires `loggers-changed` — a roll does
  /// not, so the listing has to ask again to notice one.
  writing: boolean;
  /// Open the typical import dialog on this file's absolute path — the
  /// app's existing import flow (the unsaved-capture guard, the channel
  /// mapping and range-selection dialog), reused rather than forked.
  onImport: (path: string) => void;
  /// The panel's saved column layout (its dockview params blob), if
  /// any. Parsed through the shared column-state parser, so a stale or
  /// malformed value falls back to the defaults.
  initialColumns?: unknown;
  /// Called with the new layout whenever the user resizes, reorders or
  /// hides a column — the panel persists it into its params.
  onColumnsChange?: (columns: LogFileColumnState[]) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: LogFileNode;
}

export function LoggerFileGrid({
  folder,
  writing,
  onImport,
  initialColumns,
  onColumnsChange,
}: LoggerFileGridProps) {
  const revealMenuLabel = useMemo(() => revealLabel(isMacPlatform(), isWindowsPlatform()), []);
  // The column layout, through the shared column layer — resize,
  // reorder and show/hide are its gestures, not this view's. Changes
  // are reported upward for the panel to persist; the mount value never
  // re-reads, like every other gridview's params-seeded layout.
  const [columns, setColumns] = useState<LogFileColumnState[]>(() =>
    logFileColumnsFromParams(initialColumns),
  );
  const onColumnsChangeRef = useRef(onColumnsChange);
  onColumnsChangeRef.current = onColumnsChange;
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    onColumnsChangeRef.current?.(columns);
  }, [columns]);
  const onColumnResize = useCallback(
    (key: LogFileColumnKey, width: number) => setColumns((cs) => resizeColumn(cs, key, width)),
    [],
  );
  const onColumnToggle = useCallback(
    (key: LogFileColumnKey) => setColumns((cs) => toggleColumn(cs, key)),
    [],
  );
  const onColumnReorder = useCallback(
    (key: LogFileColumnKey, beforeKey: LogFileColumnKey | null) =>
      setColumns((cs) => reorderColumn(cs, key, beforeKey)),
    [],
  );
  const visible = useMemo(() => visibleColumns(columns), [columns]);
  const gridTemplate = useMemo(() => logFileGridTemplateColumns(columns), [columns]);

  const fetchNodes = useCallback(
    (): Promise<readonly LogFileNode[]> =>
      folder == null
        ? Promise.resolve(NO_NODES)
        : invoke<LogFileNode[]>("list_logger_files", { folder }),
    [folder],
  );
  const { value: nodes, refresh } = useHostMirror<readonly LogFileNode[]>({
    fetch: fetchNodes,
    fallback: NO_NODES,
    event: LOGGERS_CHANGED_EVENT,
    pollWhile: () => writing,
  });

  // A listing answers with what the host already knows and leaves the
  // rest pending (ADR 0049); the host announces each background header
  // scan as it lands and this is what asks again. A folder of freshly
  // dropped files announces one per scan, and the mirror's single-flight
  // guard collapses that burst into one refetch per round trip.
  useEffect(() => {
    const unlisten = listen(LOG_FILES_SCANNED_EVENT, () => refresh());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  // View-local: which directories are open. A fresh listing (a new
  // folder) starts collapsed, like every other gridview tree in the app.
  const [expanded, setExpandedState] = useState<ReadonlySet<string>>(new Set());
  const setExpanded = useCallback((id: string, isExpanded: boolean) => {
    setExpandedState((prev) => {
      const next = new Set(prev);
      if (isExpanded) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const rows = useMemo(() => flattenLogTree(nodes, expanded), [nodes, expanded]);
  const gridRows = useMemo<GridviewRow[]>(
    () =>
      rows.map((r) => ({
        id: r.node.id,
        kind: r.node.kind === "dir" ? ("branch" as const) : ("leaf" as const),
        expandable: r.node.kind === "dir",
        depth: r.depth,
      })),
    [rows],
  );

  const listRef = useRef<HTMLDivElement | null>(null);
  // Read through a ref so `adapter`'s memo (below) can close over the
  // gridview's row-id helper before `useGridview` itself has run — the
  // same forward reference `BlfChannelMapModal`'s non-virtualized
  // markers list uses, for the same reason: `scrollToRow` is only
  // called on a later interaction, by which point the ref is set.
  const rowDomIdRef = useRef<(id: string) => string>((id) => id);

  const adapter = useMemo<GridviewAdapter>(() => {
    const space = arrayRowSpace(gridRows, (id) => expanded.has(id));
    return {
      ...space,
      scrollToRow(index) {
        const id = space.rowIdAt(index);
        const container = listRef.current;
        if (id == null || container == null) return;
        const el = document.getElementById(rowDomIdRef.current(id));
        if (el == null) return;
        const c = container.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.top < c.top) container.scrollTop += r.top - c.top;
        else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom;
      },
      setExpanded,
      isSelectable(row) {
        const node = findLogNode(nodes, row.id);
        return node != null && isSelectableLogNode(node);
      },
    };
  }, [gridRows, expanded, nodes, setExpanded]);

  const runImport = useCallback(
    (id: string) => {
      const node = findLogNode(nodes, id);
      if (node != null && isSelectableLogNode(node)) onImport(node.id);
    },
    [nodes, onImport],
  );

  const grid = useGridview({
    adapter,
    pageRows: 10,
    idPrefix: "logger-files",
    onPrimaryAction: runImport,
  });
  rowDomIdRef.current = grid.rowDomId;

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  useEffect(() => {
    if (contextMenu == null) return;
    const close = () => setContextMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  const reveal = useCallback((path: string) => {
    void invoke("reveal_in_file_manager", { path }).catch(() => {});
  }, []);

  if (folder == null) return null;

  return (
    <div className="logger-file-grid-wrap">
      <div
        className="logger-file-grid"
        ref={listRef}
        role="tree"
        aria-label="Files in folder"
        {...grid.containerProps}
      >
        <GridviewHeader<LogFileColumnKey>
          defs={LOG_FILE_COLUMN_DEFS}
          columns={columns}
          onColumnResize={onColumnResize}
          onColumnToggle={onColumnToggle}
          onColumnReorder={onColumnReorder}
        />
        {rows.length === 0 && <div className="logger-file-empty">No files yet.</div>}
        {rows.map(({ node, depth }) => {
          const isDir = node.kind === "dir";
          const isWriting = node.kind === "file" && node.writing;
          const rowClass = [
            "trace-row",
            "logger-file-row",
            isDir ? "dir" : null,
            isWriting ? "writing" : null,
            grid.cursor === node.id ? "cursor" : null,
            grid.selection.has(node.id) ? "selected" : null,
          ]
            .filter(Boolean)
            .join(" ");
          const fileCell = (text: string, className: string, title?: string) => (
            <span className={`${className} logger-file-cell`} title={title}>
              {text}
            </span>
          );
          // The host has not read this file's header yet. Its trace
          // columns say so rather than showing zeros that would read as
          // measurements (ADR 0049 — a partial answer is first-class and
          // announces itself).
          const pending = node.kind === "file" && node.scanPending;
          const traceCell = (text: string, className: string, title?: string) =>
            pending
              ? fileCell(PENDING_CELL, `${className} pending`, PENDING_CELL_HINT)
              : fileCell(text, className, title);
          return (
            <GridviewRowLine<LogFileColumnKey>
              key={node.id}
              defs={LOG_FILE_COLUMN_DEFS}
              columns={visible}
              gridTemplate={gridTemplate}
              id={grid.rowDomId(node.id)}
              role="treeitem"
              aria-selected={grid.selection.has(node.id)}
              aria-expanded={isDir ? expanded.has(node.id) : undefined}
              className={rowClass}
              onClick={(e) =>
                grid.onRowClick(node.id, { mod: e.metaKey || e.ctrlKey, shift: e.shiftKey })
              }
              onContextMenu={(e) => {
                if (isWriting) return;
                e.preventDefault();
                e.stopPropagation();
                grid.onRowClick(node.id, { mod: false, shift: false });
                setContextMenu({ x: e.clientX, y: e.clientY, node });
              }}
              renderCell={(key, className) => {
                switch (key) {
                  case "name":
                    return (
                      <span
                        className={`${className} logger-file-name`}
                        style={{ paddingLeft: depth * 16 }}
                      >
                        {isDir && (
                          <button
                            type="button"
                            className="logger-file-caret"
                            tabIndex={-1}
                            aria-hidden="true"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpanded(node.id, !expanded.has(node.id));
                            }}
                          >
                            {expanded.has(node.id) ? "▾" : "▸"}
                          </button>
                        )}
                        {isWriting && (
                          <span className="logger-file-dot" aria-hidden="true">
                            ●{" "}
                          </span>
                        )}
                        {node.name}
                        {isDir ? logPathSeparator(folder) : ""}
                      </span>
                    );
                  case "size":
                    return fileCell(node.kind === "file" ? formatLogSize(node.sizeBytes) : "", className);
                  case "start":
                    return traceCell(
                      node.kind === "file" ? formatLogTimestamp(node.startNs) : "",
                      className,
                    );
                  case "end":
                    return traceCell(
                      node.kind === "file" ? formatLogTimestamp(node.endNs) : "",
                      className,
                    );
                  case "duration":
                    return traceCell(
                      node.kind === "file" ? formatLogDuration(node.startNs, node.endNs) : "",
                      className,
                    );
                  case "messages":
                    return traceCell(
                      node.kind === "file" ? node.messageCount.toLocaleString() : "",
                      className,
                      node.kind === "file" ? MESSAGE_COUNT_HINT : undefined,
                    );
                  case "modified":
                    return fileCell(
                      node.kind === "file" ? formatLogModified(node.modifiedMs) : "",
                      className,
                    );
                  case "action":
                    return (
                      <span className={`${className} logger-file-action`}>
                        {node.kind === "file" && !node.writing && (
                          <button
                            type="button"
                            className="logger-file-import-btn"
                            title="Import"
                            aria-label="Import"
                            tabIndex={-1}
                            onClick={(e) => {
                              e.stopPropagation();
                              onImport(node.id);
                            }}
                          >
                            <Icon name="import" />
                          </button>
                        )}
                      </span>
                    );
                }
              }}
            />
          );
        })}
      </div>
      {contextMenu != null && (
        <div
          className="logger-file-ctx"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.node.kind === "file" && (
            <button
              type="button"
              onClick={() => {
                onImport(contextMenu.node.id);
                setContextMenu(null);
              }}
            >
              <Icon name="import" /> Import
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              reveal(contextMenu.node.id);
              setContextMenu(null);
            }}
          >
            {revealMenuLabel}
          </button>
        </div>
      )}
    </div>
  );
}
