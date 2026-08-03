// The settings schema, as the host serves it (ADR 0034), plus the pure
// view logic the settings panel renders it through.
//
// Nothing about a setting is written down here: the label, help text,
// control shape, tags, scope, and default all arrive from the host's
// `get_setting_descriptors`, which builds them from the `Settings`
// struct's own scope table and defaults. This module only types that
// answer and turns it into what a view needs — a search index, a group
// list, and a match order.
//
// The matcher is `fzf`, the same one the command palette and the DBC
// panel use, with the same relative score floor the DBC panel applies —
// fzf accepts any subsequence, and over help text a query like "cadence"
// "matches" any setting whose prose happens to contain those letters in
// order. The floor is relative to the best score *for that query*, so a
// setting found only through its help text still survives: it is the top
// result for the query that found it.

import { invoke } from "@tauri-apps/api/core";
import { Fzf } from "fzf";

/// Which part of the app a setting governs — the host's `Surface`, in
/// its serialized (kebab-case) form. The tree groups by it.
export type SurfaceId = string;

/// What sort of decision a setting is — the host's `Kind`. Exactly one
/// per setting.
export type SettingKind = "default" | "behaviour" | "developer";

/// Where a write of the setting lands (ADR 0042 §3) — the host's
/// `Scope`, which the descriptor reads from the store's scope table
/// rather than restating.
export type SettingScope = "user" | "user-overridable" | "workspace";

/// The control a setting's row renders, generated from its `type`. The
/// one hand-written case is `custom`, whose `renderer` the view
/// dispatches through a single table.
export type SettingControl =
  | { type: "bool" }
  | { type: "enum"; options: string[] }
  | {
      type: "int";
      unit: string | null;
      /// Stored value = displayed value × `scale`, so a byte count is
      /// edited in MB without the file's units changing.
      scale: number;
      /// In *stored* units, and the same limit the host enforces.
      min: number | null;
      /// Placeholder for an empty box. Present only when blank is a
      /// legal value (the field is optional on the host).
      unset: string | null;
    }
  | { type: "number"; unit: string | null; min: number | null }
  | { type: "text"; placeholder: string | null }
  | { type: "custom"; renderer: string };

/// What a row is *about*: a field of `settings.json`, or a management
/// surface the settings view hosts (the project cache list, ADR 0042 §5).
/// A `view` row has no stored value, so it shows no key, no scope, no
/// default, and nothing to reset.
export type SettingBacking = "field" | "view";

export interface SettingDescriptor {
  /// The `settings.json` field name. Shown, so the panel teaches the
  /// file. For a `view` row it is an id for search and dispatch, not a
  /// field, and is not shown.
  key: string;
  label: string;
  help: string;
  surfaces: SurfaceId[];
  kind: SettingKind;
  control: SettingControl;
  backing: SettingBacking;
  scope: SettingScope | null;
  /// The value `Settings::default()` gives this key — what "differs from
  /// its default" is measured against.
  default: unknown;
}

export interface SurfaceInfo {
  id: SurfaceId;
  label: string;
}

export interface SettingsSchema {
  /// Every surface, in tree order, with its label.
  surfaces: SurfaceInfo[];
  settings: SettingDescriptor[];
}

export const EMPTY_SCHEMA: SettingsSchema = { surfaces: [], settings: [] };

/// The tree group `developer`-tagged settings collect into. They form
/// their own group rather than appearing under their surface, so
/// revealing them adds one group instead of mutating every group.
export const DEVELOPER_GROUP = "developer";

/// Load the settings schema. Tolerant of no host (unit tests, a failed
/// command): an empty schema renders an empty panel rather than throwing.
export async function loadSettingDescriptors(): Promise<SettingsSchema> {
  try {
    const schema = await invoke<Partial<SettingsSchema> | null>("get_setting_descriptors");
    return {
      surfaces: schema?.surfaces ?? [],
      settings: schema?.settings ?? [],
    };
  } catch {
    return EMPTY_SCHEMA;
  }
}

/// The settings keys the open project's `.cannet/settings.json`
/// declares — the ones whose effective value came from the project
/// rather than the user's own file.
export async function loadSettingsOverrides(): Promise<string[]> {
  try {
    return (await invoke<string[] | null>("get_settings_overrides")) ?? [];
  } catch {
    return [];
  }
}

/// The tree groups a setting belongs to. A `developer` setting belongs
/// to the developer group *only* — that is what keeps `Plot` from
/// silently growing a fetch-cadence row when the toggle is flipped.
export function groupIdsOf(descriptor: SettingDescriptor): SurfaceId[] {
  return descriptor.kind === "developer" ? [DEVELOPER_GROUP] : descriptor.surfaces;
}

/// The tree's groups, in order: every surface, plus the developer group
/// when the user has opted into seeing it.
export function settingGroups(
  schema: SettingsSchema,
  showDeveloper: boolean,
): SurfaceInfo[] {
  const groups = [...schema.surfaces];
  if (showDeveloper) groups.push({ id: DEVELOPER_GROUP, label: "Developer" });
  return groups;
}

/// The text a query is matched against: label, key, help, and both tag
/// axes. Matching help text is what lets a user find a setting they
/// cannot name; matching tags is what makes "developer" or "storage" a
/// query.
export function settingHaystack(
  descriptor: SettingDescriptor,
  surfaceLabels: ReadonlyMap<SurfaceId, string>,
): string {
  const tags = descriptor.surfaces
    .map((s) => `${s} ${surfaceLabels.get(s) ?? ""}`)
    .join(" ");
  return `${descriptor.label} ${descriptor.key} ${descriptor.help} ${tags} ${descriptor.kind}`;
}

interface SearchEntry {
  descriptor: SettingDescriptor;
  haystack: string;
}

/// Score floor, as a fraction of the best match's score — the same rule
/// and the same number the DBC panel's tree filter uses. Everything
/// below it is scattered-subsequence noise.
const MIN_RELATIVE_SCORE = 0.7;

/// A matcher over one schema: an empty query yields the schema's own
/// order, anything else yields `fzf`'s ranking. Build it once per schema
/// — `Fzf`'s constructor preprocesses every haystack.
export function settingsMatcher(
  schema: SettingsSchema,
): (query: string) => SettingDescriptor[] {
  const labels = new Map(schema.surfaces.map((s) => [s.id, s.label]));
  const entries: SearchEntry[] = schema.settings.map((descriptor) => ({
    descriptor,
    haystack: settingHaystack(descriptor, labels),
  }));
  const fzf = new Fzf<readonly SearchEntry[]>(entries, {
    selector: (e) => e.haystack,
    casing: "case-insensitive",
  });
  return (query: string) => {
    if (query.trim() === "") return schema.settings;
    const results = fzf.find(query);
    const floor = (results[0]?.score ?? 0) * MIN_RELATIVE_SCORE;
    // Results arrive score-descending.
    return results.filter((r) => r.score >= floor).map((r) => r.item.descriptor);
  };
}

/// Narrow a match list to what the panel shows: developer settings only
/// when the user has opted in, and only the selected group when one is
/// selected.
///
/// **Nothing about what is hidden is surfaced.** A hidden setting is
/// absent, not counted, not announced — the toggle that reveals it is
/// itself one searchable row away.
export function visibleSettings(
  matched: readonly SettingDescriptor[],
  showDeveloper: boolean,
  group: SurfaceId | null,
): SettingDescriptor[] {
  return matched.filter((d) => {
    if (d.kind === "developer" && !showDeveloper) return false;
    return group === null || groupIdsOf(d).includes(group);
  });
}

/// How many of `visible` fall in each group. Drives the tree's counts.
export function countsByGroup(
  visible: readonly SettingDescriptor[],
): Map<SurfaceId, number> {
  const counts = new Map<SurfaceId, number>();
  for (const d of visible) {
    for (const g of groupIdsOf(d)) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

/// Whether `value` is the descriptor's default. Settings values are JSON
/// scalars, `null`, or lists of them, so a structural comparison is
/// exact here.
export function isDefaultValue(descriptor: SettingDescriptor, value: unknown): boolean {
  return JSON.stringify(value ?? null) === JSON.stringify(descriptor.default ?? null);
}

/// A setting's value as prose, for the "differs from default" line.
/// Generated from the control, like everything else.
export function formatSettingValue(
  descriptor: SettingDescriptor,
  value: unknown,
): string {
  const control = descriptor.control;
  if (value === null || value === undefined) {
    return control.type === "int" && control.unset !== null ? control.unset : "unset";
  }
  switch (control.type) {
    case "bool":
      return value ? "enabled" : "disabled";
    case "int":
      return `${Number(value) / control.scale}${control.unit === null ? "" : ` ${control.unit}`}`;
    case "number":
      return `${String(value)}${control.unit === null ? "" : ` ${control.unit}`}`;
    default:
      return String(value);
  }
}
