import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from "react";
import type { IDockviewPanel, IDockviewPanelProps } from "dockview";

import {
  describeAppliedConfig,
  describeBusConnState,
  useConnectionStates,
} from "./connectionStates";
import { useProjectContext } from "./projectContext";
import { useElementRegistry, type RegistryEntry } from "./projectElements";
import { useSidecarStatus } from "./sidecarStatus";
import { useUndoGesture } from "./undoGesture";
import type { Bus, ProjectElement, ProjectElementKind } from "./types";
import { elementKindLabel, elementLabel } from "./elementLabel";
import { localVbusBinding, localVbusId, resolveServer } from "./types";
import {
  PROJECT_GRAPH_PANEL_COMPONENT,
  PROJECT_GRAPH_PANEL_ID,
  elementPanelComponent,
} from "./dockLayout";
import { defaultBusColor } from "./busColor";
import { useThemeName } from "./theme";
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

interface PanelParams {
  /// Ids of the sections (and Elements type groups) the user has
  /// folded away. Stored sparsely — a panel nobody folded persists
  /// nothing — and round-tripped through the dockview panel params, so
  /// it rides the layout blob into the workspace scope (ADR 0042 §3)
  /// and the project file, like every other panel's view state.
  collapsed?: unknown;
}

/// Section ids as persisted. Stable strings, not the header text: a
/// reworded header must not silently unfold everyone's panel.
const SECTION_PROJECT = "project";
const SECTION_ELEMENTS = "elements";
const SECTION_BUSES = "buses";
const SECTION_VBUSES = "virtual-buses";
const SECTION_CONNECTION = "connection";
const SECTION_DBC = "dbc";

/// Persisted id of one Elements type group.
function elementGroupId(kind: ProjectElementKind): string {
  return `${SECTION_ELEMENTS}/${kind}`;
}

/// The order the Elements inventory lists its type groups in — the
/// declaration order of `elementKindLabel`. A `Record` over the whole
/// union rather than an array, so adding an element kind is a compile
/// error here instead of a group that silently sorts first.
const KIND_ORDER: Record<ProjectElementKind, number> = {
  trace: 0,
  plot: 1,
  signals: 2,
  transmit: 3,
  filter: 4,
  rbs: 5,
  colormap: 6,
  generator: 7,
};

/// Read the persisted collapse set, tolerating whatever a hand-edited
/// or older layout carries (the params blob is round-tripped
/// opaquely, so nothing upstream validates it).
function collapsedFromParams(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * The project panel: New / Open / Save / Save As for the project file;
 * the project's elements (traces — and later plots, transmit messages
 * …) with Open / Focus / Remove; the configured bus(es) with Connect /
 * Disconnect; and the loaded DBCs with add / remove / "reload all from
 * disk". State and actions come from {@link useProjectContext} /
 * {@link useElementRegistry}.
 *
 * Every section folds, and so does each of the Elements inventory's
 * per-type groups; what is folded is persisted in the panel params.
 */
export function ProjectPanel(props: IDockviewPanelProps) {
  // A bus row's swatch shows the theme's wheel entry for its list
  // position until the user picks a color of their own.
  useThemeName();
  const p = useProjectContext();
  const reg = useElementRegistry();
  const sidecar = useSidecarStatus();
  const { api, containerApi } = props;
  const params = props.params as PanelParams | undefined;

  const [collapsed, setCollapsed] = useState<readonly string[]>(() =>
    collapsedFromParams(params?.collapsed),
  );
  const isCollapsed = (id: string) => collapsed.includes(id);
  const toggleCollapsed = (id: string) => {
    const next = collapsed.includes(id)
      ? collapsed.filter((k) => k !== id)
      : [...collapsed, id];
    setCollapsed(next);
    api.updateParameters({ ...(params ?? {}), collapsed: next });
  };
  /// Props every section header needs, so a section reads as one line.
  const fold = (id: string) => ({
    collapsed: isCollapsed(id),
    onToggle: () => toggleCollapsed(id),
  });

  // The Elements inventory, grouped by element kind. Registry order is
  // kept inside a group; the groups themselves take `KIND_ORDER`.
  const elementGroups = useMemo(() => {
    const byKind = new Map<ProjectElementKind, RegistryEntry[]>();
    for (const entry of reg.entries) {
      const list = byKind.get(entry.element.kind);
      if (list) list.push(entry);
      else byKind.set(entry.element.kind, [entry]);
    }
    return [...byKind].sort(([a], [b]) => KIND_ORDER[a] - KIND_ORDER[b]);
  }, [reg.entries]);

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
  // Connection state is the host's model, not ours: we subscribe and
  // render, never derive.
  const connStates = useConnectionStates();

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
      <CollapsibleSection title="Project" {...fold(SECTION_PROJECT)}>
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
      </CollapsibleSection>

      <CollapsibleSection title="Elements" {...fold(SECTION_ELEMENTS)}>
        {elementGroups.length === 0 && <div className="project-empty">No elements.</div>}
        {elementGroups.map(([kind, entries]) => (
          <CollapsibleSection
            key={kind}
            variant="group"
            title={elementKindLabel(kind)}
            {...fold(elementGroupId(kind))}
          >
            {entries.map((entry) => (
              <ElementRow
                key={entry.element.id}
                element={entry.element}
                panel={panelFor(entry.element.id)}
                onOpen={() => openElement(entry.element)}
                onRename={(name) => reg.update(entry.element.id, { name })}
                onRemove={() => reg.remove(entry.element.id)}
              />
            ))}
          </CollapsibleSection>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="Logical buses" {...fold(SECTION_BUSES)}>
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
          // The bus row's marker mirrors its single binding's state —
          // at most one binding per bus (ADR 0023), so there is nothing
          // to aggregate.
          const conn = describeBusConnState(connStates[bus.id], binding != null);
          const connState = connStates[bus.id];
          const appliedText =
            connState?.kind === "connected"
              ? describeAppliedConfig(connState.applied)
              : null;
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
                <span
                  className={`project-bus-state ${conn.tone}`}
                  title={conn.detail}
                  data-testid={`bus-conn-state-${bus.id}`}
                >
                  {conn.text}
                </span>
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
              {appliedText !== null && (
                <div
                  className="project-bus-applied"
                  title="What the host actually put on the wire for this bus at connect — not what the fields below say."
                  data-testid={`bus-applied-${bus.id}`}
                >
                  live: {appliedText}
                </div>
              )}
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
      </CollapsibleSection>

      <CollapsibleSection title="Virtual buses" {...fold(SECTION_VBUSES)}>
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
      </CollapsibleSection>

      <CollapsibleSection title="Connection" {...fold(SECTION_CONNECTION)}>
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
          connStates={connStates}
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
              connStates={connStates}
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
      </CollapsibleSection>

      <CollapsibleSection title="DBC" {...fold(SECTION_DBC)}>
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
      </CollapsibleSection>
    </div>
  );
}

/// One folding block: the heading stays a heading (so the panel keeps
/// its outline) and the disclosure button inside it carries
/// `aria-expanded`. The body is unmounted rather than hidden, matching
/// the RBS panel's collapsible rows — and keeping the panel's own
/// scroll range honest.
///
/// `variant="group"` is the smaller, indented form the Elements
/// inventory's per-type groups use.
function CollapsibleSection({
  title,
  collapsed,
  onToggle,
  variant = "section",
  children,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  variant?: "section" | "group";
  children?: ReactNode;
}) {
  const group = variant === "group";
  const Heading = group ? "h4" : "h3";
  return (
    <section className={group ? "project-group" : "project-section"}>
      <Heading>
        <button
          type="button"
          className="project-section-toggle"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {/* Glyph swap rather than a rotate, matching the RBS and
              transmit carets. Hidden from the accessible name — the
              button's own `aria-expanded` already says which way it
              points. */}
          <span className="project-section-caret" aria-hidden="true">
            {collapsed ? "▸" : "▾"}
          </span>
          {title}
        </button>
      </Heading>
      {!collapsed && children}
    </section>
  );
}

/// Pick a short stable id for a freshly-created bus (`b1`, `b2`, …).
/// Stable in the sense that two buses on the same project never share
/// an id; not stable across renames (since renaming doesn't change the
/// id).
/// One row in the project panel's Elements inventory: an inline-rename
/// input bound to the element's model-owned `name` (the project panel
/// is the canonical edit surface — ADR 0019), and Open / Focus /
/// Remove. The kind isn't repeated per row — the row sits under its
/// kind's group header.
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
  // A rename writes the element on every keystroke, so the edit is an
  // undo *gesture* the way a drag is: focus opens it and blur closes
  // it, and the keystrokes in between fold into one step. Focus/blur
  // rather than an idle timer because the edit has a real beginning and
  // end in the DOM — no window to guess at, and the step closes exactly
  // when the user leaves the field.
  const undoGesture = useUndoGesture();
  return (
    <div className="project-element">
      <input
        type="text"
        className="project-bus-name-input"
        value={element.name ?? ""}
        onChange={(e) => onRename(e.target.value)}
        onFocus={() => undoGesture.begin()}
        onBlur={() => undoGesture.end()}
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
