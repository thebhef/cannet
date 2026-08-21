/// The RBS signal value editor, shared between the RBS panel's own
/// tree (`RbsPanel.tsx`) and the RBS signals grid
/// (`RbsSignalsPanel.tsx`, task 89 phase 6) — **one** implementation so
/// the two can't disagree at the boundary. Both edit the same override
/// through the same `rbs_set_signal` command; a signal cell here is
/// the enum `Combobox` / free-text `ValidatedInput` split
/// `RbsPanel.tsx` always used, now with clamp-on-entry
/// (`rbsValueClamp.ts`) applied to every plain numeric commit before
/// it reaches the caller's `onCommit`.

import { useMemo } from "react";

import type { ValueTableEntryRecord } from "./types";
import { Combobox } from "./Combobox";
import { ValidatedInput } from "./ValidatedInput";
import { useValueTables, valueTableOptions, type ValueTableSignal } from "./useValueTables";
import { clampToSignalRange, type SignalRangeInputs } from "./rbsValueClamp";

/// The signal fields a value cell needs — the physical-range inputs
/// plus what's rendered/edited. A subset of `RbsSignalView` /
/// `RbsSignalRow`, satisfied by either without adapting either shape.
export interface RbsValueCellSignal extends SignalRangeInputs {
  name: string;
  value: number | null;
  label: string | null;
  overridden: boolean;
  overrideText: string | null;
  calcRole: "counter" | "crc" | null;
  hasValueTable: boolean;
}

export interface RbsValueCellProps {
  signal: RbsValueCellSignal;
  /// For the value-table fetch (`useValueTables`) — `null` when the
  /// row's bus doesn't resolve to a project bus.
  busId: string | null;
  messageId: number;
  extended: boolean;
  disabled: boolean;
  /// A committed edit: a `VAL_` label, a `0x…` raw string, or a
  /// clamped physical number — never an out-of-range number.
  onCommit: (value: string | number) => void;
  onClear: () => void;
  className?: string;
}

export function RbsValueCell({
  signal: s,
  busId,
  messageId,
  extended,
  disabled,
  onCommit,
  onClear,
  className,
}: RbsValueCellProps) {
  const valueTableSignals = useMemo<ValueTableSignal[]>(
    () => (s.hasValueTable ? [{ busId, messageId, extended, signalName: s.name }] : []),
    [s.hasValueTable, s.name, busId, messageId, extended],
  );
  const [labels = []] = useValueTables(valueTableSignals).values();
  const enumOptions = useMemo(() => valueTableOptions(labels), [labels]);

  const display = s.label ?? (s.value != null ? formatValue(s.value) : "—");
  const cellClassName = className ?? "rbs-signal-input";

  const commit = (value: string | number) => {
    // Clamp on entry (task 89 phase 6, grooming resolution "Out of
    // Range is a frontend concern, and clamping is shared code"): a
    // plain number is a physical value and must land in the signal's
    // range before it's ever sent; a VAL_ label or 0x… raw value has
    // no such range to be out of.
    onCommit(typeof value === "number" ? clampToSignalRange(value, s) : value);
  };

  if (s.calcRole) {
    return (
      <span
        className="rbs-calc-cell"
        title={`${s.calcRole} destination — recomputed on every send`}
      >
        {display} <em>({s.calcRole})</em>
      </span>
    );
  }

  return (
    <>
      {s.hasValueTable ? (
        <Combobox
          options={enumOptions}
          value={s.label ?? ""}
          placeholder={display === "—" ? "" : display}
          onChange={(v) => {
            const parsed = parseSignalText(v, labels);
            if (parsed !== null) commit(parsed);
          }}
          className={cellClassName}
          ariaLabel={`${s.name} value`}
          disabled={disabled}
          freeText
        />
      ) : (
        <ValidatedInput
          value={display === "—" ? "" : display}
          focusBehavior="select"
          parse={(text) => parseSignalText(text, labels)}
          onCommit={commit}
          className={cellClassName}
          ariaLabel={`${s.name} value`}
          disabled={disabled}
        />
      )}
      {s.overridden && (
        <button
          type="button"
          className="rbs-clear"
          tabIndex={-1}
          title={`clear override (track DBC default)${s.overrideText ? ` — currently ${s.overrideText}` : ""}`}
          onClick={onClear}
        >
          ×
        </button>
      )}
    </>
  );
}

/// A signal cell's text → the value `rbs_set_signal` takes: a VAL_
/// label verbatim (the file stores labels), else a number, else a `0x`
/// raw. Anything else is rejected — the edit reverts.
export function parseSignalText(
  text: string,
  labels: readonly ValueTableEntryRecord[],
): string | number | null {
  const t = text.trim();
  if (t === "") return null;
  if (labels.some((l) => l.label === t)) return t;
  // The hex check must come *before* `Number()`: `Number("0xA")` is a
  // valid JS numeric literal (10), so testing it first would silently
  // reinterpret every well-formed hex override as a physical number
  // and never reach the raw-bits path `reconstruct_payload` gives it
  // (task 89 phase 6 — found while extracting this into shared code).
  if (/^0x[0-9a-fA-F]+$/i.test(t)) return t;
  const n = Number(t);
  if (Number.isFinite(n)) return n;
  return null;
}

export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  const s = v.toPrecision(6);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
