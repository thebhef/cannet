import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";

import type {
  DecodedFrameRecord,
  EncodeFrameResponse,
  EncodeFrameSignal,
  MessageDescriptorRecord,
  SignalDescriptorRichRecord,
  SignalRecord,
} from "./types";
import {
  useValueTables,
  valueTableOptions,
  type ValueTableSignal,
} from "./useValueTables";
import { parseFiniteNumber } from "./ValidatedInput";
import { Combobox } from "./Combobox";
import {
  type TransmitFrameConfig,
  bytesToHexString,
  parseHexBytes,
} from "./transmitFrameConfig";
import { NameText } from "./NameText";

/// How a disclosed signal line takes part in the gridview (ADR 0044).
/// Each line is a row of the space in its own right, so it needs the
/// DOM id `aria-activedescendant` names, whether the cursor and the
/// selection are on it, and a click that moves them here.
///
/// `onRows` is the other direction: which signals are actually on
/// screen is decided here — the active mux arm depends on the decoded
/// switch value, which only this component holds — so the table tells
/// the panel what it disclosed rather than the panel guessing.
export interface SignalContentRows {
  domId(name: string): string;
  active(name: string): boolean;
  selected(name: string): boolean;
  onClick(name: string, e: ReactMouseEvent): void;
  onRows(names: readonly string[]): void;
}

interface SignalsTableProps {
  frame: TransmitFrameConfig;
  descriptor: MessageDescriptorRecord | null;
  onChange: (mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => void;
  contentRows: SignalContentRows;
}

/// Signals table for the active mux arm. The rich message
/// descriptor (factor / offset / range / mux indicator / FD + BRS)
/// is loaded once at the [`TransmitFrameRow`] level and threaded
/// here as a prop; the decoded signal values come from `decode_frame`
/// on every `dataHex` change. Editing a value cell partial-encodes
/// that signal's bits via the host's `encode_frame` command.
export function SignalsTable({
  frame,
  descriptor,
  onChange,
  contentRows,
}: SignalsTableProps) {
  const [decoded, setDecoded] = useState<DecodedFrameRecord | null>(null);

  // Re-decode the bytes on every change. The Tauri call is cheap and
  // we want the signals table to track byte-cell edits live.
  const bytes = useMemo(() => parseHexBytes(frame.dataHex, 64), [frame.dataHex]);
  useEffect(() => {
    let cancelled = false;
    void invoke<DecodedFrameRecord | null>("decode_frame", {
      busId: frame.busId,
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
  }, [frame.busId, frame.canId, frame.extended, bytes]);

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
          busId: frame.busId,
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
    [bytes, descriptor, frame.busId, frame.canId, frame.extended, onChange],
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

  // The lines this table will render, decided before the early returns
  // below so a hook can report them to the panel — the rules of hooks,
  // and the reason this is a memo rather than the plain walk it was.
  const valuesByName = useMemo(() => {
    const m = new Map<string, SignalRecord>();
    for (const s of decoded?.signals ?? []) m.set(s.name, s);
    return m;
  }, [decoded]);
  const rows = useMemo(() => {
    if (descriptor == null || descriptor.usesExtendedMux) return EMPTY_SIGNALS;
    if (frame.kind !== "classic" && frame.kind !== "fd") return EMPTY_SIGNALS;
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
    return descriptor.signals.filter((s) => {
      if (s.mux.kind === "plain" || s.mux.kind === "multiplexor") return true;
      if (s.mux.kind === "multiplexed") {
        return activeSelector !== null && s.mux.selector === activeSelector;
      }
      // `multiplexor_and_multiplexed` (sub-mux): not handled here —
      // these signals are hidden for now.
      return false;
    });
  }, [descriptor, frame.kind, valuesByName]);

  // Report what is on screen to the panel's row space. Keyed on the
  // names themselves, not on the callback — the panel hands a fresh
  // closure every render, and depending on that would report in a loop.
  const onRowsRef = useRef(contentRows.onRows);
  onRowsRef.current = contentRows.onRows;
  const names = rows.map((s) => s.name).join(NAME_SEP);
  useEffect(() => {
    onRowsRef.current(names.length === 0 ? EMPTY_NAMES : names.split(NAME_SEP));
  }, [names]);

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
          busId={frame.busId}
          messageId={frame.canId}
          extended={frame.extended}
          sig={sig}
          decoded={valuesByName.get(sig.name) ?? null}
          onCommit={(physical) => commitOneSignal(sig, physical)}
          domId={contentRows.domId(sig.name)}
          active={contentRows.active(sig.name)}
          selected={contentRows.selected(sig.name)}
          onClick={(e) => contentRows.onClick(sig.name, e)}
        />
      ))}
    </div>
  );
}

interface SignalRowProps {
  /// The bus the row transmits on — what scopes its enum labels to the
  /// databases assigned to that bus, exactly as decode is scoped.
  busId: string | null;
  messageId: number;
  extended: boolean;
  sig: SignalDescriptorRichRecord;
  decoded: SignalRecord | null;
  onCommit: (physical: number) => void;
  /// This line's share of the gridview (ADR 0044): the DOM id
  /// `aria-activedescendant` names, the cursor, the selection, and the
  /// click that moves them here.
  domId: string;
  active: boolean;
  selected: boolean;
  onClick: (e: ReactMouseEvent) => void;
}

/// One row in the signals table — name · value · unit · range. Picks
/// between a plain numeric input and an enum combobox based on the
/// signal's `hasValueTable` flag.
function SignalRow({
  busId,
  messageId,
  extended,
  sig,
  decoded,
  onCommit,
  domId,
  active,
  selected,
  onClick,
}: SignalRowProps) {
  return (
    <div
      id={domId}
      className={selected ? "tx-signal-row tx-signal-row-selected" : "tx-signal-row"}
      role="treeitem"
      aria-selected={selected}
      data-active={active || undefined}
      onClick={onClick}
    >
      <span className="tx-col-name" title={sig.name}>
        <NameText name={sig.name} />
      </span>
      {sig.hasValueTable ? (
        <EnumValueCell
          busId={busId}
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
  busId: string | null;
  messageId: number;
  extended: boolean;
  sig: SignalDescriptorRichRecord;
  decoded: SignalRecord | null;
  onCommit: (physical: number) => void;
}

/// Enum signal value cell: the shared `Combobox` over the signal's
/// `VAL_` labels, one row per label. Picking one commits that row's
/// raw value. `freeText` keeps the (rare) out-of-table code reachable
/// — the typed text becomes a row of its own and commits as a number;
/// for enum signals the physical-vs-raw distinction collapses since
/// factor/offset are typically 1/0, and where they aren't the encoder
/// maps the physical value back to bits.
///
/// The label table is loaded once per `(messageId, extended,
/// signal_name)` via the shared `useValueTables` hook.
function EnumValueCell({
  busId,
  messageId,
  extended,
  sig,
  decoded,
  onCommit,
}: EnumValueCellProps) {
  const valueTableSignals = useMemo<ValueTableSignal[]>(
    () => [{ busId, messageId, extended, signalName: sig.name }],
    [busId, messageId, extended, sig.name],
  );
  const [rows = []] = useValueTables(valueTableSignals).values();
  const options = useMemo(() => valueTableOptions(rows), [rows]);

  // Display: if decoded carries a label use it; else show the raw
  // physical (which for enum signals is typically raw=physical since
  // factor=1, offset=0).
  const currentLabel = decoded?.label ?? null;
  const currentRaw = decoded ? decoded.value : null;
  const display =
    currentLabel ?? (currentRaw != null ? formatPhysical(currentRaw) : "");
  return (
    <Combobox
      className="tx-col-value tx-signal-input"
      options={options}
      proseLabels
      value={currentLabel ?? ""}
      placeholder={display}
      onChange={(v) => {
        // Exact label match first — "Park" is raw=0 however many
        // "Park"-prefixed labels the list also offered.
        const labelMatch = rows.find((r) => r.label === v);
        if (labelMatch) {
          onCommit(labelMatch.raw);
          return;
        }
        const n = parseFiniteNumber(v);
        if (n !== null) onCommit(n);
      }}
      ariaLabel={`${sig.name} value (enum)`}
      freeText
    />
  );
}

/// Stable empties, so a table with nothing to show hands the memo and
/// the report the same value every render. `NAME_SEP` is a NUL, which
/// no DBC identifier can carry, so joining and splitting round-trips.
const EMPTY_SIGNALS: readonly SignalDescriptorRichRecord[] = [];
const EMPTY_NAMES: readonly string[] = [];
const NAME_SEP = "\u0000";

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
