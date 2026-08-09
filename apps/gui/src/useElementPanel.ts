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
  /// config arrive through {@link useElementRehydrate} instead, not by
  /// this value changing.
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
  /// This panel instance's opaque writer token: what `persist` stamps
  /// its registry writes with, so {@link useElementRehydrate} can tell
  /// this panel's own echo from an edit made anywhere else. Per
  /// *panel*, not per element — two panels onto one element would each
  /// follow the other's edits.
  writer: string;
}

/// Element id resolution + registry `ensure` + `config` hydration +
/// dual-write persist — the lifecycle boilerplate shared by every
/// element-backed panel (trace, plot, signals, transmit, rbs, …). See
/// {@link useElementRehydrate} for the resync half, and
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

  return {
    elementId,
    registry,
    element: registry.get(elementId)?.element,
    savedConfig,
    persist,
    writer,
  };
}

/// Resync a panel's view state when its element's config is rewritten
/// from outside it. This closes the loop the mount-time `savedConfig`
/// read leaves open: a panel is otherwise a write-only mirror of its
/// element, so a config changed by anyone else (a rewire, and in time a
/// restored one) would simply be overwritten by the panel's next
/// persist.
///
/// `apply` pushes a stored config into the panel's view state — the same
/// fields it seeds from `savedConfig` at mount — so call this *after*
/// declaring that state. It runs on every change to the element's config
/// except the ones this panel itself persisted: the entry's epoch says
/// *that* the config changed, its origin says who changed it, and
/// re-applying a panel's own echo would at best be redundant and at
/// worst fight a newer edit. Panels whose element carries no `config`
/// (transmit, rbs) and panels that read the element live every render
/// (colormap, generator) need none of this.
export function useElementRehydrate<TConfig>(
  panel: ElementPanelState<TConfig>,
  apply: (config: TConfig) => void,
): void {
  const { registry, elementId, writer } = panel;
  const entry = registry.get(elementId);
  const configEpoch = entry?.configEpoch ?? 0;
  const configOrigin = entry?.configOrigin;
  // Read through refs: the effect must fire on the epoch alone, not on
  // the identity of a config blob or of a callback rebuilt each render.
  const configRef = useRef<TConfig | undefined>(undefined);
  configRef.current = (entry?.element as { config?: TConfig } | undefined)?.config;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const seenEpochRef = useRef(configEpoch);
  useEffect(() => {
    if (configEpoch === seenEpochRef.current) return;
    seenEpochRef.current = configEpoch;
    if (configOrigin === writer) return;
    const config = configRef.current;
    if (config !== undefined) applyRef.current(config);
  }, [configEpoch, configOrigin, writer]);
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
