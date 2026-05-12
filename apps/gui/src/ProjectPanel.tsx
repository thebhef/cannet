import { useEffect, useReducer } from "react";
import type { IDockviewPanel, IDockviewPanelProps } from "dockview";

import { useProjectContext } from "./projectContext";
import { useElementRegistry } from "./projectElements";
import type { ProjectElement } from "./types";
import { BY_ID_PANEL_COMPONENT, TRACE_PANEL_COMPONENT } from "./dockLayout";

/**
 * The project panel: New / Open / Save / Save As for the project file;
 * the project's elements (traces — and later plots, transmit messages
 * …) with Open / Focus / Remove; the configured bus(es) with Connect /
 * Disconnect; and the referenced DBC with "reload from disk". State and
 * actions come from {@link useProjectContext} / {@link useElementRegistry}.
 */
export function ProjectPanel(props: IDockviewPanelProps) {
  const p = useProjectContext();
  const reg = useElementRegistry();
  const { containerApi } = props;

  // The element list re-renders us (the registry context value
  // changes); also re-render when *panels* come and go so the Open /
  // Focus state stays right.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const d = containerApi.onDidLayoutChange(() => bump());
    return () => d.dispose();
  }, [containerApi]);

  const panelFor = (id: string): IDockviewPanel | undefined =>
    containerApi.panels.find(
      (panel) => (panel.params as { elementId?: unknown } | undefined)?.elementId === id,
    );

  const openElement = (el: ProjectElement) => {
    const byId = el.view === "by-id";
    containerApi.addPanel({
      id: `${byId ? "by-id" : "trace"}-${el.id}`,
      component: byId ? BY_ID_PANEL_COMPONENT : TRACE_PANEL_COMPONENT,
      title: byId ? "By ID" : "Trace",
      params: { elementId: el.id },
    });
  };

  return (
    <div className="project-panel">
      <section className="project-section">
        <h3>Project</h3>
        <div className="project-path" title={p.projectPath ?? undefined}>
          {p.dirty && <span className="project-dirty" title="unsaved changes">●</span>}
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
        <h3>Elements</h3>
        {reg.entries.length === 0 && <div className="project-empty">No elements.</div>}
        {reg.entries.map((entry) => {
          const el = entry.element;
          const panel = panelFor(el.id);
          return (
            <div className="project-element" key={el.id}>
              <span className="project-element-name">
                {el.view === "by-id" ? "by-ID view" : "trace"}
                {panel ? ` — ${panel.title}` : " (closed)"}
              </span>
              {panel ? (
                <button type="button" onClick={() => panel.api.setActive()}>
                  Focus
                </button>
              ) : (
                <button type="button" onClick={() => openElement(el)}>
                  Open
                </button>
              )}
              <button type="button" onClick={() => reg.remove(el.id)}>
                Remove
              </button>
            </div>
          );
        })}
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
