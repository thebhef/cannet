/// Pushing each view's referenced signals to the host's view-signal
/// panel model (`apps/gui/src-tauri/src/view_signals.rs`).
///
/// The host deliberately does not interpret the project's opaque
/// `elements` blob (`project.rs`: "the host doesn't read these; the
/// frontend owns the shape"), so it cannot discover which signals a
/// view references on its own. The frontend pushes them instead —
/// {@link usePushViewSignals} is the one place that does it, called by
/// every view that references signals on mount and whenever its own
/// signal configuration changes; its cleanup un-pushes on unmount. The
/// pure `*ViewSignalRefs` builders below turn each view's own persisted
/// shape into the wire shape, so the mapping is unit-testable without
/// mounting a panel.
///
/// **Which views push, and what.** Not every view that touches a
/// signal has a *recorded reference* to push. A manual pick — a plot
/// area's `signals`, the signals view's `selection.keys`, a colormap
/// element's target, a transmit frame's calculated-field signal — is a
/// stored identity (plus, where the view records it, the fields a
/// drift is measured against) that can go stale when the databases
/// change. A **pattern** (a plot area's `patterns`, the signals view's
/// selection patterns, a signal-generator rule) is re-evaluated against
/// the *live* catalog on every render — it has no recorded
/// configuration for the database to have drifted from, and it cannot
/// go stale the way a manual pick can, so it is never pushed. The same
/// reasoning excludes a transmit frame's byte-level signal edits: they
/// are resolved against whichever DBC is assigned at edit time and
/// immediately flattened to bytes, with no persisted per-signal pick
/// left behind.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { ViewSignalRef } from "./types";
import type { PlotAreaConfig } from "./plotPanelConfig";
import type { DraggableSignalRef } from "./dragSignals";
import type { TransmitFrameConfig } from "./transmitFrameConfig";

/// Push `refs` under `viewId` on mount and whenever they change by
/// value (not by array identity — a view's config recomputes a fresh
/// array most renders); un-push on unmount. The host's own registry
/// already drops a no-op re-push (`ViewSignalRegistry::set` — it
/// compares the incoming value and only emits `view-signals-changed`
/// when something actually differs), but that still costs a round
/// trip, so this hook also skips the call entirely when nothing has
/// changed since the last one it sent.
export function usePushViewSignals(
  viewId: string,
  viewName: string,
  refs: readonly ViewSignalRef[],
): void {
  const lastSent = useRef<string | null>(null);
  useEffect(() => {
    const body = JSON.stringify([viewName, refs]);
    if (body === lastSent.current) return;
    lastSent.current = body;
    void invoke("set_view_signals", { viewId, viewName, signals: refs }).catch(() => {});
  }, [viewId, viewName, refs]);

  // Un-push once, on unmount — or if `viewId` itself changes, which in
  // practice only happens across a fresh mount (a panel's element id is
  // stable state for its lifetime).
  useEffect(
    () => () => {
      void invoke("remove_view_signals", { viewId }).catch(() => {});
    },
    [viewId],
  );
}

/// The plot panel's references: every area's manual `signals`,
/// flattened, carrying the `messageName` / `unit` the area recorded
/// them under (what Scale/Stale drift is measured against). Pattern-
/// matched rows are excluded — see the module doc.
export function plotViewSignalRefs(areas: readonly PlotAreaConfig[]): ViewSignalRef[] {
  const out: ViewSignalRef[] = [];
  for (const area of areas) {
    for (const s of area.signals) {
      out.push({
        busId: s.busId,
        messageId: s.messageId,
        extended: s.extended,
        signalName: s.signalName,
        fileBacked: s.fileBacked,
        messageName: s.messageName,
        unit: s.unit,
      });
    }
  }
  return out;
}

/// The signals ("Trace") view's references: its manual selection keys,
/// which — like the plot's manual picks — carry a recorded
/// `messageName` / `unit`. Its selection *patterns* are the same live,
/// unrecordable case as the plot's and are excluded for the same
/// reason (see the module doc).
export function signalsViewSignalRefs(
  keys: readonly DraggableSignalRef[],
): ViewSignalRef[] {
  return keys.map((k) => ({
    busId: k.busId,
    messageId: k.messageId,
    extended: k.extended,
    signalName: k.signalName,
    fileBacked: k.fileBacked,
    messageName: k.messageName,
    unit: k.unit,
  }));
}

/// The color-map element's one target signal, or nothing before a
/// target is picked. Identity only: a colormap element records no
/// message name or unit for its target to have drifted from.
export function colorMapViewSignalRefs(target: {
  busId?: string | null;
  messageId: number;
  extended: boolean;
  signalName: string;
}): ViewSignalRef[] {
  if (target.signalName === "") return [];
  return [
    {
      busId: target.busId ?? null,
      messageId: target.messageId,
      extended: target.extended,
      signalName: target.signalName,
    },
  ];
}

/// The transmit panel's references: the calculated-field signals its
/// frames name (ADR 0027) — a counter's or a CRC's target signal.
/// Identity only, and the only persisted per-signal picks a transmit
/// frame carries (see the module doc for why the byte-level signal
/// edits themselves are not one).
export function transmitViewSignalRefs(
  frames: readonly TransmitFrameConfig[],
): ViewSignalRef[] {
  const out: ViewSignalRef[] = [];
  for (const f of frames) {
    const counterSignal = f.calc?.counter?.signal;
    if (counterSignal) {
      out.push({
        busId: f.busId,
        messageId: f.canId,
        extended: f.extended,
        signalName: counterSignal,
      });
    }
    const crcSignal = f.calc?.crc?.signal;
    if (crcSignal) {
      out.push({
        busId: f.busId,
        messageId: f.canId,
        extended: f.extended,
        signalName: crcSignal,
      });
    }
  }
  return out;
}
