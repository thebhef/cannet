// The **Storage › Project caches** row of the settings view: every
// project directory cannet holds cached data for, what it holds, and the
// two actions over it (ADR 0042 §5).
//
// This is the settings view's one custom renderer that is not a pointer
// to another editor — the list has no other home, and it lives here
// because "reclaim the disk that job from last month is using" is a
// storage question a user comes to settings for.
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

import { useCallback, useContext, useEffect, useState } from "react";

import { ProjectContext } from "./projectContext";
import { formatBytes } from "./statusLine";
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
  offersSaveAs,
  type ProjectCacheRow,
} from "./projectCaches";

export function ProjectCachesList() {
  const [rows, setRows] = useState<readonly ProjectCacheRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Read through the raw context rather than `useProjectContext`: the
  // renderer is dispatched from a table and must render standalone, and
  // Save As is the only thing it wants from the project.
  const project = useContext(ProjectContext);
  const projectPath = project?.projectPath ?? null;

  const refresh = useCallback(async () => {
    setRows(await loadProjectCaches());
  }, []);

  // Sizes are asked for, never polled: on open, and whenever the open
  // project changes — which is also what a Save As from a row below
  // produces.
  useEffect(() => {
    void refresh();
  }, [refresh, projectPath]);

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
          className="danger"
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
      {rows.map((row) => (
        <div
          key={row.root}
          className={`project-cache-row${row.state === "missing" ? " gone" : ""}`}
        >
          <span className={`project-cache-badge ${row.state}`}>
            {badgeLabel(row.state)}
          </span>
          <span className="project-cache-path" title={row.root}>
            {row.root}
          </span>
          <span className="project-cache-size">{formatBytes(row.bytes)}</span>
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
          <button
            type="button"
            className="danger"
            disabled={busy || !canDelete(row)}
            title={
              canDelete(row)
                ? "Removes this project's cache directory and forgets it. The project directory itself is not touched."
                : "Can't remove the cache directory of the project that's open. Clear it instead."
            }
            onClick={() => void run(() => deleteProjectCache(row.root))}
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
