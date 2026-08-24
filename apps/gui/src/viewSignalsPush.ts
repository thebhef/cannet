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
/// **Which views push, and what.** A view pushes every signal it is
/// actually using, whether it named that signal or matched it. The two
/// differ only in what they can say about it:
///
/// - A **manual pick** — a plot area's `signals`, the signals view's
///   `selection.keys`, a colormap element's target, a transmit frame's
///   calculated-field signal — is a stored identity, and where the view
///   also recorded the message name and unit, those are what a drift is
///   measured against. Such a row can read any status, Scale and Stale
///   included.
/// - A **pattern match** — a plot area's `patterns`, the signals view's
///   selection and section patterns — is re-evaluated against the live
///   catalog, so the message name and unit it resolves to are whatever
///   the catalog says right now, not something the view recorded
///   earlier; pushing them would compare the catalog against itself. So
///   a matched signal pushes **identity only**, which the wire already
///   allows (`ViewSignalRef`'s optional fields), and its row can read
///   Decoded, Not Decoded or Ambiguous but never Scale or Stale —
///   there is no recorded comparand for it to have drifted from.
///
/// The builders below therefore take each view's resolved matches
/// alongside its persisted picks, and a signal that is both keeps the
/// pick, which says more.
///
/// Two cases still push nothing. A transmit frame's byte-level signal
/// edits are resolved against whichever DBC is assigned at edit time
/// and immediately flattened to bytes, leaving no per-signal pick
/// behind. A **signal-generator rule** (ADR 0026) matches signal
/// *names* across the whole catalog to assign a color-wheel slot: it
/// puts nothing on screen, and wherever a matched signal is displayed
/// the view displaying it already pushes it.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { ViewSignalRef } from "./types";
import { signalKey } from "./plotData";
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

/// The identity of a signal a view's patterns currently match — every
/// field such a row pushes, and the least the wire accepts. See the
/// module doc for why it pushes no more than this.
export interface MatchedSignalRef {
  busId: string | null;
  messageId: number;
  extended: boolean;
  signalName: string;
  fileBacked?: boolean;
}

const identityKey = (s: MatchedSignalRef): string =>
  signalKey(s.busId, s.messageId, s.extended, s.signalName, s.fileBacked ?? false);

const identityRef = (s: MatchedSignalRef): ViewSignalRef => ({
  busId: s.busId ?? null,
  messageId: s.messageId,
  extended: s.extended,
  signalName: s.signalName,
  ...(s.fileBacked ? { fileBacked: true as const } : {}),
});

/// The plot panel's references. `areas` is the persisted state, whose
/// manual picks carry the `messageName` / `unit` the area recorded them
/// under — what Scale/Stale drift is measured against.
/// `effectiveAreas` is that same list with every area's `patterns`
/// resolved against the live catalog (`signalSelection.ts`'s
/// `applyAreaSelection`): everything in it that is not a manual pick is
/// a pattern-derived row, and pushes identity-only, deduped across
/// areas.
///
/// A `viaPattern` entry is not a pick — it exists only to carry a
/// pattern row's color / hidden override — so it takes the
/// identity-only path like any other match.
export function plotViewSignalRefs(
  areas: readonly PlotAreaConfig[],
  effectiveAreas: readonly PlotAreaConfig[],
): ViewSignalRef[] {
  const out: ViewSignalRef[] = [];
  const seen = new Set<string>();
  for (const area of areas) {
    for (const s of area.signals) {
      if (s.viaPattern) continue;
      seen.add(identityKey(s));
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
  for (const area of effectiveAreas) {
    for (const s of area.signals) {
      const key = identityKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(identityRef(s));
    }
  }
  return out;
}

/// The signals ("Trace") view's references: its manual selection keys,
/// which — like the plot's manual picks — carry a recorded
/// `messageName` / `unit`, plus `matches`, what its selection patterns
/// and its sections' own patterns resolve to against the live catalog.
/// A match that is already a manual key is left to the key, which says
/// more.
export function signalsViewSignalRefs(
  keys: readonly DraggableSignalRef[],
  matches: readonly MatchedSignalRef[],
): ViewSignalRef[] {
  const out: ViewSignalRef[] = keys.map((k) => ({
    busId: k.busId,
    messageId: k.messageId,
    extended: k.extended,
    signalName: k.signalName,
    fileBacked: k.fileBacked,
    messageName: k.messageName,
    unit: k.unit,
  }));
  const seen = new Set(keys.map(identityKey));
  for (const m of matches) {
    const key = identityKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(identityRef(m));
  }
  return out;
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
