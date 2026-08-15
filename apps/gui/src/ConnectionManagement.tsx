// Connection-management UI extracted from the project panel: interface
// discovery, the per-bus interface combo and hardware-config row, the
// Connection-section rows (local interfaces and one collapsible section
// per trusted server), and the virtual-bus rows. ProjectPanel composes
// these; the state and actions come from its contexts. Kept as a
// sibling module so ProjectPanel.tsx stays the panel shell.
//
// Servers are not managed from here. Which servers this machine talks
// to — and on what terms — is decided once in the Servers panel
// (ADR 0041); a bus row only picks among the interfaces those servers
// already offer, and its one server affordance is a jump to that panel.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { Combobox, type ComboboxOption } from "./Combobox";
import { describeBusConnState } from "./connectionStates";
import { DisclosureToggle } from "./DisclosureToggle";
import { hostSettings } from "./hostSettings";
import {
  formatClockOffset,
  serverKey,
  serverLabel,
  serverLabels,
  type ServerRow,
} from "./serverList";
import { describeSidecarStatus } from "./sidecarStatus";
import type {
  Bus,
  BridgeSpec,
  BusConnStates,
  InterfaceBinding,
  InterfaceRecord,
  LocalVirtualBusDef,
  SidecarStatus,
} from "./types";
import {
  LOCAL_SERVER,
  isLocalBinding,
  localVbusId,
  resolveServer,
} from "./types";
import {
  DEFAULT_NOMINAL_BITRATE_BPS,
  FD_DATA_BITRATE_PRESETS_BPS,
  NOMINAL_BITRATE_PRESETS_BPS,
  formatBitrate,
  parseBitrateInput,
} from "./busHardwareConfig";

/// Tauri event the host fires whenever its per-address interface
/// cache changes (ADR 0016). Must match
/// `interfaces::INTERFACES_CHANGED_EVENT` host-side.
const INTERFACES_CHANGED_EVENT = "interfaces-changed";

/// Sentinel option values for the per-bus interface combo. Real
/// picks encode `${server}\x00${interface}`; these two are control
/// values the onChange handler intercepts.
const COMBO_NONE = "";
/// Leaves the bus alone and opens the Servers panel. A bus row has no
/// server affordance of its own: which servers this machine talks to is
/// a decision it makes once, not a per-bus detail (ADR 0041).
const COMBO_MANAGE_SERVERS = "__manage_servers__";

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
export function useInterfaceDiscovery(addresses: readonly string[]): DiscoveryRegistry {
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

/// A selection from the bus combo. Either a remote `(server, iface)`
/// pair (hardware interface or remote-virtual-bus factory) or a
/// reference to one of the project's virtual buses.
export type ComboPick =
  | { kind: "remote"; server: string; iface: string }
  | { kind: "local-virtual-bus"; virtual_bus_id: string };

/// True when `pick` selects the same source as `binding`.
export function samePick(pick: ComboPick, binding: InterfaceBinding): boolean {
  if (pick.kind === "remote") {
    return pick.server === binding.server && pick.iface === binding.interface;
  }
  return pick.virtual_bus_id === (localVbusId(binding) ?? "");
}

const COMBO_VBUS_PREFIX = "vbus\x00";
const COMBO_ADD_VBUS = "__add_vbus__";

function encodeVbusOption(id: string): string {
  return `${COMBO_VBUS_PREFIX}${id}`;
}

interface BusHardwareConfigProps {
  bus: Bus;
  onSetSpeed: (speed_bps: number | null) => void;
  onSetFd: (fd: boolean | null) => void;
  onSetFdDataSpeed: (fd_data_speed_bps: number | null) => void;
}

/// Per-bus hardware configuration controls. Renders the bitrate and
/// FD-mode pickers on the second line of a logical-bus row; the FD
/// data-rate picker appears below them when FD is enabled. Sidecar /
/// hardware-server interfaces receive these values in the
/// `ConfigureBus` envelope the host sends ahead of `Subscribe`.
/// Local virtual buses don't render this row — the host
/// owns their arbitration timing.
export function BusHardwareConfig({
  bus,
  onSetSpeed,
  onSetFd,
  onSetFdDataSpeed,
}: BusHardwareConfigProps) {
  const fd = bus.fd === true;
  // The bitrate placeholder previews what the host will actually push
  // when this field is left unset — the same default the sidecar would
  // resolve from a wire `speed_bps: 0`. The FD data rate's effective
  // default falls back to the nominal rate (whatever it ends up
  // being), so its placeholder tracks the live nominal value.
  const effectiveNominal = bus.speed_bps ?? DEFAULT_NOMINAL_BITRATE_BPS;
  return (
    <div className="project-bus-hw">
      <label className="project-bus-hw-field">
        <span>Bitrate</span>
        <input
          type="text"
          list={`bitrate-presets-${bus.id}`}
          className="project-bus-hw-input"
          value={bus.speed_bps != null ? formatBitrate(bus.speed_bps) : ""}
          placeholder={formatBitrate(DEFAULT_NOMINAL_BITRATE_BPS)}
          onChange={(e) => onSetSpeed(parseBitrateInput(e.target.value))}
          aria-label={`bus ${bus.id} bitrate`}
        />
        <datalist id={`bitrate-presets-${bus.id}`}>
          {NOMINAL_BITRATE_PRESETS_BPS.map((bps) => (
            <option key={bps} value={formatBitrate(bps)} />
          ))}
        </datalist>
      </label>
      <label className="project-bus-hw-field">
        <input
          type="checkbox"
          checked={fd}
          onChange={(e) => onSetFd(e.target.checked || null)}
          aria-label={`bus ${bus.id} FD mode`}
        />
        <span>FD</span>
      </label>
      {fd && (
        <label className="project-bus-hw-field">
          <span>Data rate</span>
          <input
            type="text"
            list={`fd-data-presets-${bus.id}`}
            className="project-bus-hw-input"
            value={
              bus.fd_data_speed_bps != null
                ? formatBitrate(bus.fd_data_speed_bps)
                : ""
            }
            placeholder={formatBitrate(effectiveNominal)}
            onChange={(e) => onSetFdDataSpeed(parseBitrateInput(e.target.value))}
            aria-label={`bus ${bus.id} FD data rate`}
          />
          <datalist id={`fd-data-presets-${bus.id}`}>
            {FD_DATA_BITRATE_PRESETS_BPS.map((bps) => (
              <option key={bps} value={formatBitrate(bps)} />
            ))}
          </datalist>
        </label>
      )}
    </div>
  );
}

interface BusInterfaceComboProps {
  bus: Bus;
  binding: InterfaceBinding | null;
  sidecarAddress: string | null;
  discoveries: Record<string, DiscoveryState>;
  /// The trusted servers, in the order the host sorted them. Only
  /// these: a server that is merely advertising is not a source until
  /// this machine has accepted it in the Servers panel.
  servers: readonly ServerRow[];
  localVirtualBuses: readonly LocalVirtualBusDef[];
  onPick: (pick: ComboPick | null) => void;
  onManageServers: () => void;
  onAddVirtualBus: () => void;
}

/// Combo box on a logical-bus row that lets the user pick the source
/// for that bus. Sources are symmetrical: a local sidecar interface, an
/// interface on one of this machine's trusted servers (grouped under
/// the server), or one of the project's in-process virtual buses
/// (ADR 0021). "+ Add virtual bus" creates one inline; the only server
/// affordance is "Manage servers…", which opens the Servers panel —
/// trusting a server is a decision the machine makes once, not part of
/// wiring a bus. The combo does not disable an option because another
/// bus already references it: multi-client fan-out makes sharing fine.
export function BusInterfaceCombo({
  bus,
  binding,
  sidecarAddress,
  discoveries,
  servers,
  localVirtualBuses,
  onPick,
  onManageServers,
  onAddVirtualBus,
}: BusInterfaceComboProps) {
  // Selected option's `value`. When the binding's interface isn't
  // currently in any discovery snapshot (server unreachable, sidecar
  // still starting), the selection is still shown so the user can
  // see what the bus is bound to.
  let selectedValue: string;
  if (!binding) {
    selectedValue = COMBO_NONE;
  } else {
    const vbusId = localVbusId(binding);
    selectedValue =
      vbusId !== null
        ? encodeVbusOption(vbusId)
        : encodeOption(binding.server, binding.interface);
  }

  const heads = serverLabels(servers);

  const localList: InterfaceRecord[] =
    sidecarAddress &&
    discoveries[sidecarAddress]?.status === "ok"
      ? (discoveries[sidecarAddress] as { interfaces: InterfaceRecord[] })
          .interfaces
      : [];

  const handlePick = (v: string) => {
    if (v === COMBO_MANAGE_SERVERS) {
      onManageServers();
      return;
    }
    if (v === COMBO_ADD_VBUS) {
      onAddVirtualBus();
      return;
    }
    if (v === COMBO_NONE) {
      onPick(null);
      return;
    }
    if (v.startsWith(COMBO_VBUS_PREFIX)) {
      onPick({
        kind: "local-virtual-bus",
        virtual_bus_id: v.slice(COMBO_VBUS_PREFIX.length),
      });
      return;
    }
    const decoded = decodeOption(v);
    if (decoded) onPick({ kind: "remote", server: decoded.server, iface: decoded.iface });
  };

  const comboOptions: ComboboxOption[] = [
    { value: COMBO_NONE, label: "— no interface —" },
    // Local interfaces (sidecar).
    ...localList.map((r) => interfaceOption(LOCAL_SERVER, r, "Local")),
    // Each trusted server's interfaces, under a group named for the
    // server. The closed-state label keeps the server's name beside the
    // interface's, so a bound bus still says where its source is.
    ...servers.flatMap((row): ComboboxOption[] => {
      // Two servers advertising one name would otherwise share a
      // header, and the interfaces under it would say nothing about
      // which machine they are on.
      const head = heads.get(row.address) ?? serverLabel(row);
      const state = discoveries[row.address];
      if (!row.online) {
        return [
          {
            value: `${row.address}::status`,
            label: "(offline)",
            path: [head],
            disabled: true,
          },
        ];
      }
      if (state?.status === "ok") {
        return state.interfaces.length === 0
          ? [
              {
                value: `${row.address}::empty`,
                label: "(no interfaces)",
                path: [head],
                disabled: true,
              },
            ]
          : state.interfaces.map((r) => ({
              value: encodeOption(row.address, r.id),
              label: r.display_name || r.id,
              selectedLabel: `${head} / ${r.display_name || r.id}`,
              path: [head],
            }));
      }
      return [
        {
          value: `${row.address}::status`,
          label:
            state?.status === "err"
              ? `(unreachable: ${state.error})`
              : "(discovering…)",
          path: [head],
          disabled: true,
        },
      ];
    }),
    // Virtual buses are a peer source, listed under their own group.
    // "+ Add virtual bus" creates a fresh one and binds this bus to it.
    ...(localVirtualBuses.length === 0
      ? [{ value: "vbus::empty", label: "(none)", path: ["Virtual buses"], disabled: true }]
      : localVirtualBuses.map((v) => ({
          value: encodeVbusOption(v.id),
          label: v.name,
          path: ["Virtual buses"],
        }))),
    { value: COMBO_ADD_VBUS, label: "+ Add virtual bus", path: ["Virtual buses"] },
    // Currently-selected interface not in any discovery snapshot —
    // surface a synthetic option so `value=` still resolves.
    ...(binding &&
    (binding.kind ?? "remote") === "remote" &&
    !optionInDiscoveries(binding, sidecarAddress, discoveries)
      ? [
          {
            value: selectedValue,
            label: `${labelFor(binding.server, binding.interface, sidecarAddress)} (offline)`,
          },
        ]
      : []),
    ...(() => {
      if (!binding) return [];
      const vbusId = localVbusId(binding);
      if (vbusId === null) return [];
      if (localVirtualBuses.some((v) => v.id === vbusId)) return [];
      return [{ value: selectedValue, label: `(missing vbus ${vbusId})` }];
    })(),
    { value: COMBO_MANAGE_SERVERS, label: "Manage servers…" },
  ];

  return (
    <Combobox
      className="project-bus-iface-combo"
      options={comboOptions}
      value={selectedValue}
      onChange={handlePick}
      ariaLabel={`bus ${bus.id} interface`}
    />
  );
}

function interfaceOption(server: string, rec: InterfaceRecord, serverLabel: string): ComboboxOption {
  const name = rec.display_name || rec.id;
  return { value: encodeOption(server, rec.id), label: `${serverLabel} / ${name}` };
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

// ---- What a bus's binding says about its server ---------------------------

/// Where a bus's binding stands with the server it names. `ok` covers
/// everything that connects without a question — the local driver, a
/// virtual bus, a trusted server, and an address the host reaches in
/// the clear anyway.
export type BusServerTrust =
  | { kind: "ok" }
  /// The machine has no record of this address at all, and a
  /// connection to it would stop and ask.
  | { kind: "unknown"; address: string }
  /// The server is in the list — advertising, or half-configured — but
  /// nothing accepted here carries a connection through yet.
  | { kind: "untrusted"; address: string }
  /// It presented a certificate that is not the pinned one, and the
  /// connection was refused.
  | { kind: "changed"; address: string }
  /// The pin is still good, but the server refused the stored access
  /// token. The host's trust state cannot carry this — nothing about
  /// the identity moved — so it is read off the question the host is
  /// waiting on.
  | { kind: "tokenRefused"; address: string };

/// What a bus row has to say about its binding's server.
///
/// Both inputs are the host's: `servers` is the merged list, and
/// `needingTrust` is `connect_flow`'s own answer for the addresses this
/// project names. Nothing here re-derives whether an address is
/// reachable without asking — the loopback rules alone make that a
/// question only the host can answer.
///
/// **This is where a project notices a trust question raised with
/// nobody trying to connect.** The host keeps watching servers it
/// already knows, so it can find a changed identity or a refused token
/// on its own; that surfaces here and on the server's row rather than
/// as a modal in the way. A question about *reaching* the server
/// (`noProtection`) is not one of them — that is the connection state's
/// to report, not this notice's.
export function busServerTrust(
  binding: InterfaceBinding | null,
  servers: readonly ServerRow[],
  needingTrust: ReadonlySet<string>,
): BusServerTrust {
  if (!binding || isLocalBinding(binding) || localVbusId(binding) !== null) {
    return { kind: "ok" };
  }
  const address = binding.server;
  const key = serverKey(address);
  const row = servers.find((r) => serverKey(r.address) === key);
  if (row?.trust === "fingerprintChanged") return { kind: "changed", address };
  if (row?.prompt?.kind === "tokenRefused") {
    return { kind: "tokenRefused", address };
  }
  if (!needingTrust.has(address)) return { kind: "ok" };
  return row ? { kind: "untrusted", address } : { kind: "unknown", address };
}

/// The notice's wording. Each says what is wrong and where it is fixed;
/// the Servers panel is the only place any of them is answered.
export function busServerTrustMessage(state: BusServerTrust): string | null {
  switch (state.kind) {
    case "ok":
      return null;
    case "unknown":
      return `unknown server ${state.address} — trust it in the Servers panel`;
    case "untrusted":
      return `${state.address} is not trusted on this machine — trust it in the Servers panel`;
    case "changed":
      return `${state.address} presented a different identity — review it in the Servers panel`;
    case "tokenRefused":
      return `${state.address} refused the access token stored for it — review it in the Servers panel`;
  }
}

/// The line under a bus row whose binding names a server this machine
/// cannot reach without an answer from the user. Without it, such a
/// project looks wired up and fails only at Connect — the project file
/// carries `host:port` references and no credentials (ADR 0032), so
/// opening one on another machine is the ordinary case, not an error.
export function BusServerTrustNotice({
  bus,
  state,
  onManageServers,
}: {
  bus: Bus;
  state: BusServerTrust;
  onManageServers: () => void;
}) {
  const message = busServerTrustMessage(state);
  if (message === null) return null;
  return (
    <div
      className="project-bus-untrusted"
      data-testid={`bus-server-trust-${bus.id}`}
      role="status"
    >
      <span>{message}</span>
      <button type="button" onClick={onManageServers}>
        Manage servers…
      </button>
    </div>
  );
}

// ---- Connection-section rows ---------------------------------------------

/// The connection indicator at the end of a binding row. A project bus
/// has at most one binding (ADR 0023), so the bus's host-side state
/// *is* this interface's state — nothing is aggregated, and a
/// four-channel card reads as four independent rows.
///
/// `busId` is `null` for an enumerated interface nothing routes
/// through; an unbound interface has no connection to report.
export function BindingConnStateBadge({
  busId,
  connStates,
}: {
  busId: string | null;
  connStates: BusConnStates;
}) {
  if (busId === null) return null;
  const d = describeBusConnState(connStates[busId], true);
  return (
    <span
      className={`project-binding-state ${d.tone}`}
      title={d.detail}
      data-testid={`binding-state-${busId}`}
    >
      {d.text}
    </span>
  );
}

interface LocalInterfacesRowProps {
  sidecar: SidecarStatus;
  bindings: readonly InterfaceBinding[];
  buses: readonly Bus[];
  discoveries: Record<string, DiscoveryState>;
  connStates: BusConnStates;
  onRefresh: () => void;
}

/// "Local interfaces" row in the Connection section. Always rendered
/// (even when the local driver is offline) so the user has a fixed
/// handle for the local path. Lists every binding currently pointed
/// at the sidecar's address. The row's state indicator reads
/// ready/starting/offline, and its "Restart" button (which calls the
/// `restart_sidecar` Tauri command) is always available — it is the
/// only place in the app that restarts the sidecar.
export function LocalInterfacesRow({
  sidecar,
  bindings,
  buses,
  discoveries,
  connStates,
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
        connStates={connStates}
        sidecarAddress={sidecarAddress}
      />
    </div>
  );
}

/// Per-interface listing under the Local interfaces row.
export function LocalInterfaceList({
  bindings,
  buses,
  discoveries,
  connStates = {},
  sidecarAddress,
}: {
  bindings: readonly InterfaceBinding[];
  buses: readonly Bus[];
  discoveries: Record<string, DiscoveryState>;
  connStates?: BusConnStates;
  sidecarAddress: string | null;
}) {
  return (
    <InterfaceList
      address={sidecarAddress}
      bindings={bindings}
      buses={buses}
      discoveries={discoveries}
      connStates={connStates}
      emptyText={
        sidecarAddress === null ? "(local driver offline)" : "(no local interfaces)"
      }
    />
  );
}

/// Every interface one server advertises, each annotated either
/// `→ <bus>` for a bound one or `(unassigned)` when nothing on the
/// project routes through it yet — so the listing reads as "what
/// hardware is there," not "what hardware did the user already wire
/// up." Bindings whose interface id is absent from the live
/// enumeration follow as a tail, with the raw id, so a project can
/// still show what it references.
function InterfaceList({
  address,
  bindings,
  buses,
  discoveries,
  connStates = {},
  emptyText,
}: {
  /// The address the enumeration is keyed by — the live sidecar
  /// address for the local row, the server's `host:port` for a server
  /// section. `null` when there is nothing to key by yet.
  address: string | null;
  bindings: readonly InterfaceBinding[];
  buses: readonly Bus[];
  discoveries: Record<string, DiscoveryState>;
  connStates?: BusConnStates;
  /// What to say when the server answered but has nothing to offer.
  emptyText: string;
}) {
  const state = address ? discoveries[address] : undefined;
  const discovered: readonly InterfaceRecord[] =
    state && state.status === "ok" ? state.interfaces : [];

  // Bindings whose interface id no longer appears in the live
  // enumeration (e.g. the sidecar restarted with different hardware,
  // or a saved binding references an interface that's now offline).
  // Render them as a tail with the raw id so the user can see what
  // their project still references.
  const discoveredIds = new Set(discovered.map((r) => r.id));
  const orphanBindings = bindings.filter((b) => !discoveredIds.has(b.interface));

  if (discovered.length === 0 && orphanBindings.length === 0) {
    return (
      <div className="project-server-empty">
        {state?.status === "err" ? `(unreachable: ${state.error})` : emptyText}
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
            <BindingConnStateBadge
              busId={binding ? binding.bus_id : null}
              connStates={connStates}
            />
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
            <BindingConnStateBadge busId={b.bus_id} connStates={connStates} />
          </li>
        );
      })}
    </ul>
  );
}

/// One trusted server in the Connection section: a collapsible sibling
/// of the Local interfaces row, headed by the name it advertises, the
/// machine it runs on, its `host:port`, and what the last attempt to
/// reach it saw.
///
/// A server appears here because *this machine* trusts it (ADR 0041),
/// not because the project references it — the project only says which
/// interface a bus is bound to. Which sections stand open is the
/// chosen-interface rule's answer ({@link useServerSections}); a server
/// that is switched off keeps its header, greyed, so what a project
/// points at is never invisible.
export function ServerSection({
  server,
  connected,
  bindings,
  buses,
  discoveries,
  connStates,
  expanded,
  onToggle,
  onRefresh,
}: {
  server: ServerRow;
  /// Whether a session is live against this server right now — the
  /// host's answer, not a guess from the enumeration.
  connected: boolean;
  /// Every binding in the project; the section picks its own.
  bindings: readonly InterfaceBinding[];
  buses: readonly Bus[];
  discoveries: Record<string, DiscoveryState>;
  connStates: BusConnStates;
  expanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}) {
  const state = discoveries[server.address];
  const stateText = !server.online
    ? "offline"
    : state?.status === "err"
      ? `unreachable: ${state.error}`
      : connected
        ? "connected"
        : state?.status === "ok"
          ? "ready"
          : "discovering…";
  return (
    <div
      className={`project-server${server.online ? "" : " offline"}`}
      data-testid={`server-section-${server.address}`}
    >
      <div className="project-bus">
        <DisclosureToggle
          className="project-section-toggle"
          expanded={expanded}
          ariaLabel={`interfaces on ${server.address}`}
          onToggle={onToggle}
        >
          <span className="project-bus-name">{serverLabel(server)}</span>
        </DisclosureToggle>
        {server.host !== null && (
          <span className="project-server-host">{server.host}</span>
        )}
        <span className="project-server-address">{server.address}</span>
        <span
          className={`project-bus-state ${
            connected ? "connected" : server.online ? "" : "errored"
          }`}
        >
          {stateText}
        </span>
        {server.clock !== null && (
          <span
            className={`project-server-clock${server.clock.warn ? " warn" : ""}${
              server.clock.stale ? " stale" : ""
            }`}
            title={`measured clock offset vs ${server.address}${
              server.clock.stale ? " (stale — no recent reply)" : ""
            }`}
            data-testid={`server-clock-${server.address}`}
          >
            {formatClockOffset(server.clock.offsetNs)}
          </span>
        )}
        {server.online && (
          <button
            type="button"
            aria-label={`discover interfaces on ${server.address}`}
            onClick={onRefresh}
          >
            Discover
          </button>
        )}
      </div>
      {expanded &&
        (server.online ? (
          <InterfaceList
            address={server.address}
            bindings={bindingsForServer(bindings, server.address)}
            buses={buses}
            discoveries={discoveries}
            connStates={connStates}
            emptyText="(no interfaces)"
          />
        ) : (
          <div className="project-server-empty">
            (not advertising — switched off, or on a network this machine
            cannot hear)
          </div>
        ))}
    </div>
  );
}

/// The bindings pointed at `address`, matched the way the host keys its
/// trust store — so a project that spelled the address with a scheme or
/// in another case still lands on that server's section.
export function bindingsForServer(
  bindings: readonly InterfaceBinding[],
  address: string,
): InterfaceBinding[] {
  const key = serverKey(address);
  return bindings.filter(
    (b) =>
      !isLocalBinding(b) &&
      localVbusId(b) === null &&
      serverKey(b.server) === key,
  );
}

/// Which server sections stand open. The rule: a section follows
/// whether any of its interfaces is chosen by a bus, so a project shows
/// the servers it is using without hiding the ones it is not. A manual
/// expand or collapse is view-local state that overrides the rule — and
/// holds only until the rule's own answer for that server moves, at
/// which point the section goes back to following it.
///
/// `chosen` maps a server's address to whether a bus is bound to
/// something on it.
export function useServerSections(chosen: Readonly<Record<string, boolean>>): {
  expanded: (address: string) => boolean;
  toggle: (address: string) => void;
} {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const previous = useRef(chosen);
  // Stable shape of the rule's answer, so the reconcile effect runs
  // when it moves rather than on every render.
  const ruleKey = useMemo(
    () =>
      Object.keys(chosen)
        .sort()
        .map((address) => `${address}:${chosen[address] ? 1 : 0}`)
        .join("|"),
    [chosen],
  );

  useEffect(() => {
    setOverrides((prev) => keptOverrides(prev, previous.current, chosen));
    previous.current = chosen;
    // `ruleKey` is the stable shape of `chosen`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleKey]);

  const expanded = useCallback(
    (address: string) => overrides[address] ?? chosen[address] ?? false,
    [overrides, chosen],
  );
  const toggle = useCallback(
    (address: string) =>
      setOverrides((prev) => ({
        ...prev,
        [address]: !(prev[address] ?? chosen[address] ?? false),
      })),
    [chosen],
  );
  return { expanded, toggle };
}

/// The manual expand/collapse decisions that survive a move in the
/// rule's answer: an override is kept while its own server's answer is
/// unchanged, and dropped when that answer moves or the server leaves
/// the list. Returns `overrides` itself when nothing is dropped, so a
/// reconcile that changes nothing does not re-render.
export function keptOverrides(
  overrides: Readonly<Record<string, boolean>>,
  previous: Readonly<Record<string, boolean>>,
  current: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  let dropped = false;
  const next: Record<string, boolean> = {};
  for (const [address, value] of Object.entries(overrides)) {
    if (
      address in current &&
      (previous[address] ?? false) === (current[address] ?? false)
    ) {
      next[address] = value;
    } else {
      dropped = true;
    }
  }
  return dropped ? next : (overrides as Record<string, boolean>);
}

interface VirtualBusRowProps {
  def: LocalVirtualBusDef;
  bindings: readonly InterfaceBinding[];
  buses: readonly Bus[];
  onRename: (name: string) => void;
  onSetBridges: (bridges: BridgeSpec[]) => void;
  onRemove: () => void;
}

/// One row in the *Virtual buses* section. Lets the user edit the
/// vbus's name + bridges, and shows which project buses are currently
/// bound to it. The host commands for create / drop / attach / detach
/// bridges are wired through App's virtual-bus handlers (so the JSON
/// and the host stay in sync). The vbus has no user-configurable
/// bitrate — it's in-process, not a model of a real wire.
export function VirtualBusRow({
  def,
  bindings,
  buses,
  onRename,
  onSetBridges,
  onRemove,
}: VirtualBusRowProps) {
  const [addingBridge, setAddingBridge] = useState(false);
  const bridges = def.bridges ?? [];
  const consumers = bindings.filter((b) => localVbusId(b) === def.id);
  return (
    <div className="project-bus-row">
      <div className="project-bus">
        <input
          type="text"
          className="project-bus-name-input"
          value={def.name}
          onChange={(e) => onRename(e.target.value)}
          aria-label={`virtual bus ${def.id} name`}
        />
        <span className="project-bus-kind-badge" title="In-process virtual bus (ADR 0021)">
          virtual
        </span>
        <button type="button" onClick={onRemove}>
          Remove
        </button>
      </div>
      <div className="project-binding-form-row">
        <span className="project-binding-form-label">used by</span>
        <span>
          {consumers.length === 0
            ? "(no buses bound)"
            : consumers
                .map(
                  (b) =>
                    buses.find((x) => x.id === b.bus_id)?.name ?? b.bus_id,
                )
                .join(", ")}
        </span>
      </div>
      {bridges.length > 0 && (
        <div className="project-binding-form-row">
          <span className="project-binding-form-label">bridges</span>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {bridges.map((b) => (
              <li key={b.name}>
                {b.name || b.interface} → {b.remote_address}:{b.interface}{" "}
                <button
                  type="button"
                  onClick={() => {
                    onSetBridges(bridges.filter((x) => x.name !== b.name));
                    void invoke("detach_local_bus_bridge", {
                      virtualBusId: def.id,
                      name: b.name,
                    }).catch((err) => {
                      console.error("detach_local_bus_bridge failed", err);
                    });
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {addingBridge ? (
        <AddBridgeForm
          onCancel={() => setAddingBridge(false)}
          onAdd={(spec, allocates) => {
            onSetBridges([...bridges, spec]);
            setAddingBridge(false);
            void invoke("attach_local_bus_bridge", {
              virtualBusId: def.id,
              spec,
              allocates,
            }).catch((err) => {
              console.error("attach_local_bus_bridge failed", err);
            });
          }}
        />
      ) : (
        <div className="project-buttons">
          <button type="button" onClick={() => setAddingBridge(true)}>
            Add bridge
          </button>
        </div>
      )}
    </div>
  );
}

interface AddBridgeFormProps {
  onCancel: () => void;
  onAdd: (spec: {
    remote_address: string;
    interface: string;
    name: string;
  }, allocates: boolean) => void;
}

/// Minimal inline form for capturing a bridge spec — remote address,
/// remote interface id, friendly name, and an "is a virtual-bus
/// factory" checkbox. Deliberately bare: full discovery /
/// auto-completion against the bridged server is a follow-up.
function AddBridgeForm({ onCancel, onAdd }: AddBridgeFormProps) {
  const [server, setServer] = useState(() => hostSettings().default_server_address);
  const [iface, setIface] = useState("");
  const [name, setName] = useState("");
  const [allocates, setAllocates] = useState(false);
  return (
    <div className="project-binding-form">
      <div className="project-binding-form-row">
        <label>
          Remote{" "}
          <input
            type="text"
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="host:port or local"
          />
        </label>
      </div>
      <div className="project-binding-form-row">
        <label>
          Interface{" "}
          <input
            type="text"
            value={iface}
            onChange={(e) => setIface(e.target.value)}
            placeholder="virtual:bus0 or vector:VN1640A(...)"
          />
        </label>
      </div>
      <div className="project-binding-form-row">
        <label>
          Name{" "}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="bridge-1"
          />
        </label>
      </div>
      <div className="project-binding-form-row">
        <label>
          <input
            type="checkbox"
            checked={allocates}
            onChange={(e) => setAllocates(e.target.checked)}
          />{" "}
          Factory subscribe (virtual-bus target)
        </label>
      </div>
      <div className="project-buttons">
        <button
          type="button"
          disabled={!iface || !name}
          onClick={() => onAdd({ remote_address: server, interface: iface, name }, allocates)}
        >
          Add
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
