import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ChangeEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { IDockviewPanel, IDockviewPanelProps } from "dockview";

import { useProjectContext } from "./projectContext";
import { useElementRegistry } from "./projectElements";
import {
  describeSidecarStatus,
  useSidecarStatus,
} from "./sidecarStatus";
import type {
  Bus,
  InterfaceBinding,
  InterfaceRecord,
  ProjectElement,
  ProjectElementKind,
  SidecarStatus,
} from "./types";
import { LOCAL_SERVER, isLocalBinding, resolveServer } from "./types";
import {
  PROJECT_GRAPH_PANEL_COMPONENT,
  PROJECT_GRAPH_PANEL_ID,
  elementPanelComponent,
} from "./dockLayout";
import { defaultBusColor } from "./busColor";

/// Window title for an element's panel, by kind. `filter` has no panel
/// of its own (see `elementPanelComponent`); the entry is present only
/// to keep this a total map over `ProjectElementKind`.
const PANEL_TITLE: Record<ProjectElementKind, string> = {
  trace: "Trace",
  plot: "Plot",
  transmit: "Transmit",
  filter: "Filter",
};

/// Tauri event the host fires whenever its per-address interface
/// cache changes (ADR 0016). Must match
/// `interfaces::INTERFACES_CHANGED_EVENT` host-side.
const INTERFACES_CHANGED_EVENT = "interfaces-changed";

/// Sentinel `<option>` values for the per-bus interface combo. Real
/// picks encode `${server}\x00${interface}`; these two are control
/// values the onChange handler intercepts.
const COMBO_NONE = "";
const COMBO_ADD_SERVER = "__add_server__";

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
  const sidecarAddress =
    sidecar.phase === "ready" ? sidecar.address : null;
  const knownServers = useMemo(() => {
    const set = new Set<string>();
    if (sidecarAddress) set.add(sidecarAddress);
    for (const b of p.interfaceBindings) {
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
      title: PANEL_TITLE[el.kind],
      params:
        el.kind === "trace"
          ? { elementId: el.id, mode: "by-id" }
          : el.kind === "transmit"
            ? { elementId: el.id, frames: [] }
            : { elementId: el.id },
    });
  };

  // Switch (or clear) the binding for `bus`. Bindings are keyed by
  // `(server, interface)` host-side (last-write-wins), so changing a
  // bus's interface is "remove the bus's current binding, then add
  // the new one" — otherwise the old binding would still point at
  // this bus.
  const setBusInterface = useCallback(
    (bus: Bus, pick: { server: string; iface: string } | null) => {
      const current = p.interfaceBindings.find((b) => b.bus_id === bus.id);
      if (current) {
        if (
          pick &&
          pick.server === current.server &&
          pick.iface === current.interface
        ) {
          return; // no-op
        }
        p.onRemoveBinding(current.server, current.interface);
      }
      if (pick) {
        p.onAddBinding({
          server: pick.server,
          interface: pick.iface,
          bus_id: bus.id,
        });
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
            No interfaces selected. Pick one on a logical bus below to enable
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
        <h3>Logical buses</h3>
        {p.buses.length === 0 && <div className="project-empty">No buses.</div>}
        {p.buses.map((bus, i) => {
          const binding = p.interfaceBindings.find((b) => b.bus_id === bus.id);
          const adding = addingForBus === bus.id;
          return (
            <div className="project-bus-row" key={bus.id}>
              <div className="project-bus">
                <input
                  type="color"
                  className="project-bus-color"
                  value={bus.color ?? defaultBusColor(i)}
                  onChange={(e) => p.onSetBusColor(bus.id, e.target.value)}
                  aria-label={`bus ${bus.id} colour`}
                  title="Graph colour for this bus"
                />
                <input
                  type="text"
                  className="project-bus-name-input"
                  value={bus.name}
                  onChange={(e) => p.onRenameBus(bus.id, e.target.value)}
                  aria-label={`bus ${bus.id} name`}
                />
                <BusInterfaceCombo
                  bus={bus}
                  binding={binding ?? null}
                  bindings={p.interfaceBindings}
                  sidecarAddress={sidecarAddress}
                  discoveries={discovery.entries}
                  onPick={(pick) => setBusInterface(bus, pick)}
                  onAddServer={() => setAddingForBus(bus.id)}
                />
                <button type="button" onClick={() => p.onRemoveBus(bus.id)}>
                  Remove
                </button>
              </div>
              {adding && (
                <AddServerInline
                  busLabel={bus.name}
                  onCancel={() => setAddingForBus(null)}
                  onPick={(pick) => {
                    setBusInterface(bus, pick);
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

/// Distinct **non-sidecar** server addresses referenced by any
/// binding, in first-seen order. The local sidecar gets its own
/// dedicated row in the Connection section (always present, with its
/// own status text), so listing it again here would double-count it.
/// The `sidecarAddress` parameter is unused today (kept for callers
/// passing it positionally) — locality is decided by the `"local"`
/// sentinel on the binding itself, not by address comparison.
export function uniqueRemoteServers(
  bindings: readonly InterfaceBinding[],
  _sidecarAddress: string | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of bindings) {
    if (isLocalBinding(b)) continue;
    if (seen.has(b.server)) continue;
    seen.add(b.server);
    out.push(b.server);
  }
  return out;
}

// ---- Discovery polling ----------------------------------------------------

/// One server's last polled state. `pending` = no discovery attempt has
/// returned yet (initial state); `ok` carries the interface list (which
/// can be empty if the server has none); `err` carries the last error
/// string so the row can show "(unreachable)" instead of going blank.
type DiscoveryState =
  | { status: "pending" }
  | { status: "ok"; interfaces: InterfaceRecord[] }
  | { status: "err"; error: string };

interface DiscoveryRegistry {
  entries: Record<string, DiscoveryState>;
  refresh: (address: string) => Promise<void>;
}

/// Maintains a host-side discovery snapshot per address in
/// `addresses`. No polling here — the hook subscribes to the host's
/// {@link INTERFACES_CHANGED_EVENT} (per ADR 0016) and tells the host
/// which remote addresses to watch via the `watch_interfaces` /
/// `unwatch_interfaces` Tauri commands. The local sidecar address is
/// auto-watched by the sidecar lifecycle host-side; calling `watch`
/// for it again is harmless (the host de-duplicates).
function useInterfaceDiscovery(addresses: readonly string[]): DiscoveryRegistry {
  const [entries, setEntries] = useState<Record<string, DiscoveryState>>({});

  /// One-shot `ListInterfaces` pull. Wired to the "Discover" buttons:
  /// the user wants the freshest answer right now without waiting for
  /// the next push. The host folds the result into the same cache
  /// the watch streams update, so a successful pull emits the
  /// matching `interfaces-changed` event for every other listener.
  const refresh = useCallback(async (address: string) => {
    if (!address) return;
    try {
      const records = await invoke<InterfaceRecord[]>(
        "refresh_interfaces",
        { address },
      );
      setEntries((prev) => ({
        ...prev,
        [address]: { status: "ok", interfaces: records },
      }));
    } catch (err) {
      setEntries((prev) => ({
        ...prev,
        [address]: { status: "err", error: String(err) },
      }));
    }
  }, []);

  // Stable string fingerprint of the address set so subscription
  // effects don't tear down on every render — only when the set
  // actually changes.
  const addrKey = useMemo(() => [...addresses].sort().join("|"), [addresses]);

  // Subscribe / unsubscribe the host's watch tasks to match the
  // address set, fetch each address's initial cached snapshot, and
  // listen for change events. The host auto-watches the sidecar's
  // address through its lifecycle path; calling `watch_interfaces`
  // for it again is a no-op, so we treat every address uniformly.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    const subscribed = [...addresses];

    void (async () => {
      // Mark every address as pending until its initial snapshot
      // returns. A panel that opens onto a sidecar mid-restart shows
      // "(discovering…)" rather than "(no interfaces)" while the host
      // catches up.
      setEntries((prev) => {
        const next = { ...prev };
        for (const addr of subscribed) {
          if (!next[addr]) next[addr] = { status: "pending" };
        }
        return next;
      });
      // Tell the host to keep a watch task open for each address.
      for (const addr of subscribed) {
        try {
          await invoke("watch_interfaces", { address: addr });
        } catch (err) {
          if (!cancelled) {
            setEntries((prev) => ({
              ...prev,
              [addr]: { status: "err", error: String(err) },
            }));
          }
        }
      }
      // Hydrate from the cache (covers the case where the host
      // already has a snapshot we'd otherwise miss until the next
      // push).
      for (const addr of subscribed) {
        try {
          const records = await invoke<InterfaceRecord[]>("get_interfaces", {
            address: addr,
          });
          if (!cancelled && records.length > 0) {
            setEntries((prev) => ({
              ...prev,
              [addr]: { status: "ok", interfaces: records },
            }));
          }
        } catch {
          // Best-effort hydrate; the next push fills the gap.
        }
      }
      // Listen for change events. One global listener covers every
      // address — the payload carries the address.
      try {
        unlisten = await listen<{
          address: string;
          interfaces: InterfaceRecord[];
        }>(INTERFACES_CHANGED_EVENT, (e) => {
          if (cancelled) return;
          setEntries((prev) => ({
            ...prev,
            [e.payload.address]: {
              status: "ok",
              interfaces: e.payload.interfaces,
            },
          }));
        });
      } catch {
        // Same fallback as the sidecar hook: if `listen` itself fails,
        // we stay on whatever snapshot we already have.
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      // Drop the host's watch tasks for the addresses we were
      // managing. The sidecar address gets re-installed by the
      // lifecycle path on the next ready-transition; remote
      // addresses re-subscribe when a new binding to them is added.
      for (const addr of subscribed) {
        void invoke("unwatch_interfaces", { address: addr }).catch(() => {});
      }
    };
    // addrKey is the stable shape of the address set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addrKey]);

  // Prune entries for addresses no longer in the set. Without this,
  // removing the last binding to a server would still leave its stale
  // interface list available in the combo.
  useEffect(() => {
    setEntries((prev) => {
      const known = new Set(addresses);
      let changed = false;
      const next: Record<string, DiscoveryState> = {};
      for (const k of Object.keys(prev)) {
        if (known.has(k)) next[k] = prev[k];
        else changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addrKey]);

  return { entries, refresh };
}

// ---- Per-bus interface combo ---------------------------------------------

interface BusInterfaceComboProps {
  bus: Bus;
  binding: InterfaceBinding | null;
  bindings: readonly InterfaceBinding[];
  sidecarAddress: string | null;
  discoveries: Record<string, DiscoveryState>;
  onPick: (pick: { server: string; iface: string } | null) => void;
  onAddServer: () => void;
}

/// Combo box on a logical-bus row that lets the user pick which
/// interface that bus subscribes to. Local sidecar interfaces are
/// listed at the top level; remote servers (any address referenced by
/// an existing binding) are grouped beneath. "+ Add server…" opens an
/// inline form to bind a server that isn't in the bindings yet.
export function BusInterfaceCombo({
  bus,
  binding,
  bindings,
  sidecarAddress,
  discoveries,
  onPick,
  onAddServer,
}: BusInterfaceComboProps) {
  // Selected option's `value`. When the binding's `(server, iface)` is
  // not currently in any discovery snapshot (server unreachable,
  // sidecar still starting), we still show it as the selection so the
  // user can see what the bus is bound to.
  const selectedValue = binding
    ? encodeOption(binding.server, binding.interface)
    : COMBO_NONE;

  // Which `(server, iface)` are already bound to a *different* bus.
  // The combo greys those out — last-write-wins on (server, iface)
  // means picking one would silently steal it from the other bus, and
  // that's almost never what the user wants.
  const takenByOtherBus = new Set<string>();
  for (const b of bindings) {
    if (b.bus_id === bus.id) continue;
    takenByOtherBus.add(encodeOption(b.server, b.interface));
  }

  const localList: InterfaceRecord[] =
    sidecarAddress &&
    discoveries[sidecarAddress]?.status === "ok"
      ? (discoveries[sidecarAddress] as { interfaces: InterfaceRecord[] })
          .interfaces
      : [];

  // Remote servers we have *some* state for (pending / ok / err),
  // excluding the sidecar (which is rendered top-level above). We
  // include `pending` and `err` so the user can see the group is
  // there even before its first successful discovery.
  const remoteAddrs = Object.keys(discoveries)
    .filter((a) => a !== sidecarAddress)
    .sort();

  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === COMBO_ADD_SERVER) {
      // Don't change the binding — open the inline form. The select
      // jumps back to the previous selection on the next render.
      onAddServer();
      return;
    }
    if (v === COMBO_NONE) {
      onPick(null);
      return;
    }
    const decoded = decodeOption(v);
    if (decoded) onPick(decoded);
  };

  return (
    <select
      className="project-bus-iface-combo"
      value={selectedValue}
      onChange={handleChange}
      aria-label={`bus ${bus.id} interface`}
    >
      <option value={COMBO_NONE}>— no interface —</option>
      {/* Local interfaces are intentionally NOT under an <optgroup> —
          they're the default surface, so they live at the top level of
          the combo rather than nested under a "Local" group. */}
      {localList.map((r) =>
        renderInterfaceOption(
          LOCAL_SERVER,
          r,
          "Local",
          takenByOtherBus,
          binding,
        ),
      )}
      {remoteAddrs.map((addr) => {
        const state = discoveries[addr];
        if (state.status === "ok") {
          return (
            <optgroup label={addr} key={addr}>
              {state.interfaces.length === 0 ? (
                <option value={`${addr}::empty`} disabled>
                  (no interfaces)
                </option>
              ) : (
                state.interfaces.map((r) =>
                  renderInterfaceOption(addr, r, addr, takenByOtherBus, binding),
                )
              )}
            </optgroup>
          );
        }
        return (
          <optgroup label={addr} key={addr}>
            <option value={`${addr}::status`} disabled>
              {state.status === "err"
                ? `(unreachable: ${state.error})`
                : "(discovering…)"}
            </option>
          </optgroup>
        );
      })}
      {/* If the currently-selected interface isn't in any discovery
          snapshot — server unreachable, or hasn't been polled yet —
          surface a synthetic option so `value=` still resolves to a
          known `<option>` and the combo doesn't look empty. */}
      {binding &&
        !optionInDiscoveries(binding, sidecarAddress, discoveries) && (
          <option value={selectedValue}>
            {labelFor(binding.server, binding.interface, sidecarAddress)}{" "}
            (offline)
          </option>
        )}
      <option value={COMBO_ADD_SERVER}>+ Add server…</option>
    </select>
  );
}

function renderInterfaceOption(
  server: string,
  rec: InterfaceRecord,
  serverLabel: string,
  takenByOtherBus: ReadonlySet<string>,
  selectedBinding: InterfaceBinding | null,
) {
  const value = encodeOption(server, rec.id);
  const isSelected =
    selectedBinding !== null &&
    selectedBinding.server === server &&
    selectedBinding.interface === rec.id;
  // An option already bound to another bus is disabled UNLESS it's
  // this bus's current selection — leaving the current selection
  // disabled would make it impossible to navigate the combo with the
  // keyboard.
  const disabled = takenByOtherBus.has(value) && !isSelected;
  const name = rec.display_name || rec.id;
  return (
    <option value={value} key={value} disabled={disabled}>
      {serverLabel} / {name}
      {disabled ? " (in use)" : ""}
    </option>
  );
}

function encodeOption(server: string, iface: string): string {
  return `${server}\x00${iface}`;
}

function decodeOption(value: string): { server: string; iface: string } | null {
  const i = value.indexOf("\x00");
  if (i < 0) return null;
  return { server: value.slice(0, i), iface: value.slice(i + 1) };
}

function labelFor(
  server: string,
  iface: string,
  _sidecarAddress: string | null,
): string {
  const head = server === LOCAL_SERVER ? "Local" : server;
  return `${head} / ${iface}`;
}

function optionInDiscoveries(
  binding: InterfaceBinding,
  sidecarAddress: string | null,
  discoveries: Record<string, DiscoveryState>,
): boolean {
  // A `"local"` binding's discovery state lives under the sidecar's
  // current address — the binding doesn't change shape across runs,
  // but the address it resolves to does.
  const key = resolveServer(binding.server, sidecarAddress);
  if (!key) return false;
  const state = discoveries[key];
  if (!state || state.status !== "ok") return false;
  return state.interfaces.some((r) => r.id === binding.interface);
}

// ---- Inline "Add server…" form -------------------------------------------

const DEFAULT_NEW_SERVER = "127.0.0.1:50051";

interface AddServerInlineProps {
  busLabel: string;
  onCancel: () => void;
  onPick: (pick: { server: string; iface: string }) => void;
}

/// Inline form that appears under a bus row when the user picks
/// "+ Add server…" in that bus's combo. Type an address, click
/// Discover, pick an interface, confirm — that single confirm both
/// adds the server to the project (by way of the new binding) and
/// binds the chosen interface to this bus.
export function AddServerInline({ busLabel, onCancel, onPick }: AddServerInlineProps) {
  const [server, setServer] = useState(DEFAULT_NEW_SERVER);
  const [records, setRecords] = useState<InterfaceRecord[] | null>(null);
  const [iface, setIface] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDiscover = async () => {
    const addr = server.trim();
    if (!addr) return;
    setBusy(true);
    setError(null);
    try {
      // `refresh_interfaces` does the same `ListInterfaces` pull the
      // old `list_remote_interfaces` did, with the side-effect of
      // updating the host's per-address cache — so the moment we
      // bind, the combo on the bus shows the rest of the server's
      // interfaces too.
      const recs = await invoke<InterfaceRecord[]>("refresh_interfaces", {
        address: addr,
      });
      setRecords(recs);
      if (recs.length > 0) setIface(recs[0].id);
    } catch (err) {
      setError(String(err));
      setRecords([]);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = () => {
    const addr = server.trim();
    if (!addr || !iface) return;
    onPick({ server: addr, iface });
  };

  return (
    <div className="project-binding-form" data-testid="add-server-inline">
      <div className="project-binding-form-source">
        <span className="project-binding-form-or">
          Add server for <strong>{busLabel}</strong>:
        </span>
      </div>
      <div className="project-binding-form-row">
        <input
          type="text"
          className="project-binding-server"
          value={server}
          onChange={(e) => {
            setServer(e.target.value);
            setRecords(null);
            setIface("");
          }}
          placeholder="host:port"
          aria-label="server address"
        />
        <button type="button" onClick={handleDiscover} disabled={busy}>
          {busy ? "…" : "Discover"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {records !== null && (
        <div className="project-binding-form-row">
          <select
            value={iface}
            onChange={(e) => setIface(e.target.value)}
            aria-label="interface id"
            disabled={records.length === 0}
          >
            {records.length === 0 ? (
              <option value="">— no interfaces —</option>
            ) : (
              <>
                <option value="">— pick interface —</option>
                {records.map((r) => (
                  <option value={r.id} key={r.id}>
                    {r.display_name || r.id}
                  </option>
                ))}
              </>
            )}
          </select>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!iface}
          >
            Bind to {busLabel}
          </button>
        </div>
      )}
      {error && <div className="project-binding-form-error">{error}</div>}
    </div>
  );
}

// ---- Connection-section rows ---------------------------------------------

interface LocalInterfacesRowProps {
  sidecar: SidecarStatus;
  bindings: readonly InterfaceBinding[];
  buses: readonly Bus[];
  discoveries: Record<string, DiscoveryState>;
  onRefresh: () => void;
}

/// "Local interfaces" row in the Connection section. Always rendered
/// (even when the local driver is offline) so the user has a fixed
/// handle for the local path. Lists every binding currently pointed
/// at the sidecar's address. When the sidecar isn't ready, the row
/// surfaces an error indicator and a "Restart" button (which calls the
/// `restart_sidecar` Tauri command) — the only place the sidecar's
/// implementation detail leaks into the UI label.
function LocalInterfacesRow({
  sidecar,
  bindings,
  buses,
  discoveries,
  onRefresh,
}: LocalInterfacesRowProps) {
  const ready = sidecar.phase === "ready" && sidecar.address !== null;
  const sidecarAddress = ready ? sidecar.address : null;
  // Show local bindings regardless of sidecar phase — the row is the
  // fixed handle for the local path. When the sidecar isn't ready,
  // the list still surfaces what's bound so the user can see what
  // will reattach once it comes up.
  const selected = bindings.filter(isLocalBinding);
  const handleRestart = () => {
    void invoke("restart_sidecar").catch(() => {
      // The host already surfaces a System Message on restart failure;
      // swallowing here keeps the row UI from double-reporting.
    });
  };
  return (
    <div className="project-server" data-testid="local-interfaces-row">
      <div className="project-bus">
        <span
          className="project-bus-name"
          title={sidecar.address ?? "Local driver (python-can sidecar)"}
        >
          Local interfaces
        </span>
        <span
          className={`project-bus-state ${
            ready ? "connected" : sidecar.phase === "starting" ? "" : "errored"
          }`}
          title={describeSidecarStatus(sidecar)}
        >
          {ready
            ? "ready"
            : sidecar.phase === "starting"
              ? "starting…"
              : "offline"}
        </span>
        <button type="button" onClick={onRefresh} disabled={!ready}>
          Discover
        </button>
        <button type="button" onClick={handleRestart}>
          Restart
        </button>
      </div>
      <LocalInterfaceList
        bindings={selected}
        buses={buses}
        discoveries={discoveries}
        sidecarAddress={sidecarAddress}
      />
    </div>
  );
}

/// Per-interface listing under the Local interfaces row. Unlike the
/// remote-row list — which only enumerates *bound* interfaces — this
/// one always shows every interface the local driver advertises, with
/// each row annotated either `→ <bus>` for a bound interface or
/// `(unassigned)` when nothing on the project routes through it yet.
/// The aim is for the row to read as "what hardware does this machine
/// actually have," not "what hardware did the user already wire up."
export function LocalInterfaceList({
  bindings,
  buses,
  discoveries,
  sidecarAddress,
}: {
  bindings: readonly InterfaceBinding[];
  buses: readonly Bus[];
  discoveries: Record<string, DiscoveryState>;
  sidecarAddress: string | null;
}) {
  const state = sidecarAddress ? discoveries[sidecarAddress] : undefined;
  const discovered: readonly InterfaceRecord[] =
    state && state.status === "ok" ? state.interfaces : [];

  // Bindings whose interface id no longer appears in the live
  // enumeration (sidecar restarted with different hardware, a legacy
  // v4 binding now stranded — see PROJECT_SCHEMA_VERSION v5 doc).
  // Render them as a tail with the raw id so the user can see what
  // their project still references.
  const discoveredIds = new Set(discovered.map((r) => r.id));
  const orphanBindings = bindings.filter((b) => !discoveredIds.has(b.interface));

  if (discovered.length === 0 && orphanBindings.length === 0) {
    return (
      <div className="project-server-empty">
        {state?.status === "err"
          ? `(unreachable: ${state.error})`
          : sidecarAddress === null
            ? "(local driver offline)"
            : "(no local interfaces)"}
      </div>
    );
  }

  return (
    <ul className="project-server-bindings">
      {discovered.map((rec) => {
        const binding = bindings.find((b) => b.interface === rec.id);
        const bus = binding
          ? buses.find((x) => x.id === binding.bus_id)
          : null;
        return (
          <li key={rec.id}>
            <span className="project-server-iface">
              {rec.display_name || rec.id}
            </span>
            <span className="project-server-arrow"> → </span>
            <span
              className={`project-server-bus ${bus ? "" : "unassigned"}`}
            >
              {bus ? bus.name : "(unassigned)"}
            </span>
          </li>
        );
      })}
      {orphanBindings.map((b) => {
        const bus = buses.find((x) => x.id === b.bus_id);
        return (
          <li key={`orphan::${b.interface}`} className="project-server-orphan">
            <span className="project-server-iface">{b.interface}</span>
            <span className="project-server-arrow"> → </span>
            <span className="project-server-bus">
              {bus ? bus.name : b.bus_id} (not currently present)
            </span>
          </li>
        );
      })}
    </ul>
  );
}

interface RemoteServerRowProps {
  server: string;
  connected: boolean;
  bindings: readonly InterfaceBinding[];
  buses: readonly Bus[];
  state: DiscoveryState | undefined;
  /// Full discovery map (across every known server) so the per-row
  /// binding list can resolve each id to its display label. The same
  /// `state` we pass separately is the entry keyed under this row's
  /// `server`; the broader map is here so {@link SelectedInterfaceList}
  /// can be shared with the local row, which keys differently.
  discoveries: Record<string, DiscoveryState>;
  onRefresh: () => void;
}

/// One remote-server row in the Connection section: address, last
/// polled state, manual Discover, and the list of bindings that
/// currently point at this server.
function RemoteServerRow({
  server,
  connected,
  bindings,
  buses,
  state,
  discoveries,
  onRefresh,
}: RemoteServerRowProps) {
  const selected = bindings.filter((b) => b.server === server);
  const stateText =
    state?.status === "err"
      ? `unreachable: ${state.error}`
      : connected
        ? "connected"
        : state?.status === "ok"
          ? "offline"
          : "discovering…";
  return (
    <div className="project-server">
      <div className="project-bus">
        <span className="project-bus-name" title={server}>
          {server}
        </span>
        <span className={`project-bus-state ${connected ? "connected" : ""}`}>
          {stateText}
        </span>
        <button type="button" onClick={onRefresh}>
          Discover
        </button>
      </div>
      <SelectedInterfaceList
        selected={selected}
        buses={buses}
        discoveries={discoveries}
        sidecarAddress={null}
      />
    </div>
  );
}

function SelectedInterfaceList({
  selected,
  buses,
  discoveries,
  sidecarAddress,
}: {
  selected: readonly InterfaceBinding[];
  buses: readonly Bus[];
  /// Pass the discovery snapshot so each binding's interface id can
  /// be resolved to its rich {@link InterfaceRecord.display_name} —
  /// the same label the per-bus combo shows. When a binding's
  /// interface isn't in any current snapshot (server unreachable,
  /// sidecar still starting), the raw id is the fallback.
  discoveries: Record<string, DiscoveryState>;
  sidecarAddress: string | null;
}) {
  if (selected.length === 0) {
    return (
      <div className="project-server-empty">
        (no interfaces selected)
      </div>
    );
  }
  return (
    <ul className="project-server-bindings">
      {selected.map((b) => {
        const bus = buses.find((x) => x.id === b.bus_id);
        return (
          <li key={`${b.server}::${b.interface}`}>
            <span className="project-server-iface">
              {labelForBinding(b, discoveries, sidecarAddress)}
            </span>
            <span className="project-server-arrow"> → </span>
            <span className="project-server-bus">
              {bus ? bus.name : b.bus_id}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/// `<Local|server> / <display_name>` — the same shape the per-bus
/// combo renders, so the Connection-section bus list and the picker
/// agree letter-for-letter. Falls back to the raw `interface` id when
/// no discovery snapshot for the binding's server is available.
function labelForBinding(
  b: InterfaceBinding,
  discoveries: Record<string, DiscoveryState>,
  sidecarAddress: string | null,
): string {
  const head = isLocalBinding(b) ? "Local" : b.server;
  const key = resolveServer(b.server, sidecarAddress);
  const state = key ? discoveries[key] : undefined;
  if (state && state.status === "ok") {
    const rec = state.interfaces.find((r) => r.id === b.interface);
    if (rec) return `${head} / ${rec.display_name || rec.id}`;
  }
  return `${head} / ${b.interface}`;
}
