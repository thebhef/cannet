// The bus-health view over the host's model.
//
// Three host models answer different halves of one question and are
// joined here, once, so the panel and the status bar's launcher cannot
// disagree: `bus-health-changed` carries the controller state, the
// counters, the load and the error tallies; `connection-states-changed`
// carries what the host actually put on the wire for each bus; the
// project carries the bus names and the interface bindings, which the
// frontend owns.
//
// Nothing here computes a model fact. The load percentage, the error
// rate and the fault-confinement state all arrive already decided; what
// this adds is the join and the words.

import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

import { describeAppliedConfig } from "./connectionStates";
import { useHostMirror } from "./useHostMirror";
import type { BusHealthConcern } from "./BusHealthLauncher";
import type {
  Bus,
  BusConnStates,
  BusHealthMap,
  BusHealthRecord,
  InterfaceBinding,
  InterfaceRecord,
} from "./types";

/// Tauri event the host fires when any bus's health moves. Must match
/// `bus_health::BUS_HEALTH_CHANGED_EVENT` host-side.
export const BUS_HEALTH_CHANGED_EVENT = "bus-health-changed";

/// A host with nothing to say about any bus. A stable value, so a
/// host that never answers does not hand the panel a fresh empty map
/// on every render.
const NO_BUS_HEALTH: BusHealthMap = {};

/// Subscribe to the host's per-bus health map: the shared host-mirror
/// pattern (ADR 0016) — one snapshot on mount, another once the
/// listener is attached, and a re-read on every change event. The
/// second fetch is the point: `listen` is async, and a bus that went
/// error-passive in the gap before it attached would otherwise stay
/// invisible until the next sample. Nothing accumulates — the map is
/// bounded by the project's bus count.
export function useBusHealth(): BusHealthMap {
  const fetchHealth = useCallback(
    // A host without the command answers with nothing at all, which is
    // "no bus has reported" rather than a map to read fields off.
    async () => (await invoke<BusHealthMap>("get_bus_health")) ?? NO_BUS_HEALTH,
    [],
  );
  return useHostMirror<BusHealthMap>({
    fetch: fetchHealth,
    fallback: NO_BUS_HEALTH,
    event: BUS_HEALTH_CHANGED_EVENT,
  }).value;
}

/// How a controller state reads. The host sends the ISO 11898-1 name;
/// this is the only place it is spelled for a reader.
///
/// `unavailable` is not one of that standard's states: it is the peer's
/// driver saying it can no longer reach the interface at all. It gets
/// its own words rather than borrowing bus-off's, because bus-off is a
/// controller that took itself off the wire and comes back on its own,
/// and this one comes back when someone plugs the cable in.
const CONTROLLER_STATE_TEXT: Record<string, string> = {
  active: "Connected",
  warning: "Error-warning",
  passive: "Error-passive",
  busOff: "Bus-off",
  unavailable: "Adapter unavailable",
};

/// The hover text for a state whose displayed name is not the
/// standard's. Only the healthy one qualifies: `Error-active` is ISO
/// 11898-1's name for a controller in normal operation, and it is the
/// one state whose own name reads as the opposite of what it means —
/// the other three read as degrees of trouble, which is what they are.
/// The standard's name is what a CAN engineer looks for, so it survives
/// here rather than being dropped.
const CONTROLLER_STATE_TITLE: Record<string, string> = {
  active: "Error-active — ISO 11898-1's name for a controller in normal operation",
};

/// The indicator style each controller state paints with. Absent from
/// the map means error-active, which is the unremarkable case.
const CONTROLLER_STATE_TONE: Record<string, BusHealthRow["tone"]> = {
  warning: "warning",
  passive: "passive",
  busOff: "busoff",
  unavailable: "unavailable",
};

/// One row of the health panel: every cell either a value or `null`,
/// which the panel renders as an em dash.
///
/// `null` is load-bearing throughout. A virtual bus has no configurable
/// bitrate and therefore no defined load; a bus with no binding has no
/// counters; a bus whose driver has not reported has no state. None of
/// those is a zero, and a panel that rendered them alike would raise an
/// alarm for a bus that is merely quiet — or hide one that is off.
export interface BusHealthRow {
  busId: string;
  /// The project's name for the bus.
  name: string;
  /// `Connected` / `Error-warning` / `Error-passive` / `Bus-off` /
  /// `Adapter unavailable` / `Not connected`.
  stateText: string;
  /// Hover text for the state cell, or `null` where the displayed name
  /// is already the standard's and a tooltip would only repeat it.
  stateTitle: string | null;
  /// The style key the row's indicator paints with.
  tone: "active" | "warning" | "passive" | "busoff" | "unavailable" | "off";
  /// Percentage of the wire in use, or `null` where it cannot be known.
  loadPercent: number | null;
  /// Why the load is unknowable, for the cell's tooltip. `null` when
  /// there is a figure.
  loadAbsentReason: string | null;
  tec: number | null;
  rec: number | null;
  /// Receive overruns the driver has reported, or `null` where it
  /// reports no such thing. `null` and `0` are different answers and
  /// the panel must render them differently: `0` says this capture is
  /// the whole of what the bus sent, `null` says nobody checked.
  rxOverruns: number | null;
  /// Errors this session, or `null` for a bus the host has nothing to
  /// say about at all.
  errorCount: number | null;
  errorRate: number;
  /// The interface's display name, or `null` for an unbound bus.
  adapter: string | null;
  /// What the peer's driver said about the adapter, or `null` when it
  /// said nothing at all — in which case the cell reads exactly as it
  /// did before the fields existed.
  adapterIdentity: AdapterIdentity | null;
  /// The applied bus configuration in the project panel's own words —
  /// `describeAppliedConfig`, so a bitrate never acquires a second
  /// spelling. `null` when the bus is not connected.
  applied: string | null;
}

export interface BusHealthInputs {
  buses: readonly Bus[];
  bindings: readonly InterfaceBinding[];
  /// Every interface the app knows about, by wire id, for the display
  /// name. A binding to an interface the app has not enumerated falls
  /// back to the wire id — except a virtual-bus binding, which has no
  /// hardware to name at all (see {@link VIRTUAL_BUS_ADAPTER}).
  interfaces: readonly InterfaceRecord[];
  connStates: BusConnStates;
  health: BusHealthMap;
}

/// What the Adapter column says for a bus bound to an in-process
/// virtual bus. Every such binding carries the same canonical
/// interface name, which is a wire id and not a thing to show anyone;
/// and the column asks what hardware is behind the bus, whose honest
/// answer here is that there is none. The bus's own name is not
/// repeated — column 1 already carries it.
const VIRTUAL_BUS_ADAPTER = "virtual bus";

/// The adapter identity a cell renders, once **any** of it is known.
///
/// Each slot is `null` where the driver did not report it, and the cell
/// shows an em dash there. `driver` folds the driver's name and version
/// into the one phrase a reader wants — "PCAN-Basic 4.9.0.942" — since
/// a version with no stack to attach it to says nothing on its own.
export interface AdapterIdentity {
  driver: string | null;
  firmware: string | null;
  serial: string | null;
}

/// Read the identity off an interface record, or `null` when the peer's
/// driver reported none of it.
///
/// The `null` is what keeps the control honest: a backend that exposes
/// nothing — an in-process virtual bus, a Kvaser channel today — has to
/// render exactly as it did before these fields existed, not as a row
/// of em dashes announcing four things nobody asked about. Once one
/// field is known the rest are worth naming, because then the absences
/// are answers rather than noise.
export function adapterIdentity(
  iface: InterfaceRecord | undefined,
): AdapterIdentity | null {
  if (iface === undefined) return null;
  const { driver_name, driver_version, firmware_version, serial_number } = iface;
  if (!driver_name && !driver_version && !firmware_version && !serial_number) {
    return null;
  }
  return {
    driver: [driver_name, driver_version].filter(Boolean).join(" ") || null,
    firmware: firmware_version ?? null,
    serial: serial_number ?? null,
  };
}

/// Build one row per project bus, in project order.
export function busHealthRows(inp: BusHealthInputs): BusHealthRow[] {
  return inp.buses.map((bus) => {
    const binding = inp.bindings.find((b) => b.bus_id === bus.id);
    const conn = inp.connStates[bus.id];
    const record: BusHealthRecord | undefined = inp.health[bus.id];
    const connected = conn?.kind === "connected";
    const applied = connected ? (conn.applied ?? null) : null;
    const controller = record?.controller ?? null;
    const adapterName =
      binding === undefined
        ? null
        : (inp.interfaces.find((i) => i.id === binding.interface)?.display_name ??
          (binding.kind === "local-virtual-bus"
            ? VIRTUAL_BUS_ADAPTER
            : binding.interface));
    return {
      busId: bus.id,
      name: bus.name,
      stateText: controller
        ? (CONTROLLER_STATE_TEXT[controller.state] ?? controller.state)
        : connected
          ? "Connected"
          : "Not connected",
      stateTitle: controller ? (CONTROLLER_STATE_TITLE[controller.state] ?? null) : null,
      tone: controller
        ? (CONTROLLER_STATE_TONE[controller.state] ?? "active")
        : connected
          ? "active"
          : "off",
      loadPercent: record?.loadPercent ?? null,
      loadAbsentReason:
        record?.loadPercent != null
          ? null
          : !connected
            ? "not connected — nothing is on a wire"
            : applied === null
              ? "an in-process virtual bus has no configurable bitrate, so load is not defined"
              : "no bitrate was sent for this bus, so there is nothing to divide by",
      tec: controller?.tec ?? null,
      rec: controller?.rec ?? null,
      rxOverruns: controller?.rxOverruns ?? null,
      errorCount: record?.errorCount ?? null,
      errorRate: record?.errorRate ?? 0,
      adapter: adapterName,
      adapterIdentity:
        binding === undefined
          ? null
          : adapterIdentity(inp.interfaces.find((i) => i.id === binding.interface)),
      applied: connected ? describeAppliedConfig(applied) : null,
    };
  });
}

/// Whether any bus has reported an error frame this capture.
///
/// The trace view's error-frame collapse asks this before it engages:
/// a capture with no error frames has nothing to collapse, and routing
/// its trace through the host's filtered paging to exclude a category
/// of row that never occurs would buy nothing. A fault switches it on
/// the moment the first error frame lands, which is when the rows it
/// hides start arriving.
export function anyBusHasErrors(health: BusHealthMap): boolean {
  return Object.values(health).some((r) => (r?.errorCount ?? 0) > 0);
}

/// The buses the status-bar launcher reports on: every one whose
/// controller is not error-active, including one that is merely over
/// the ISO warning limit and one whose adapter the driver can no longer
/// reach. A bus that has not reported a state is *not* a concern —
/// silence is not a fault, and the launcher would otherwise light up
/// for every virtual bus and every driver that does not answer.
///
/// The warning limit earns a place here rather than being treated as
/// close enough to healthy: it is the reading a fault produces on its
/// way to error-passive, and a launcher that stayed dark until 128
/// would go on saying nothing through the part of a fault an operator
/// could still act on.
export function busHealthConcerns(rows: readonly BusHealthRow[]): BusHealthConcern[] {
  return rows
    .filter(
      (r) =>
        r.tone === "warning" ||
        r.tone === "passive" ||
        r.tone === "busoff" ||
        r.tone === "unavailable",
    )
    .map((r) => ({
      bus: r.name,
      state: r.stateText.toLowerCase(),
      // An unreachable adapter is the launcher's fault tint, not its
      // warning tint: nothing on that bus is being carried, and unlike
      // error-passive it does not clear itself.
      busOff: r.tone === "busoff" || r.tone === "unavailable",
    }));
}
