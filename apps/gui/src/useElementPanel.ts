import { useCallback, useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { useElementRegistry, type ElementRegistry } from "./projectElements";
import { elementLabel } from "./elementLabel";
import type { ProjectElement, ProjectElementKind } from "./types";

/// The element id from a panel's dockview params, or a fresh one if
/// absent (a layout saved before elements existed, or a corrupt blob).
function elementIdFromParams(params: unknown): string {
  const p = params as { elementId?: unknown } | undefined;
  return typeof p?.elementId === "string" ? p.elementId : crypto.randomUUID();
}

export interface ElementPanelState<TConfig> {
  elementId: string;
  registry: ElementRegistry;
  /// The element as it currently stands in the registry (`undefined`
  /// only in the brief gap before `ensure` lands).
  element: ProjectElement | undefined;
  /// The panel's persisted view config, read once at mount: the
  /// element's `config` if present, else the dockview `params` — for
  /// an older project, or the unsaved-project `localStorage` layout
  /// that still carries it there.
  savedConfig: TConfig | undefined;
  /// Dual-write this panel's persistable state: onto the element
  /// (model state — survives closing and reopening the panel within a
  /// session, and is what `Save` serializes) and into the dockview
  /// `params` (the unsaved-project `localStorage` layout restores
  /// from `params` on app restart, and it doesn't persist the
  /// registry). The element's patch is a deep no-op check, so a mount
  /// whose state already equals the stored config doesn't churn the
  /// registry or mark the project dirty.
  ///
  /// Call from the panel's own `useEffect`, with that effect's own
  /// dependency array — the individual state fields `config` is built
  /// from, plus `persist` itself (referentially stable unless
  /// `elementId` changes). An element kind with no `config` field
  /// (transmit, rbs) calls `persist()` with no argument: only the
  /// elementId is written to params, nothing onto the registry.
  persist: (config?: TConfig) => void;
}

/// Element id resolution + registry `ensure` + `config` hydration +
/// dual-write persist — the lifecycle boilerplate shared by every
/// element-backed panel (trace, plot, transmit, rbs, …). See
/// {@link useElementSources} for the sources-picker wiring layered on
/// top, for the panels whose element carries a `sources` field.
export function useElementPanel<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
>(props: IDockviewPanelProps, kind: ProjectElementKind): ElementPanelState<TConfig> {
  const registry = useElementRegistry();
  const { ensure, update } = registry;
  const { api, params } = props;
  const [elementId] = useState(() => elementIdFromParams(params));
  useEffect(() => {
    ensure(elementId, kind);
  }, [ensure, elementId, kind]);

  // Read once at mount — `registry.get` resolves synchronously because
  // the element is restored before its panel mounts (project open) or
  // already exists (Elements-list reopen / fresh add).
  const [savedConfig] = useState<TConfig | undefined>(() => {
    const cfg = (registry.get(elementId)?.element as { config?: TConfig } | undefined)?.config;
    return cfg ?? (params as TConfig | undefined);
  });

  const persist = useCallback(
    (config?: TConfig) => {
      if (config !== undefined) {
        update(elementId, { config });
        api.updateParameters({ elementId, ...config });
      } else {
        api.updateParameters({ elementId });
      }
    },
    [api, update, elementId],
  );

  return {
    elementId,
    registry,
    element: registry.get(elementId)?.element,
    savedConfig,
    persist,
  };
}

export interface ElementSources {
  currentSources: string[];
  availableFilters: { id: string; label: string }[];
  handleSourcesChange: (next: string[]) => void;
}

/// Sources-picker wiring for an element whose kind carries a `sources`
/// field (trace, plot, signals, filter — not transmit/rbs, which are
/// sinks/replayers with no sources concept, nor colormap, an ambient
/// element not wired through the graph). `["*"]` (every bus) is the
/// defensive default for a still-healing or legacy-shaped element, so
/// the picker never reads from `undefined`.
/// The unwired default ("every bus"), as one shared array. A fresh
/// `["*"]` per render invalidates every memo keyed on `currentSources`
/// — for the plot that is the scoped catalog, and through it the
/// derived axes and each area's props.
const ALL_BUSES: string[] = ["*"];

export function useElementSources(
  registry: ElementRegistry,
  elementId: string,
  element: ProjectElement | undefined,
): ElementSources {
  const currentSources =
    element && element.kind !== "transmit" && element.kind !== "rbs" && element.kind !== "colormap"
      ? element.sources ?? ALL_BUSES
      : ALL_BUSES;
  // Filters available to wire upstream of this element. Exclude any
  // non-filter elements; the cycle guard in `applyElementPatch`
  // protects against pathological selections (including this element
  // being its own source, transitively).
  const availableFilters = useMemo(
    () =>
      registry.entries
        .filter((e) => e.element.kind === "filter")
        .map((e) => ({ id: e.element.id, label: elementLabel(e.element) })),
    [registry.entries],
  );
  const handleSourcesChange = useCallback(
    (next: string[]) => registry.update(elementId, { sources: next }),
    [registry, elementId],
  );
  return { currentSources, availableFilters, handleSourcesChange };
}
