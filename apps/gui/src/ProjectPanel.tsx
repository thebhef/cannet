import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import type { IDockviewPanel, IDockviewPanelProps } from "dockview";

import { useProjectContext } from "./projectContext";
import { useElementRegistry } from "./projectElements";
import { useSidecarStatus } from "./sidecarStatus";
import type { Bus, ProjectElement } from "./types";
import { elementKindLabel, elementLabel } from "./elementLabel";
import { localVbusBinding, localVbusId, resolveServer } from "./types";
import {
  PROJECT_GRAPH_PANEL_COMPONENT,
  PROJECT_GRAPH_PANEL_ID,
  elementPanelComponent,
} from "./dockLayout";
import { defaultBusColor } from "./busColor";
import {
  AddServerInline,
  BusHardwareConfig,
  BusInterfaceCombo,
  LocalInterfacesRow,
  RemoteServerRow,
  VirtualBusRow,
  samePick,
  uniqueRemoteServers,
  useInterfaceDiscovery,
  type ComboPick,
} from "./ConnectionManagement";

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
  const sidecar = useSidecarStatus();
  const { containerApi } = props;

  // The element list re-renders us (the registry context value
  // changes); also re-render when *panels* come and go so the Open /
  // Focus state stays right.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const d = containerApi.onDidLayoutChange(() => bump());
    return () => d.dispose();
  }, [containerApi]);

  // Servers we keep discovery state for: the local sidecar (when
  // ready) plus every distinct remote server referenced by a binding.
  // A binding with `server: "local"` is resolved to the live sidecar
  // address before subscribing — the host's `WatchInterfaces` cache
  // is keyed by concrete host:port pairs (ADR 0016).
  // `local-vbus://` URLs are in-process indices, not gRPC addresses,
  // so they're excluded from discovery (the host's `WatchInterfaces`
  // would otherwise loop trying to connect to a non-existent server).
  const sidecarAddress =
    sidecar.phase === "ready" ? sidecar.address : null;
  const knownServers = useMemo(() => {
    const set = new Set<string>();
    if (sidecarAddress) set.add(sidecarAddress);
    for (const b of p.interfaceBindings) {
      if (localVbusId(b) !== null) continue;
      const resolved = resolveServer(b.server, sidecarAddress);
      if (resolved) set.add(resolved);
    }
    return [...set];
  }, [sidecarAddress, p.interfaceBindings]);

  const discovery = useInterfaceDiscovery(knownServers);

  // Inline "Add server…" form per bus: `addingForBus === bus.id` means
  // the bus row shows the new-server form. `null` = no row is in the
  // adding state.
  const [addingForBus, setAddingForBus] = useState<string | null>(null);

  const panelFor = (id: string): IDockviewPanel | undefined =>
    containerApi.panels.find(
      (panel) => (panel.params as { elementId?: unknown } | undefined)?.elementId === id,
    );

  const openElement = (el: ProjectElement) => {
    const component = elementPanelComponent(el.kind);
    if (component === null) {
      // A `filter` has no panel of its own — it's edited inline on its
      // node in the project graph. Surface (or focus) the graph view
      // instead of mounting a trace panel, which would retype the
      // filter into a trace.
      const existing = containerApi.panels.find(
        (p) => p.id === PROJECT_GRAPH_PANEL_ID,
      );
      if (existing) existing.api.setActive();
      else
        containerApi.addPanel({
          id: PROJECT_GRAPH_PANEL_ID,
          component: PROJECT_GRAPH_PANEL_COMPONENT,
          title: "Graph",
        });
      return;
    }
    containerApi.addPanel({
      id: `${component}-${el.id}`,
      component,
      title: elementLabel(el),
      params:
        el.kind === "trace"
          ? { elementId: el.id, mode: "by-id" }
          : { elementId: el.id },
    });
  };

  // Switch (or clear) the binding for `bus`. Bindings are keyed by
  // `bus_id` (each project bus has at most one binding), so changing
  // a bus's source is "remove the bus's current binding, then add
  // the new one." A `null` pick clears the binding.
  const setBusInterface = useCallback(
    (bus: Bus, pick: ComboPick | null) => {
      const current = p.interfaceBindings.find((b) => b.bus_id === bus.id);
      if (pick && current && samePick(pick, current)) return;
      if (current) p.onRemoveBinding(current.bus_id);
      if (!pick) return;
      if (pick.kind === "remote") {
        p.onAddBinding({
          kind: "remote",
          server: pick.server,
          interface: pick.iface,
          bus_id: bus.id,
        });
      } else {
        p.onAddBinding(localVbusBinding(pick.virtual_bus_id, bus.id));
      }
    },
    [p],
  );

  const remoteServers = uniqueRemoteServers(
    p.interfaceBindings,
    sidecarAddress,
  );

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
        {reg.entries.map((entry) => (
          <ElementRow
            key={entry.element.id}
            element={entry.element}
            panel={panelFor(entry.element.id)}
            onOpen={() => openElement(entry.element)}
            onRename={(name) => reg.update(entry.element.id, { name })}
            onRemove={() => reg.remove(entry.element.id)}
          />
        ))}
      </section>

      <section className="project-section">
        <h3>Logical buses</h3>
        {p.buses.length === 0 && <div className="project-empty">No buses.</div>}
        {p.buses.map((bus, i) => {
          const binding = p.interfaceBindings.find((b) => b.bus_id === bus.id);
          const adding = addingForBus === bus.id;
          const pendingHwConfig = p.busesWithPendingHwConfig.includes(bus.id);
          // Local virtual buses have no controller behind them (the
          // host owns their arbitration timing). Hide the hardware
          // settings row for those bindings so the UI doesn't suggest
          // a knob that doesn't apply.
          const isLocalVbus = binding != null && localVbusId(binding) !== null;
          return (
            <div className="project-bus-row" key={bus.id}>
              <div className="project-bus">
                <input
                  type="color"
                  className="project-bus-color"
                  value={bus.color ?? defaultBusColor(i)}
                  onChange={(e) => p.onUpdateBus(bus.id, { color: e.target.value })}
                  aria-label={`bus ${bus.id} color`}
                  title="Graph color for this bus"
                />
                <input
                  type="text"
                  className="project-bus-name-input"
                  value={bus.name}
                  onChange={(e) => p.onUpdateBus(bus.id, { name: e.target.value })}
                  aria-label={`bus ${bus.id} name`}
                />
                {pendingHwConfig && (
                  <span
                    className="project-bus-pending-hw"
                    title="Hardware configuration changed since connect; reconnect to apply."
                  >
                    pending
                  </span>
                )}
                <button type="button" onClick={() => p.onRemoveBus(bus.id)}>
                  Remove
                </button>
              </div>
              <div className="project-bus-iface">
                <BusInterfaceCombo
                  bus={bus}
                  binding={binding ?? null}
                  sidecarAddress={sidecarAddress}
                  discoveries={discovery.entries}
                  localVirtualBuses={p.localVirtualBuses}
                  onPick={(pick) => setBusInterface(bus, pick)}
                  onAddServer={() => setAddingForBus(bus.id)}
                  onAddVirtualBus={() => {
                    const id = newVbusId(p.localVirtualBuses.map((v) => v.id));
                    const name = `Virtual ${p.localVirtualBuses.length + 1}`;
                    p.onAddVirtualBus({ id, name });
                    // Bind this bus to the freshly-created vbus.
                    setBusInterface(bus, { kind: "local-virtual-bus", virtual_bus_id: id });
                  }}
                />
              </div>
              {!isLocalVbus && (
                <BusHardwareConfig
                  bus={bus}
                  onSetSpeed={(v) => p.onUpdateBus(bus.id, { speed_bps: v })}
                  onSetFd={(v) => p.onUpdateBus(bus.id, { fd: v })}
                  onSetFdDataSpeed={(v) => p.onUpdateBus(bus.id, { fd_data_speed_bps: v })}
                />
              )}
              {adding && (
                <AddServerInline
                  busLabel={bus.name}
                  onCancel={() => setAddingForBus(null)}
                  onPick={(pick) => {
                    setBusInterface(bus, {
                      kind: "remote",
                      server: pick.server,
                      iface: pick.iface,
                    });
                    setAddingForBus(null);
                  }}
                />
              )}
            </div>
          );
        })}
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
        <h3>Virtual buses</h3>
        {p.localVirtualBuses.length === 0 && (
          <div className="project-empty">
            No virtual buses. Add one from a logical-bus combo, or here.
          </div>
        )}
        {p.localVirtualBuses.map((v) => (
          <VirtualBusRow
            key={v.id}
            def={v}
            bindings={p.interfaceBindings}
            buses={p.buses}
            onRename={(name) => p.onUpdateVirtualBus(v.id, { name })}
            onRemove={() => p.onRemoveVirtualBus(v.id)}
            onSetBridges={(bridges) =>
              p.onUpdateVirtualBus(v.id, { bridges })
            }
          />
        ))}
        <div className="project-buttons">
          <button
            type="button"
            onClick={() => {
              const id = newVbusId(p.localVirtualBuses.map((v) => v.id));
              p.onAddVirtualBus({
                id,
                name: `Virtual ${p.localVirtualBuses.length + 1}`,
              });
            }}
          >
            Add virtual bus
          </button>
        </div>
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
        <LocalInterfacesRow
          sidecar={sidecar}
          bindings={p.interfaceBindings}
          buses={p.buses}
          discoveries={discovery.entries}
          onRefresh={() => {
            if (sidecarAddress) void discovery.refresh(sidecarAddress);
          }}
        />
        {remoteServers.map((server) => {
          const state = discovery.entries[server];
          const isConnected = p.connectedAddresses.includes(server);
          return (
            <RemoteServerRow
              key={server}
              server={server}
              connected={isConnected}
              bindings={p.interfaceBindings}
              buses={p.buses}
              state={state}
              discoveries={discovery.entries}
              onRefresh={() => void discovery.refresh(server)}
            />
          );
        })}
        {p.interfaceBindings.length === 0 ? (
          <div className="project-empty">
            No interfaces selected. Pick one on a logical bus above to enable
            Connect.
          </div>
        ) : (
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
        )}
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
/// One row in the project panel's Elements inventory: the kind, an
/// inline-rename input bound to the element's model-owned `name`
/// (the project panel is the canonical edit surface — ADR 0019), and
/// Open / Focus / Remove.
export function ElementRow({
  element,
  panel,
  onOpen,
  onRename,
  onRemove,
}: {
  element: ProjectElement;
  panel: IDockviewPanel | undefined;
  onOpen: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="project-element">
      <span className="project-element-kind">{elementKindLabel(element.kind)}</span>
      <input
        type="text"
        className="project-bus-name-input"
        value={element.name ?? ""}
        onChange={(e) => onRename(e.target.value)}
        aria-label={`element ${element.id} name`}
      />
      {panel ? (
        <button type="button" onClick={() => panel.api.setActive()}>
          Focus
        </button>
      ) : (
        <button type="button" onClick={onOpen}>
          Open
        </button>
      )}
      <button type="button" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}

function newBusId(existing: readonly string[]): string {
  for (let i = 1; ; i++) {
    const candidate = `b${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

function newVbusId(existing: readonly string[]): string {
  for (let i = 1; ; i++) {
    const candidate = `vbus${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}
