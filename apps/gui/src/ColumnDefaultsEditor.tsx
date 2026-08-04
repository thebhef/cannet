// The editor behind the `column-defaults` custom setting renderer
// (ADR 0034): the layout a *newly created* trace, by-ID, or signal
// table opens with.
//
// It is an editor rather than a pointer (the shape `keybindings` takes,
// which sends you to the shortcuts panel) because there is nowhere else
// to set a *default* — a table header adjusts the panel you are looking
// at, not the one you will open next. It owns no arithmetic of its own:
// every edit goes through the same pure functions the table header
// uses (`toggleColumn` / `resizeColumn` / `reorderColumn`), so a
// default and a live layout can never disagree about what a move means.

import {
  COLUMN_DEFS,
  type ColumnDef,
  type ColumnState,
  columnDefFor,
  configuredColumnsFor,
  reorderColumn,
  resizeColumn,
  toggleColumn,
} from "./traceColumns";
import { SIGNAL_COLUMN_DEFS } from "./signalColumns";
import type { SettingDescriptor } from "./settingDescriptors";

/// Which column set each setting names. Two settings share this one
/// renderer because the two tables differ only in their columns.
const COLUMN_SETS: Record<
  string,
  { defs: readonly ColumnDef<string>[]; legacy: Record<string, string> }
> = {
  trace_columns: { defs: COLUMN_DEFS, legacy: { ch: "bus" } },
  signal_columns: { defs: SIGNAL_COLUMN_DEFS, legacy: {} },
};

export function ColumnDefaultsEditor({
  descriptor,
  value,
  onCommit,
}: {
  descriptor: SettingDescriptor;
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const set = COLUMN_SETS[descriptor.key];
  if (set === undefined) {
    // A descriptor naming this renderer for a key with no column set is
    // a bug in the table, so it is shown rather than swallowed.
    return (
      <p className="setting-custom setting-missing-renderer">
        No column set for “{descriptor.key}”.
      </p>
    );
  }
  // An unset setting shows the app's built-in layout, so the first edit
  // starts from what a fresh panel actually opens with rather than from
  // an empty list.
  const columns = configuredColumnsFor(set.defs, value, set.legacy);
  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= columns.length) return;
    // `reorderColumn` inserts *before* a key: moving down means landing
    // before whatever follows the neighbour we are stepping over.
    const beforeKey = by === -1 ? columns[target].key : (columns[target + 1]?.key ?? null);
    onCommit(reorderColumn(columns, columns[index].key, beforeKey));
  };
  return (
    <div className="column-defaults">
      {columns.map((c, i) => (
        <ColumnRow
          // The width is in the key so an externally-changed value
          // re-seeds the uncontrolled width box.
          key={`${c.key}:${c.width}`}
          column={c}
          label={labelOf(set.defs, c.key)}
          canMoveUp={i > 0}
          canMoveDown={i < columns.length - 1}
          onToggle={() => onCommit(toggleColumn(columns, c.key))}
          onWidth={(width) => onCommit(resizeColumn(columns, c.key, width))}
          onMoveUp={() => move(i, -1)}
          onMoveDown={() => move(i, 1)}
        />
      ))}
      <button type="button" className="setting-reset" onClick={() => onCommit(null)}>
        Use the built-in layout
      </button>
    </div>
  );
}

/// A column's header label. Where the by-ID view relabels a column (the
/// `idx` column counts frames there rather than numbering rows), both
/// labels are shown — one row here governs both tables.
function labelOf(defs: readonly ColumnDef<string>[], key: string): string {
  const def = columnDefFor(defs, key);
  return def.byIdLabel === undefined || def.byIdLabel === def.label
    ? def.label
    : `${def.label} / ${def.byIdLabel}`;
}

function ColumnRow({
  column,
  label,
  canMoveUp,
  canMoveDown,
  onToggle,
  onWidth,
  onMoveUp,
  onMoveDown,
}: {
  column: ColumnState<string>;
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggle: () => void;
  onWidth: (width: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  // The width box commits on blur / Enter rather than per keystroke:
  // each commit is a whole-file settings write, and a half-typed "3" on
  // the way to "300" would be clamped to the minimum and written.
  const commitWidth = (raw: string) => {
    const width = Number(raw.trim());
    if (!Number.isFinite(width) || width <= 0 || width === column.width) return;
    onWidth(width);
  };
  return (
    <div className="column-default-row">
      <label className="setting-checkbox">
        <input
          type="checkbox"
          aria-label={`show ${label}`}
          checked={column.visible}
          onChange={onToggle}
        />
        <span className="column-default-label">{label}</span>
      </label>
      <input
        type="number"
        aria-label={`${label} width`}
        min={1}
        defaultValue={column.width}
        onBlur={(e) => commitWidth(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitWidth(e.currentTarget.value);
        }}
      />
      <span className="setting-unit">px</span>
      <button
        type="button"
        aria-label={`move ${label} up`}
        disabled={!canMoveUp}
        onClick={onMoveUp}
      >
        ▲
      </button>
      <button
        type="button"
        aria-label={`move ${label} down`}
        disabled={!canMoveDown}
        onClick={onMoveDown}
      >
        ▼
      </button>
    </div>
  );
}
