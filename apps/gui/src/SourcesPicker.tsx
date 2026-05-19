import { useEffect, useMemo } from "react";

import type { Bus } from "./types";

interface ChecklistProps {
  buses: readonly Bus[];
  filters: readonly { id: string; label: string }[];
  busChecked: (id: string) => boolean;
  allBusesChecked: boolean;
  selectedFilters: ReadonlySet<string>;
  setWildcard: (checked: boolean) => void;
  setBusChecked: (id: string, checked: boolean) => void;
  setFilterChecked: (id: string, checked: boolean) => void;
}

function SourcesChecklist(props: ChecklistProps) {
  const {
    buses,
    filters,
    busChecked,
    allBusesChecked,
    selectedFilters,
    setWildcard,
    setBusChecked,
    setFilterChecked,
  } = props;
  return (
    <div className="sources-picker-popover" role="group">
      <div className="sources-picker-header">Sources</div>
      {buses.length > 0 && (
        <div className="sources-picker-group">
          <label className="sources-picker-row">
            <input
              type="checkbox"
              checked={allBusesChecked}
              onChange={(e) => setWildcard(e.target.checked)}
            />
            <span>All logical buses</span>
          </label>
          {buses.map((b) => (
            <label key={b.id} className="sources-picker-row">
              <input
                type="checkbox"
                checked={busChecked(b.id)}
                onChange={(e) => setBusChecked(b.id, e.target.checked)}
              />
              <span>{b.name}</span>
            </label>
          ))}
        </div>
      )}
      {filters.length > 0 && (
        <div className="sources-picker-group sources-picker-group-filters">
          <div className="sources-picker-subheader">Filters</div>
          {filters.map((f) => (
            <label key={f.id} className="sources-picker-row">
              <input
                type="checkbox"
                checked={selectedFilters.has(f.id)}
                onChange={(e) => setFilterChecked(f.id, e.target.checked)}
              />
              <span>{f.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/// "Headless" menu-section form of the sources picker — renders the
/// checklist (and an optional "Insert filter upstream" action) with
/// no outer chrome or outside-click handling. Callers that already
/// own a context-menu shell (the plot panel's `plot-toolbar-menu`,
/// say) embed this directly.
export function SourcesMenuSection(props: {
  value: readonly string[];
  buses: readonly Bus[];
  filters: readonly { id: string; label: string }[];
  onChange: (next: string[]) => void;
  onInsertFilter?: () => void;
}) {
  const { value, buses, filters, onChange, onInsertFilter } = props;
  const helpers = useSourcesHelpers(value, buses, filters, onChange);
  return (
    <>
      <SourcesChecklist
        buses={buses}
        filters={filters}
        busChecked={helpers.busChecked}
        allBusesChecked={helpers.allBusesChecked}
        selectedFilters={helpers.selectedFilters}
        setWildcard={helpers.setWildcard}
        setBusChecked={helpers.setBusChecked}
        setFilterChecked={helpers.setFilterChecked}
      />
      {onInsertFilter && (
        <button
          type="button"
          className="sources-context-menu-action"
          onClick={onInsertFilter}
          title="Create a new filter whose inputs are this view's current sources, and route this view through it"
        >
          Insert filter upstream
        </button>
      )}
    </>
  );
}

/// Floating context-menu version of the sources picker. Trace and
/// plot panels open this on right-click; closes on Escape or any
/// click outside the menu. Position is the cursor location at the
/// triggering right-click. `onInsertFilter` is the optional "Insert
/// filter upstream" command — present for trace/plot consumers; it
/// fires the standard `insertFilterUpstream` flow and dismisses the
/// menu.
export function SourcesContextMenu(props: {
  position: { x: number; y: number };
  value: readonly string[];
  buses: readonly Bus[];
  filters: readonly { id: string; label: string }[];
  onChange: (next: string[]) => void;
  onClose: () => void;
  onInsertFilter?: () => void;
}) {
  const { position, value, buses, filters, onChange, onClose, onInsertFilter } = props;
  const helpers = useSourcesHelpers(value, buses, filters, onChange);

  // Close on Escape or outside-click. `mousedown` rather than
  // `click` so a click on a `<label>` (which fires `click` after the
  // wrapped input toggles) doesn't dismiss the menu prematurely.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest(".sources-context-menu")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="sources-context-menu"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <SourcesChecklist
        buses={buses}
        filters={filters}
        busChecked={helpers.busChecked}
        allBusesChecked={helpers.allBusesChecked}
        selectedFilters={helpers.selectedFilters}
        setWildcard={helpers.setWildcard}
        setBusChecked={helpers.setBusChecked}
        setFilterChecked={helpers.setFilterChecked}
      />
      {onInsertFilter && (
        <button
          type="button"
          className="sources-context-menu-action"
          onClick={() => {
            onInsertFilter();
            onClose();
          }}
          title="Create a new filter whose inputs are this view's current sources, and route this view through it"
        >
          Insert filter upstream
        </button>
      )}
    </div>
  );
}

/// Toggle helpers shared by {@link SourcesContextMenu} and
/// {@link SourcesMenuSection}. Returned object is a flat record of
/// the checked-state computations + setters; consumers feed them
/// straight into {@link SourcesChecklist}.
function useSourcesHelpers(
  value: readonly string[],
  buses: readonly Bus[],
  filters: readonly { id: string; label: string }[],
  onChange: (next: string[]) => void,
) {
  const hasWildcard = value.includes("*");
  const explicitBuses = useMemo(
    () => new Set(value.filter((s) => s !== "*" && buses.some((b) => b.id === s))),
    [value, buses],
  );
  const selectedFilters = useMemo(
    () => new Set(value.filter((s) => filters.some((f) => f.id === s))),
    [value, filters],
  );
  const busChecked = (id: string) => hasWildcard || explicitBuses.has(id);
  const allBusesChecked =
    hasWildcard || (buses.length > 0 && buses.every((b) => explicitBuses.has(b.id)));
  const setBusChecked = (id: string, checked: boolean) => {
    if (checked) {
      if (hasWildcard || explicitBuses.has(id)) return;
      const nextBuses = new Set(explicitBuses);
      nextBuses.add(id);
      if (buses.every((b) => nextBuses.has(b.id))) {
        onChange(["*", ...selectedFilters]);
        return;
      }
      onChange(emit(nextBuses, selectedFilters, false));
    } else {
      if (hasWildcard) {
        const expanded = new Set(buses.map((b) => b.id));
        expanded.delete(id);
        onChange(emit(expanded, selectedFilters, false));
        return;
      }
      const nextBuses = new Set(explicitBuses);
      nextBuses.delete(id);
      onChange(emit(nextBuses, selectedFilters, false));
    }
  };
  const setWildcard = (checked: boolean) => {
    if (checked) onChange(["*", ...selectedFilters]);
    else onChange(emit(new Set(), selectedFilters, false));
  };
  const setFilterChecked = (id: string, checked: boolean) => {
    const nextFilters = new Set(selectedFilters);
    if (checked) nextFilters.add(id);
    else nextFilters.delete(id);
    onChange(emit(explicitBuses, nextFilters, hasWildcard));
  };
  return {
    busChecked,
    allBusesChecked,
    selectedFilters,
    setBusChecked,
    setWildcard,
    setFilterChecked,
  };
}

/// Build the emitted `sources` array from the picker's internal sets.
/// Order: wildcard first, then bus ids in the project's order (via
/// the caller's set), then filter ids. (The caller normalises ordering
/// of `buses` by passing the Set already constrained to the project's
/// bus order.) Exported only for direct unit-testing of the
/// normalisation rules.
export function emit(
  explicitBuses: ReadonlySet<string>,
  filters: ReadonlySet<string>,
  wildcard: boolean,
): string[] {
  const out: string[] = [];
  if (wildcard) out.push("*");
  for (const b of explicitBuses) out.push(b);
  for (const f of filters) out.push(f);
  return out;
}

