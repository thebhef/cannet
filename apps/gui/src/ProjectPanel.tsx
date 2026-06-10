import { useEffect, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { IDockviewPanel, IDockviewPanelProps } from "dockview";

import { useProjectContext } from "./projectContext";
import { useElementRegistry } from "./projectElements";
import type {
  Bus,
  InterfaceBinding,
  InterfaceRecord,
  ProjectElement,
} from "./types";
import { PLOT_PANEL_COMPONENT, TRACE_PANEL_COMPONENT } from "./dockLayout";

/**
 * The project panel: New / Open / Save / Save As for the project file;
 * the project's elements (traces — and later plots, transmit messages
 * …) with Open / Focus / Remove; the configured bus(es) with Connect /
 * Disconnect; and the loaded DBCs with add / remove / "reload all from
 * disk". State and actions come from {@link useProjectContext} /
 * {@link useElementRegistry}.
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
    if (el.kind === "plot") {
      containerApi.addPanel({
        id: `plot-${el.id}`,
        component: PLOT_PANEL_COMPONENT,
        title: "Plot",
        params: { elementId: el.id },
      });
      return;
    }
    containerApi.addPanel({
      id: `trace-${el.id}`,
      component: TRACE_PANEL_COMPONENT,
      title: "Trace",
      params: { elementId: el.id, mode: "by-id" },
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
                {el.kind}
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
        <h3>Connection</h3>
        {p.blfPath && (
          <div className="project-bus">
            <span className="project-bus-name" title={p.blfPath}>
              BLF: {basename(p.blfPath)}
            </span>
          </div>
        )}
        {p.interfaceBindings.length === 0 ? (
          <div className="project-empty">
            No interface bindings. Add one below to enable Connect.
          </div>
        ) : (
          <>
            {uniqueServers(p.interfaceBindings).map((server) => {
              const isConnected = p.connectedAddresses.includes(server);
              return (
                <div className="project-bus" key={server}>
                  <span className="project-bus-name" title={server}>
                    {server}
                  </span>
                  <span
                    className={`project-bus-state ${isConnected ? "connected" : ""}`}
                  >
                    {isConnected ? "connected" : "offline"}
                  </span>
                </div>
              );
            })}
            <div className="project-buttons">
              {p.remoteConnected ? (
                <button type="button" onClick={p.onDisconnect}>
                  Disconnect all
                </button>
              ) : (
                <button type="button" onClick={p.onConnect}>
                  Connect all
                </button>
              )}
            </div>
          </>
        )}
      </section>

      <section className="project-section">
        <h3>Logical buses</h3>
        {p.buses.length === 0 && <div className="project-empty">No buses.</div>}
        {p.buses.map((bus) => (
          <div className="project-bus" key={bus.id}>
            <input
              type="text"
              className="project-bus-name-input"
              value={bus.name}
              onChange={(e) => p.onRenameBus(bus.id, e.target.value)}
              aria-label={`bus ${bus.id} name`}
            />
            <span className="project-bus-state" title={bus.id}>
              id: {bus.id}
            </span>
            <button type="button" onClick={() => p.onRemoveBus(bus.id)}>
              Remove
            </button>
          </div>
        ))}
        <div className="project-buttons">
          <button
            type="button"
            onClick={() => {
              const id = newBusId(p.buses.map((b) => b.id));
              p.onAddBus({ id, name: `Bus ${p.buses.length + 1}` });
            }}
          >
            Add bus
          </button>
        </div>
      </section>

      <section className="project-section">
        <h3>Interface bindings</h3>
        {p.interfaceBindings.length === 0 && (
          <div className="project-empty">No bindings.</div>
        )}
        {p.interfaceBindings.map((b) => {
          // Re-targeting a binding may only point at buses that don't
          // already have a different binding (each bus has at most one
          // interface). The currently-bound bus stays available so the
          // dropdown can display it.
          const otherBindings = p.interfaceBindings.filter(
            (x) => !(x.server === b.server && x.interface === b.interface),
          );
          const taken = new Set(otherBindings.map((x) => x.bus_id));
          const available = p.buses.filter(
            (bus) => bus.id === b.bus_id || !taken.has(bus.id),
          );
          return (
            <div className="project-bus" key={`${b.server}::${b.interface}`}>
              <span className="project-bus-name" title={`${b.server} / ${b.interface}`}>
                {b.interface} ({basename(b.server)})
              </span>
              <select
                value={b.bus_id}
                onChange={(e) =>
                  p.onAddBinding({ ...b, bus_id: e.target.value })
                }
                aria-label="binding bus"
              >
                {available.map((bus) => (
                  <option value={bus.id} key={bus.id}>
                    {bus.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => p.onRemoveBinding(b.server, b.interface)}
              >
                Remove
              </button>
            </div>
          );
        })}
        <NewBindingForm
          buses={p.buses}
          bindings={p.interfaceBindings}
          onAdd={p.onAddBinding}
        />
      </section>

      <section className="project-section">
        <h3>DBC</h3>
        {p.dbcPaths.length === 0 && <div className="project-empty">No DBCs loaded.</div>}
        {p.dbcPaths.map((path) => {
          const scoped = p.dbcBuses[path] ?? [];
          return (
            <div className="project-dbc" key={path}>
              <span className="project-dbc-name" title={path}>
                {basename(path)}
              </span>
              <button type="button" onClick={() => p.onRemoveDbc(path)}>
                Remove
              </button>
              {p.buses.length > 0 && (
                <div className="project-dbc-scoping">
                  <span className="project-dbc-scoping-label">
                    {scoped.length === 0 ? "all buses" : "scoped:"}
                  </span>
                  {p.buses.map((bus) => {
                    const on = scoped.includes(bus.id);
                    return (
                      <label key={bus.id} className="project-dbc-scoping-checkbox">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const next = on
                              ? scoped.filter((b) => b !== bus.id)
                              : [...scoped, bus.id];
                            p.onSetDbcBuses(path, next);
                          }}
                        />
                        {bus.name}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        <div className="project-buttons">
          <button type="button" onClick={p.onAddDbc}>
            Add…
          </button>
          {p.dbcPaths.length > 0 && (
            <button type="button" onClick={p.onReloadDbc}>
              Reload all from disk
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

/// Pick a short stable id for a freshly-created bus (`b1`, `b2`, …).
/// Stable in the sense that two buses on the same project never share
/// an id; not stable across renames (since renaming doesn't change the
/// id).
function newBusId(existing: readonly string[]): string {
  for (let i = 1; ; i++) {
    const candidate = `b${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/// Distinct server addresses referenced by any binding, in first-seen
/// order. Used by the Connection section to surface per-server status
/// (one row per server, regardless of how many bindings target it).
function uniqueServers(bindings: readonly InterfaceBinding[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of bindings) {
    if (seen.has(b.server)) continue;
    seen.add(b.server);
    out.push(b.server);
  }
  return out;
}

const DEFAULT_BINDING_SERVER = "127.0.0.1:50051";

interface NewBindingFormProps {
  buses: readonly Bus[];
  bindings: readonly InterfaceBinding[];
  onAdd: (binding: InterfaceBinding) => void;
}

/// Form for creating a new interface binding. The user types a server
/// address, hits "Discover" to list its interfaces, picks one, picks an
/// unbound bus, and clicks "Add". Each bus is allowed at most one
/// binding, so the bus picker hides buses that already have one.
function NewBindingForm({ buses, bindings, onAdd }: NewBindingFormProps) {
  const [server, setServer] = useState(DEFAULT_BINDING_SERVER);
  const [discovered, setDiscovered] = useState<InterfaceRecord[] | null>(null);
  const [iface, setIface] = useState("");
  const [busId, setBusId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const takenBusIds = new Set(bindings.map((b) => b.bus_id));
  const availableBuses = buses.filter((b) => !takenBusIds.has(b.id));

  const handleDiscover = async () => {
    const addr = server.trim();
    if (!addr) return;
    setBusy(true);
    setError(null);
    try {
      const records = await invoke<InterfaceRecord[]>(
        "list_remote_interfaces",
        { address: addr },
      );
      setDiscovered(records);
      if (records.length > 0 && !iface) setIface(records[0].id);
    } catch (err) {
      setError(String(err));
      setDiscovered([]);
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = () => {
    if (!server.trim() || !iface || !busId) return;
    onAdd({ server: server.trim(), interface: iface, bus_id: busId });
    // Keep the server so the user can add another binding without
    // re-typing; clear the picks.
    setIface("");
    setBusId("");
  };

  const canAdd =
    server.trim().length > 0 && iface.length > 0 && busId.length > 0;

  return (
    <div className="project-binding-form">
      <div className="project-binding-form-row">
        <input
          type="text"
          className="project-binding-server"
          value={server}
          onChange={(e) => {
            setServer(e.target.value);
            setDiscovered(null);
            setIface("");
          }}
          placeholder="host:port"
          aria-label="server address"
        />
        <button type="button" onClick={handleDiscover} disabled={busy}>
          {busy ? "…" : "Discover"}
        </button>
      </div>
      <div className="project-binding-form-row">
        {discovered === null ? (
          <input
            type="text"
            value={iface}
            onChange={(e) => setIface(e.target.value)}
            placeholder="interface (e.g. can0)"
            aria-label="interface id"
          />
        ) : (
          <select
            value={iface}
            onChange={(e) => setIface(e.target.value)}
            aria-label="interface id"
            disabled={discovered.length === 0}
          >
            <option value="">— pick interface —</option>
            {discovered.map((r) => (
              <option value={r.id} key={r.id}>
                {r.display_name || r.id}
              </option>
            ))}
          </select>
        )}
        <select
          value={busId}
          onChange={(e) => setBusId(e.target.value)}
          aria-label="bus"
          disabled={availableBuses.length === 0}
        >
          <option value="">
            {availableBuses.length === 0 ? "— no free bus —" : "— pick bus —"}
          </option>
          {availableBuses.map((b) => (
            <option value={b.id} key={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={handleAdd} disabled={!canAdd}>
          Add binding
        </button>
      </div>
      {error && <div className="project-binding-form-error">{error}</div>}
    </div>
  );
}
