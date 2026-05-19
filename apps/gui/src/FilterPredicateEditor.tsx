import { useEffect, useState } from "react";

import type { FilterPredicate } from "./types";

/// One of the leaf shapes the inline editor exposes. The
/// composition shapes (`all` / `any`) are intentionally excluded —
/// the typical filter wants a single leaf predicate (e.g. a bus, an
/// id range), and a chain of filters expresses AND-composition via
/// the consumer's `sources` list. Editing a nested predicate in a
/// graph node is awkward visually; users who actually need nesting
/// can hand-edit the project JSON until we have a richer editor.
type Variant =
  | "none"
  | "bus"
  | "id_range"
  | "id_list"
  | "name_regex"
  | "signal_equals";

interface Props {
  /// The filter's current predicate, or `null` for pass-through.
  predicate: FilterPredicate | null | undefined;
  /// The filter's user-facing name; saved alongside the predicate so
  /// the picker in the sources popover and the node label match what
  /// the user typed.
  name: string | undefined;
  /// Project bus list — used to populate the bus-variant dropdown.
  /// Empty list disables the bus variant.
  busIds: readonly string[];
  /// Persist a patch. The caller wires this to
  /// `registry.update(filterId, patch)`.
  onChange: (patch: { predicate?: FilterPredicate | null; name?: string }) => void;
}

/// Build a fresh predicate of the given variant. Returned literally
/// so the inputs have a value to render even on the first render
/// after the user picks a variant.
function defaultOf(variant: Variant, busIds: readonly string[]): FilterPredicate | null {
  switch (variant) {
    case "none":
      return null;
    case "bus":
      return { bus: busIds[0] ?? "" };
    case "id_range":
      return { id_range: [0x100, 0x1ff] };
    case "id_list":
      return { id_list: [0x100] };
    case "name_regex":
      return { name_regex: "" };
    case "signal_equals":
      return { signal_equals: { name: "", value: 0 } };
  }
}

/// What leaf variant is this predicate? Composition shapes are
/// reported as `none` so the inline editor can render the
/// pass-through state (with a "nested predicate — edit JSON to
/// view" hint, future work).
export function variantOf(p: FilterPredicate | null | undefined): Variant {
  if (!p) return "none";
  if ("bus" in p) return "bus";
  if ("id_range" in p) return "id_range";
  if ("id_list" in p) return "id_list";
  if ("name_regex" in p) return "name_regex";
  if ("signal_equals" in p) return "signal_equals";
  return "none";
}

export function FilterPredicateEditor({ predicate, name, busIds, onChange }: Props) {
  const initialVariant = variantOf(predicate);
  const [variant, setVariant] = useState<Variant>(initialVariant);
  // The local form state — committed to the registry on each input
  // change (no separate "save" button; this matches how the other
  // panels persist).
  const [draft, setDraft] = useState<FilterPredicate | null>(
    predicate ?? null,
  );
  // If the predicate changes from outside (another panel / project
  // load), reconcile.
  useEffect(() => {
    setDraft(predicate ?? null);
    setVariant(variantOf(predicate));
  }, [predicate]);

  const pickVariant = (v: Variant) => {
    setVariant(v);
    const next = defaultOf(v, busIds);
    setDraft(next);
    onChange({ predicate: next });
  };

  const commit = (next: FilterPredicate | null) => {
    setDraft(next);
    onChange({ predicate: next });
  };

  return (
    // `nodrag` / `nowheel`: this editor lives inside an xyflow node;
    // without them a click on a control starts a node-drag (the node
    // "sticks to the mouse") and a scroll zooms the canvas.
    <div
      className="filter-predicate-editor nodrag nowheel"
      onClick={(e) => e.stopPropagation()}
    >
      <label className="filter-predicate-row">
        <span>Name</span>
        <input
          type="text"
          value={name ?? ""}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="(filter name)"
        />
      </label>
      <label className="filter-predicate-row">
        <span>Predicate</span>
        <select
          value={variant}
          onChange={(e) => pickVariant(e.target.value as Variant)}
        >
          <option value="none">(none — pass through)</option>
          <option value="bus">bus</option>
          <option value="id_range">id range</option>
          <option value="id_list">id list</option>
          <option value="name_regex">message name regex</option>
          <option value="signal_equals">signal equals</option>
        </select>
      </label>
      {variant === "bus" && draft && "bus" in draft && (
        <label className="filter-predicate-row">
          <span>bus id</span>
          <select
            value={draft.bus}
            onChange={(e) => commit({ bus: e.target.value })}
          >
            {busIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      )}
      {variant === "id_range" && draft && "id_range" in draft && (
        <div className="filter-predicate-row">
          <span>id range (hex)</span>
          <input
            type="text"
            value={draft.id_range[0].toString(16)}
            onChange={(e) => {
              const lo = parseInt(e.target.value, 16);
              if (Number.isFinite(lo)) commit({ id_range: [lo, draft.id_range[1]] });
            }}
            aria-label="id range lo"
          />
          <span>…</span>
          <input
            type="text"
            value={draft.id_range[1].toString(16)}
            onChange={(e) => {
              const hi = parseInt(e.target.value, 16);
              if (Number.isFinite(hi)) commit({ id_range: [draft.id_range[0], hi] });
            }}
            aria-label="id range hi"
          />
        </div>
      )}
      {variant === "id_list" && draft && "id_list" in draft && (
        <label className="filter-predicate-row">
          <span>id list (hex, comma-separated)</span>
          <input
            type="text"
            value={draft.id_list.map((n) => n.toString(16)).join(",")}
            onChange={(e) => {
              const ids = e.target.value
                .split(/[,\s]+/)
                .map((s) => parseInt(s, 16))
                .filter((n) => Number.isFinite(n));
              commit({ id_list: ids });
            }}
          />
        </label>
      )}
      {variant === "name_regex" && draft && "name_regex" in draft && (
        <label className="filter-predicate-row">
          <span>regex</span>
          <input
            type="text"
            value={draft.name_regex}
            onChange={(e) => commit({ name_regex: e.target.value })}
            placeholder="^Engine.*"
          />
        </label>
      )}
      {variant === "signal_equals" && draft && "signal_equals" in draft && (
        <div className="filter-predicate-row">
          <span>signal</span>
          <input
            type="text"
            value={draft.signal_equals.name}
            onChange={(e) =>
              commit({
                signal_equals: { name: e.target.value, value: draft.signal_equals.value },
              })
            }
            placeholder="signal name"
            aria-label="signal name"
          />
          <span>=</span>
          <input
            type="number"
            value={draft.signal_equals.value}
            onChange={(e) =>
              commit({
                signal_equals: {
                  name: draft.signal_equals.name,
                  value: Number(e.target.value),
                },
              })
            }
            aria-label="signal value"
          />
        </div>
      )}
    </div>
  );
}
