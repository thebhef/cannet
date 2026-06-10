// The one display-name resolver for project elements (ADR 0019).
// Every view that names an element — the dockview tab, the project
// graph node, the project panel inventory, the go-to-view palette —
// calls `elementLabel`; per-view relabelling is forbidden. The name
// itself is model-owned: `create` assigns a default on creation and
// `assignDefaultNames` backfills elements loaded from a project saved
// before names existed (an additive field — no schema-version bump;
// the host round-trips `elements` opaquely).

import type { ProjectElement, ProjectElementKind } from "./types";

/// Capitalised, user-facing label for an element kind.
export function elementKindLabel(kind: ProjectElementKind): string {
  switch (kind) {
    case "trace":
      return "Trace";
    case "plot":
      return "Plot";
    case "transmit":
      return "Transmit";
    case "filter":
      return "Filter";
    case "rbs":
      return "RBS";
  }
}

/// The display label for an element: its model-owned `name`. The
/// kind + short-id fallback covers an element that slipped past
/// creation/load normalisation — the resolver never returns "".
export function elementLabel(el: ProjectElement): string {
  const name = el.name?.trim() ?? "";
  if (name.length > 0) return name;
  return `${elementKindLabel(el.kind)} ${el.id.slice(0, 6)}`;
}

/// The default name for a freshly created element: `${Kind} ${n}`,
/// where `n` continues past the highest default-style index among
/// `existing` same-kind elements (so deleting "Trace 1" doesn't make
/// the next trace a duplicate "Trace 2"). Renamed elements don't
/// count toward the index.
export function defaultElementName(
  kind: ProjectElementKind,
  existing: readonly Pick<ProjectElement, "kind" | "name">[],
): string {
  const label = elementKindLabel(kind);
  const pattern = new RegExp(`^${label} (\\d+)$`);
  let max = 0;
  for (const el of existing) {
    if (el.kind !== kind) continue;
    const m = el.name != null ? pattern.exec(el.name) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${label} ${max + 1}`;
}

/// Backfill default names onto elements loaded without one (projects
/// saved before names existed, or a `name` dropped as malformed).
/// Elements that already have a name keep it; the empties are
/// numbered in order, per kind, around the existing default-style
/// names. Returns the same array when nothing needed a name.
export function assignDefaultNames(
  elements: readonly ProjectElement[],
): readonly ProjectElement[] {
  if (elements.every((el) => (el.name?.trim() ?? "").length > 0)) {
    return elements;
  }
  const named: ProjectElement[] = [];
  for (const el of elements) {
    named.push(
      (el.name?.trim() ?? "").length > 0
        ? el
        : { ...el, name: defaultElementName(el.kind, named) },
    );
  }
  return named;
}
