import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /// an older project, or the project directory's layout snapshot,
  /// which still carries it there. Later changes to the element's
  /// config arrive through the hook's `rehydrate` callback instead, not
  /// by this value changing.
  savedConfig: TConfig | undefined;
  /// Dual-write this panel's persistable state: onto the element
  /// (model state — survives closing and reopening the panel within a
  /// session, and is what `Save` serializes) and into the dockview
  /// `params` (the project directory's layout snapshot restores from
  /// `params` on app restart, and it doesn't persist the registry). The element's patch is a deep no-op check, so a mount
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
/// dual-write persist + rehydration — the lifecycle boilerplate shared
/// by every element-backed panel (trace, plot, signals, transmit, rbs,
/// …). See {@link useElementSources} for the sources-picker wiring
/// layered on top, for the panels whose element carries a `sources`
/// field.
///
/// `rehydrate` closes the loop the mount-time `savedConfig` read leaves
/// open: a panel is otherwise a write-only mirror of its element, so a
/// config rewritten from outside it (and, in time, a restored one) would
/// simply be overwritten by the panel's next persist. Pass the apply
/// function that pushes a stored config into this panel's view state —
/// the same fields it seeds from `savedConfig` at mount — and it is
/// called whenever the element's config changes for any reason other
/// than this panel's own persist. Panels whose element carries no
/// `config` (transmit, rbs) and panels that read the element live every
/// render (colormap, generator) need none.
export function useElementPanel<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
>(
  props: IDockviewPanelProps,
  kind: ProjectElementKind,
  rehydrate?: (config: TConfig) => void,
): ElementPanelState<TConfig> {
  const registry = useElementRegistry();
  const { ensure, update } = registry;
  const { api, params } = props;
  const [elementId] = useState(() => elementIdFromParams(params));
  useEffect(() => {
    ensure(elementId, kind);
  }, [ensure, elementId, kind]);
  /// This panel instance's writer token: what its own registry writes
  /// are stamped with, so the resync below can tell them from everyone
  /// else's. Per *panel*, not per element — two panels onto one element
  /// each follow the other's edits.
  const [writer] = useState(() => crypto.randomUUID());

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
        update(elementId, { config }, writer);
        api.updateParameters({ elementId, ...config });
      } else {
        api.updateParameters({ elementId });
      }
    },
    [api, update, elementId, writer],
  );

  // Resync on an external config write. The epoch says *that* the
  // element's config changed; the origin says who changed it — a bump
  // this panel stamped is the echo of its own persist, and re-applying
  // it would at best be redundant and at worst fight a newer edit.
  const entry = registry.get(elementId);
  const configEpoch = entry?.configEpoch ?? 0;
  const configOrigin = entry?.configOrigin;
  const configRef = useRef<TConfig | undefined>(undefined);
  configRef.current = (entry?.element as { config?: TConfig } | undefined)?.config;
  const rehydrateRef = useRef(rehydrate);
  rehydrateRef.current = rehydrate;
  const seenEpochRef = useRef(configEpoch);
  useEffect(() => {
    if (configEpoch === seenEpochRef.current) return;
    seenEpochRef.current = configEpoch;
    if (configOrigin === writer) return;
    const config = configRef.current;
    if (config !== undefined) rehydrateRef.current?.(config);
  }, [configEpoch, configOrigin, writer]);

  return {
    elementId,
    registry,
    element: entry?.element,
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
/// sinks/replayers with no sources concept, nor colormap / generator,
/// ambient elements not wired through the graph). `["*"]` (every bus) is the
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
    element &&
    element.kind !== "transmit" &&
    element.kind !== "rbs" &&
    element.kind !== "colormap" &&
    element.kind !== "generator"
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
