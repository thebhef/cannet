import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type {
  DecodedFrameRecord,
  EncodeFrameResponse,
  EncodeFrameSignal,
  MessageDescriptorRecord,
  SignalDescriptorRichRecord,
  SignalRecord,
} from "./types";
import { useValueTables, type ValueTableSignal } from "./useValueTables";
import {
  type TransmitFrameConfig,
  bytesToHexString,
  parseHexBytes,
} from "./transmitFrameConfig";

interface SignalsTableProps {
  frame: TransmitFrameConfig;
  descriptor: MessageDescriptorRecord | null;
  onChange: (mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => void;
}

/// Signals table for the active mux arm. The rich message
/// descriptor (factor / offset / range / mux indicator / FD + BRS)
/// is loaded once at the [`TransmitFrameRow`] level and threaded
/// here as a prop; the decoded signal values come from `decode_frame`
/// on every `dataHex` change. Editing a value cell partial-encodes
/// that signal's bits via the host's `encode_frame` command.
export function SignalsTable({ frame, descriptor, onChange }: SignalsTableProps) {
  const [decoded, setDecoded] = useState<DecodedFrameRecord | null>(null);

  // Re-decode the bytes on every change. The Tauri call is cheap and
  // we want the signals table to track byte-cell edits live.
  const bytes = useMemo(() => parseHexBytes(frame.dataHex, 64), [frame.dataHex]);
  useEffect(() => {
    let cancelled = false;
    void invoke<DecodedFrameRecord | null>("decode_frame", {
      messageId: frame.canId,
      extended: frame.extended,
      data: bytes,
    })
      .then((d) => {
        if (!cancelled) setDecoded(d);
      })
      .catch(() => {
        if (!cancelled) setDecoded(null);
      });
    return () => {
      cancelled = true;
    };
  }, [frame.canId, frame.extended, bytes]);

  const commitEdits = useCallback(
    async (edits: EncodeFrameSignal[]) => {
      // Pad the bytes to the message's declared length so signals
      // toward the high end of a partly-edited payload have somewhere
      // to land. Round up to a known frame size if expectedLen is 0
      // (defensive default — should never be the case for a well-
      // formed DBC).
      const expected = descriptor?.expectedLen ?? 0;
      const padded = bytes.slice();
      while (padded.length < expected) padded.push(0);
      try {
        const resp = await invoke<EncodeFrameResponse>("encode_frame", {
          messageId: frame.canId,
          extended: frame.extended,
          signals: edits,
          base: padded,
        });
        onChange((f) => ({ ...f, dataHex: bytesToHexString(resp.bytes) }));
      } catch {
        // Surface in system log; nothing to do here.
      }
    },
    [bytes, descriptor, frame.canId, frame.extended, onChange],
  );

  // Edit one signal, accounting for mux semantics: when the user
  // edits the switch (multiplexor) signal, zero out every sub-signal
  // of the *new* arm in the same encode call so the new arm starts
  // fresh (no leakage from the previous arm's bit pattern).
  const commitOneSignal = useCallback(
    (sig: SignalDescriptorRichRecord, physical: number) => {
      if (sig.mux.kind === "multiplexor" && descriptor) {
        const newSelector = Math.round(physical);
        const newArm = descriptor.signals
          .filter(
            (s) =>
              s.mux.kind === "multiplexed" && s.mux.selector === newSelector,
          )
          .map((s) => ({ name: s.name, physical: 0 }));
        void commitEdits([{ name: sig.name, physical }, ...newArm]);
        return;
      }
      void commitEdits([{ name: sig.name, physical }]);
    },
    [commitEdits, descriptor],
  );

  if (frame.kind !== "classic" && frame.kind !== "fd") {
    return null;
  }
  if (!descriptor) {
    return (
      <div className="tx-signals tx-signals-empty">
        <span>no DBC message matches this id</span>
      </div>
    );
  }
  if (descriptor.usesExtendedMux) {
    // Nested / extended multiplexing (`m<N>M` indicators). Not
    // supported for signal-level editing yet — the user can still
    // edit the raw bytes above. See ADR 0017 for the
    // deferred signal-level-edit follow-ups.
    return (
      <div className="tx-signals tx-signals-extmux">
        <span>
          {descriptor.name} uses extended multiplexing — signal-level
          editing isn't supported here. Edit raw bytes above.
        </span>
      </div>
    );
  }
  const valuesByName = new Map<string, SignalRecord>();
  if (decoded) {
    for (const s of decoded.signals) valuesByName.set(s.name, s);
  }
  // Resolve the current switch value (if the message has a
  // multiplexor) so we can filter rows to the active arm. `decoded`
  // always carries the switch when one exists.
  const switchSig = descriptor.signals.find((s) => s.mux.kind === "multiplexor");
  const activeSelector =
    switchSig && valuesByName.has(switchSig.name)
      ? Math.round(valuesByName.get(switchSig.name)!.value)
      : null;
  // Active arm only — sub-signals for inactive arms are hidden, not
  // dimmed. Switching the switch zeroes the new arm's bits, so the
  // newly visible rows show 0 by default.
  const rows = descriptor.signals.filter((s) => {
    if (s.mux.kind === "plain" || s.mux.kind === "multiplexor") return true;
    if (s.mux.kind === "multiplexed") {
      return activeSelector !== null && s.mux.selector === activeSelector;
    }
    // `multiplexor_and_multiplexed` (sub-mux): not handled here —
    // these signals are hidden for now.
    return false;
  });
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className="tx-signals">
      <div className="tx-signals-header">
        <span className="tx-col-name">name</span>
        <span className="tx-col-value">value</span>
        <span className="tx-col-unit">unit</span>
        <span className="tx-col-range">range</span>
      </div>
      {rows.map((sig) => (
        <SignalRow
          key={sig.name}
          messageId={frame.canId}
          extended={frame.extended}
          sig={sig}
          decoded={valuesByName.get(sig.name) ?? null}
          onCommit={(physical) => commitOneSignal(sig, physical)}
        />
      ))}
    </div>
  );
}

interface SignalRowProps {
  messageId: number;
  extended: boolean;
  sig: SignalDescriptorRichRecord;
  decoded: SignalRecord | null;
  onCommit: (physical: number) => void;
}

/// One row in the signals table — name · value · unit · range. Picks
/// between a plain numeric input and an enum combobox based on the
/// signal's `hasValueTable` flag.
function SignalRow({ messageId, extended, sig, decoded, onCommit }: SignalRowProps) {
  return (
    <div className="tx-signal-row" role="row">
      <span className="tx-col-name" title={sig.name}>
        {sig.name}
      </span>
      {sig.hasValueTable ? (
        <EnumValueCell
          messageId={messageId}
          extended={extended}
          sig={sig}
          decoded={decoded}
          onCommit={onCommit}
        />
      ) : (
        <NumericValueCell sig={sig} decoded={decoded} onCommit={onCommit} />
      )}
      <span className="tx-col-unit">{sig.unit}</span>
      <span className="tx-col-range">{formatRange(sig)}</span>
    </div>
  );
}

interface NumericValueCellProps {
  sig: SignalDescriptorRichRecord;
  decoded: SignalRecord | null;
  onCommit: (physical: number) => void;
}

function NumericValueCell({ sig, decoded, onCommit }: NumericValueCellProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? (decoded ? formatPhysical(decoded.value) : "");
  return (
    <input
      className="tx-col-value tx-signal-input"
      type="text"
      inputMode="decimal"
      value={display}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const n = Number(draft);
        if (Number.isFinite(n)) onCommit(n);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
      aria-label={`${sig.name} value`}
    />
  );
}

interface EnumValueCellProps {
  messageId: number;
  extended: boolean;
  sig: SignalDescriptorRichRecord;
  decoded: SignalRecord | null;
  onCommit: (physical: number) => void;
}

/// Enum signal value cell. Combobox: an `<input>` linked to a
/// per-signal `<datalist>` of labels — the user types to filter the
/// label list, or types a raw number for the (rare) out-of-table
/// value. On commit:
///   1. exact label match → that row's raw value
///   2. numeric → that number directly
///   3. neither → cancel the edit (keep the current value)
///
/// The label table is loaded once per `(messageId, extended,
/// signal_name)` via the shared `useValueTables` hook.
function EnumValueCell({
  messageId,
  extended,
  sig,
  decoded,
  onCommit,
}: EnumValueCellProps) {
  const valueTableSignals = useMemo<ValueTableSignal[]>(
    () => [{ busId: null, messageId, extended, signalName: sig.name }],
    [messageId, extended, sig.name],
  );
  const [rows = []] = useValueTables(valueTableSignals).values();

  const [draft, setDraft] = useState<string | null>(null);
  // Display: if decoded carries a label use it; else show the raw
  // physical (which for enum signals is typically raw=physical since
  // factor=1, offset=0).
  const currentLabel = decoded?.label ?? null;
  const currentRaw = decoded ? decoded.value : null;
  const display =
    draft ??
    (currentLabel
      ? currentLabel
      : currentRaw != null
        ? formatPhysical(currentRaw)
        : "");
  const datalistId = `tx-enum-${messageId}-${extended ? "x" : "s"}-${sig.name}`;
  return (
    <>
      <input
        className="tx-col-value tx-signal-input"
        type="text"
        list={datalistId}
        value={display}
        // Clear on focus so the datalist offers *all* labels instead
        // of filtering on the current one (which locked the picker to
        // the already-selected value); the placeholder keeps the
        // committed label visible, and blurring untouched reverts.
        placeholder={
          currentLabel ?? (currentRaw != null ? formatPhysical(currentRaw) : "")
        }
        onFocus={() => setDraft("")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return;
          const text = draft.trim();
          setDraft(null);
          if (text === "") return;
          // Exact label match first — typing "Park" picks raw=0
          // regardless of how many "Park"-prefixed labels existed in
          // the datalist suggestions.
          const labelMatch = rows.find((r) => r.label === text);
          if (labelMatch) {
            onCommit(labelMatch.raw);
            return;
          }
          // Else parse as a number (raw value). For enum signals the
          // physical-vs-raw distinction collapses since factor/offset
          // are typically 1/0; if they aren't, this still sends the
          // physical value the user typed through `encode_frame` and
          // the encoder maps it back to bits.
          const n = Number(text);
          if (Number.isFinite(n)) onCommit(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        }}
        aria-label={`${sig.name} value (enum)`}
      />
      <datalist id={datalistId}>
        {rows.map((r) => (
          <option key={r.raw} value={r.label}>
            {r.raw}
          </option>
        ))}
      </datalist>
    </>
  );
}

/// Format a physical value for a single-cell display: compact
/// representation, trimmed trailing zeros, finite-precision so the
/// cell doesn't blow up on `0.1 + 0.2`-style noise.
function formatPhysical(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  // 6 significant digits is enough to distinguish factor=0.25 / 0.392…
  // signals at typical magnitudes; trim trailing zeros for compactness.
  const s = v.toPrecision(6);
  return Number(s).toString();
}

/// `[min, max]` if the DBC declared a real range, else derive from
/// `factor / offset / size / signed`. IEEE-float signals get an
/// open-ended placeholder (no integer range applies).
function formatRange(sig: SignalDescriptorRichRecord): string {
  if (sig.floatKind !== "integer") return "—";
  const haveDbcRange = sig.min !== sig.max;
  if (haveDbcRange) return `[${formatPhysical(sig.min)}, ${formatPhysical(sig.max)}]`;
  const size = sig.size;
  if (size <= 0 || size > 64) return "—";
  let rawMin: number;
  let rawMax: number;
  if (sig.signed) {
    rawMin = -(2 ** (size - 1));
    rawMax = 2 ** (size - 1) - 1;
  } else {
    rawMin = 0;
    rawMax = 2 ** size - 1;
  }
  const lo = rawMin * sig.factor + sig.offset;
  const hi = rawMax * sig.factor + sig.offset;
  const realLo = Math.min(lo, hi);
  const realHi = Math.max(lo, hi);
  return `[${formatPhysical(realLo)}, ${formatPhysical(realHi)}]`;
}
