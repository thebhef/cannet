/// Display labelling for a plot-area signal row's message line.
///
/// The row names its signal on one line and the message it came from on
/// the next. That second line is the DBC ancestry — `bus · ecu ·
/// message`, the same hierarchy the DBC panel's tree and the signal
/// picker's group headers use — so a row and the tree it was dragged
/// from read identically.
///
/// The ECU is not carried on a plotted signal ref (it isn't part of the
/// signal's identity — `(bus, message id, name)` is), so it's resolved
/// from the signal catalog through [`messageEcuLookup`].

import type { SignalDescriptorRecord } from "./types";

/// Key a catalog message for the ECU lookup. Same `(bus, extended, id)`
/// shape as `plotData.signalKey` minus the signal name — the
/// transmitter is a property of the message.
export function messageEcuKey(busId: string | null, messageId: number, extended: boolean): string {
  return `${busId ?? "*"}|${extended ? "x" : "s"}:${messageId}`;
}

/// Transmitting ECU per catalog message. Messages whose DBC names no
/// sender (the `Vector__XXX` placeholder, which arrives as `null`) get
/// no entry, so the label falls back to `bus · message`.
export function messageEcuLookup(
  catalog: readonly SignalDescriptorRecord[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const s of catalog) {
    if (!s.transmitter) continue;
    out.set(messageEcuKey(s.bus_id, s.message_id, s.extended), s.transmitter);
  }
  return out;
}

/// The message line for a signal row: the segments that have something
/// in them, joined with `·`. Unlike `signalSelection.signalPath` — the
/// ADR 0038 pattern subject, where an absent segment still renders so
/// segment positions stay fixed — this is a label, and a blank segment
/// would read as a stray separator.
export function signalRowLabel(
  busName: string | null | undefined,
  ecu: string | null | undefined,
  messageName: string,
): string {
  return [busName, ecu, messageName].filter((s) => !!s).join(" · ");
}
