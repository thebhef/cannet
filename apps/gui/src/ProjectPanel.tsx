import type { IDockviewPanelProps } from "dockview";

import { useProjectContext } from "./projectContext";

/**
 * The project panel: New / Open / Save / Save As for the project file,
 * a list of the configured bus(es) with Connect / Disconnect, and the
 * referenced DBC with a "reload from disk" action. State and actions
 * come from {@link useProjectContext}; the panel is just the UI.
 */
export function ProjectPanel(_props: IDockviewPanelProps) {
  const p = useProjectContext();

  return (
    <div className="project-panel">
      <section className="project-section">
        <h3>Project</h3>
        <div className="project-path" title={p.projectPath ?? undefined}>
          {p.projectPath ? basename(p.projectPath) : "(unsaved)"}
        </div>
        <div className="project-buttons">
          <button type="button" onClick={p.onNewProject}>
            New
          </button>
          <button type="button" onClick={p.onOpenProject}>
            Open…
          </button>
          <button type="button" onClick={p.onSaveProject}>
            Save
          </button>
          <button type="button" onClick={p.onSaveProjectAs}>
            Save As…
          </button>
        </div>
      </section>

      <section className="project-section">
        <h3>Buses</h3>
        {p.blfPath && (
          <div className="project-bus">
            <span className="project-bus-name" title={p.blfPath}>
              BLF: {basename(p.blfPath)}
            </span>
          </div>
        )}
        <div className="project-bus">
          <span className="project-bus-name">{p.remoteAddress || "(no server set)"}</span>
          <span className={`project-bus-state ${p.remoteConnected ? "connected" : ""}`}>
            {p.remoteConnected ? "connected" : "offline"}
          </span>
          {p.remoteConnected ? (
            <button type="button" onClick={p.onDisconnect}>
              Disconnect
            </button>
          ) : (
            <button type="button" onClick={p.onConnect} disabled={!p.remoteAddress.trim()}>
              Connect
            </button>
          )}
        </div>
        {!p.blfPath && !p.remoteAddress.trim() && (
          <div className="project-empty">No bus configured.</div>
        )}
      </section>

      <section className="project-section">
        <h3>DBC</h3>
        {p.dbcPath ? (
          <div className="project-dbc">
            <span className="project-dbc-name" title={p.dbcPath}>
              {basename(p.dbcPath)}
            </span>
            <button type="button" onClick={p.onReloadDbc}>
              Reload from disk
            </button>
          </div>
        ) : (
          <div className="project-empty">No DBC attached.</div>
        )}
      </section>
    </div>
  );
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}
