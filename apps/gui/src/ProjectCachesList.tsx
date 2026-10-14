// The **Storage › Project caches** row of the settings view: every
// project directory cannet holds cached data for, what it holds, and the
// two actions over it (ADR 0042 §5).
//
// This is the settings view's one custom renderer that is not a pointer
// to another editor — the list has no other home, and it lives here
// because "reclaim the disk that job from last month is using" is a
// storage question a user comes to settings for.
//
// A gridview (ADR 0044), not a flex column of its own: **one leaf row
// per project directory**, no branches, in a bounded row space with its
// own scrollbar, so the settings view's own scroll no longer walks
// through it. Modelled on `UnitCustomizations.tsx` — rows as plain
// elements over `arrayRowSpace`, not through the column framework: the
// settings renderer has nowhere to persist a resizable/reorderable
// column layout, so building one would be a gesture that forgets itself
// on every reopen.
//
// Three rules the markup exists to keep visible:
//
// - **Clear and Delete are different things.** Clear empties the cached
//   data and keeps the cache directory and the entry; Delete removes the
//   cache directory and forgets the project. **Neither touches the
//   project directory itself.**
// - **A missing project's row stays**, at zero bytes, until the user
//   deletes it — so Clear means the same thing on every row, and a
//   directory deleted outside the app can never stop the panel opening.
// - **`Save as…` belongs on the rows living in cache space**, because
//   this list is the one place a user sees that their project does.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { arrayRowSpace, type GridviewAdapter, type GridviewRow } from "./gridviewRows";
import { ProjectContext } from "./projectContext";
import { SettingsShownContext } from "./settingsShown";
import { formatBytes } from "./statusLine";
import { TwoStageRemoveButton } from "./TwoStageRemoveButton";
import { useGridview } from "./useGridview";
import { useScrollRestore } from "./useScrollRestore";
import { projectName } from "./windowTitle";
import {
  badgeLabel,
  canClear,
  canDelete,
  canSaveAs,
  cacheSummary,
  clearAllProjectCaches,
  clearProjectCache,
  deleteProjectCache,
  loadProjectCaches,
  locationLabel,
  offersSaveAs,
  PROJECT_CACHES_MEASURED_EVENT,
  type ProjectCacheRow,
} from "./projectCaches";

/// How many rows the bounded row space holds — what PageUp/PageDown
/// move by (`.project-caches-grid`'s max-height over a row).
const PAGE_ROWS = 8;

export function ProjectCachesList() {
  const [rows, setRows] = useState<readonly ProjectCacheRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Read through the raw context rather than `useProjectContext`: the
  // renderer is dispatched from a table and must render standalone, and
  // Save As is the only thing it wants from the project.
  const project = useContext(ProjectContext);
  const projectPath = project?.projectPath ?? null;
  const shown = useContext(SettingsShownContext);

  const refresh = useCallback(async () => {
    setRows(await loadProjectCaches());
  }, []);

  // Sizes are asked for, never polled (ADR 0002 DS-8): on open, whenever
  // the open project changes, and every time the settings view comes
  // back on screen — a cache that grew while the user was on another
  // panel shows its new size on return.
  useEffect(() => {
    void refresh();
  }, [refresh, projectPath, shown]);

  // The host answers the listing before it has walked anything and
  // measures in the background (ADR 0049); this is what asks again once
  // it has. Still not a poll — the walk is triggered by the listing, not
  // by a timer (ADR 0002 DS-8).
  useEffect(() => {
    const unlisten = listen(PROJECT_CACHES_MEASURED_EVENT, () => void refresh());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  // The open project's *file* path is not enough to follow. A Save As
  // onto that same `.cannet_prj` promotes the project out of its
  // auto-located directory and into the user's folder (ADR 0042 §2):
  // the session moves, the path string does not, and the row that was
  // `active` is now the one whose bytes can be reclaimed. The host
  // announces every re-root, and that is what this follows.
  useEffect(() => {
    const unlisten = listen("project-dir-changed", () => void refresh());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
        setError(null);
      } catch (err) {
        setError(String(err));
      }
      await refresh();
      setBusy(false);
    },
    [refresh],
  );

  // The gridview's row space (ADR 0044): one leaf per project
  // directory, flattened straight from `rows` — there is nothing to
  // group them under, so `isExpanded` never matters and no expanded
  // set is kept.
  const gridRows = useMemo<GridviewRow[]>(
    () => rows.map((row) => ({ id: row.root, kind: "leaf", expandable: false, depth: 0 })),
    [rows],
  );

  const listRef = useRef<HTMLDivElement | null>(null);
  // Read through a ref so the adapter's memo can close over the
  // gridview's row-id helper before `useGridview` has run — the same
  // forward reference `UnitCustomizations.tsx` uses, for the same
  // reason: `scrollToRow` only runs on a later interaction.
  const rowDomIdRef = useRef<(id: string) => string>((id) => id);

  const adapter = useMemo<GridviewAdapter>(() => {
    const space = arrayRowSpace(gridRows, () => false);
    return {
      ...space,
      // The rows are all in the document, so this is the "scroll it
      // just into view" arithmetic the other non-virtualized gridviews
      // use.
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
      setExpanded: () => {
        /* no branches to expand */
      },
      isSelectable: () => true,
    };
  }, [gridRows]);

  const grid = useGridview({ adapter, pageRows: PAGE_ROWS, idPrefix: "project-caches" });
  rowDomIdRef.current = grid.rowDomId;

  // Puts the row space's own scroll offset back across a settings-panel
  // hide and show — the same mechanism `SettingsPanel.tsx` uses for
  // `.settings-list`, shared rather than duplicated (`useScrollRestore.ts`).
  const onGridScroll = useScrollRestore(listRef, shown);

  return (
    <div className="project-caches">
      <div className="project-caches-head">
        <span className="project-caches-summary">
          {cacheSummary(rows)}
          <span className="project-caches-hint">
            {" "}
            — clearing removes cached data only, never a project directory
          </span>
        </span>
        <button
          type="button"
          disabled={busy || rows.every((r) => !canClear(r))}
          onClick={() => void run(clearAllProjectCaches)}
        >
          Clear all data caches
        </button>
      </div>
      {error !== null && <p className="project-caches-error">{error}</p>}
      {rows.length === 0 && (
        <p className="project-caches-empty">No project caches recorded.</p>
      )}
      <div className="project-caches-grid" ref={listRef} onScroll={onGridScroll} {...grid.containerProps}>
        {rows.map((row) => (
          <div
            key={row.root}
            id={grid.rowDomId(row.root)}
            className={`project-cache-row${row.state === "missing" ? " gone" : ""}${
              grid.cursor === row.root ? " cursor" : ""
            }${grid.selection.has(row.root) ? " selected" : ""}`}
            onClick={(e) => {
              grid.onRowClick(row.root, { mod: e.metaKey || e.ctrlKey, shift: e.shiftKey });
              // Clicking a row hands the grid the keyboard — the
              // container is the only thing in a gridview that holds
              // focus (ADR 0044) — unless the click was aimed at a
              // control that wants it itself.
              const target = e.target as HTMLElement | null;
              if (target?.closest("button") == null) listRef.current?.focus();
            }}
          >
            <span className={`project-cache-badge ${row.state}`}>{badgeLabel(row.state)}</span>
            <span
              className={`project-cache-location${row.auto_located ? " auto-located" : ""}`}
              title={
                row.auto_located
                  ? "The project file has no .cannet/ beside it, so cannet located its cache here. Save as… moves the project out of cache space."
                  : undefined
              }
            >
              {locationLabel(row)}
            </span>
            <span className="project-cache-info" title={row.root}>
              <span className="project-cache-name">
                {projectName(row.project_file) ?? "unsaved"}
              </span>
              <span className="project-cache-path">{row.root}</span>
            </span>
            <span
              className={`project-cache-size${row.bytes == null ? " pending" : ""}`}
              title={row.bytes == null ? "Measuring this cache…" : undefined}
            >
              {row.bytes == null ? "…" : formatBytes(row.bytes)}
            </span>
            {offersSaveAs(row) && (
              <button
                type="button"
                disabled={busy || !canSaveAs(row)}
                title={
                  canSaveAs(row)
                    ? "Choose a directory for this project and move it there."
                    : "Only the open project can be moved. Open this one first."
                }
                onClick={() => project?.onSaveProjectAs()}
              >
                Save as…
              </button>
            )}
            <button
              type="button"
              disabled={busy || !canClear(row)}
              title={
                row.state === "active"
                  ? "Empties this project's data cache, discarding the capture in progress. The project directory and its cache directory stay."
                  : "Empties this project's data cache. The project directory and its cache directory stay."
              }
              onClick={() => void run(() => clearProjectCache(row.root))}
            >
              Clear data cache
            </button>
            <TwoStageRemoveButton
              label="Delete"
              title={
                canDelete(row)
                  ? "Removes this project's cache directory and forgets it. The project directory itself is not touched."
                  : "Can't remove the cache directory of the project that's open. Clear it instead."
              }
              disabled={busy || !canDelete(row)}
              onRemove={() => void run(() => deleteProjectCache(row.root))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
