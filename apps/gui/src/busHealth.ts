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
const CONTROLLER_STATE_TEXT: Record<string, string> = {
  active: "Error-active",
  passive: "Error-passive",
  busOff: "Bus-off",
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
  /// `Error-active` / `Error-passive` / `Bus-off` / `Not connected`.
  stateText: string;
  /// The style key the row's indicator paints with.
  tone: "active" | "passive" | "busoff" | "off";
  /// Percentage of the wire in use, or `null` where it cannot be known.
  loadPercent: number | null;
  /// Why the load is unknowable, for the cell's tooltip. `null` when
  /// there is a figure.
  loadAbsentReason: string | null;
  tec: number | null;
  rec: number | null;
  /// Errors this session, or `null` for a bus the host has nothing to
  /// say about at all.
  errorCount: number | null;
  errorRate: number;
  /// The interface's display name, or `null` for an unbound bus.
  adapter: string | null;
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
  /// back to the wire id, which is what the project panel shows too.
  interfaces: readonly InterfaceRecord[];
  connStates: BusConnStates;
  health: BusHealthMap;
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
          binding.interface);
    return {
      busId: bus.id,
      name: bus.name,
      stateText: controller
        ? (CONTROLLER_STATE_TEXT[controller.state] ?? controller.state)
        : connected
          ? "Connected"
          : "Not connected",
      tone: controller
        ? controller.state === "busOff"
          ? "busoff"
          : controller.state === "passive"
            ? "passive"
            : "active"
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
      errorCount: record?.errorCount ?? null,
      errorRate: record?.errorRate ?? 0,
      adapter: adapterName,
      applied: connected ? describeAppliedConfig(applied) : null,
    };
  });
}

/// The buses the status-bar launcher reports on: every one whose
/// controller is not error-active. A bus that has not reported a state
/// is *not* a concern — silence is not a fault, and the launcher would
/// otherwise light up for every virtual bus and every driver that does
/// not answer.
export function busHealthConcerns(rows: readonly BusHealthRow[]): BusHealthConcern[] {
  return rows
    .filter((r) => r.tone === "passive" || r.tone === "busoff")
    .map((r) => ({
      bus: r.name,
      state: r.stateText.toLowerCase(),
      busOff: r.tone === "busoff",
    }));
}
