/// The plot panel's **solo** model. Pure: no DOM, no React, no uPlot.
///
/// Solo answers "show me only these series" without touching what the
/// user has hidden. It is a **view-layer mask**, composed on top of each
/// series' persisted `hidden` flag: a series draws when it is not hidden
/// *and* (solo is off, or its area has no match, or it is in the visible
/// set). Nothing here writes to a `SignalRef` the panel persists — the
/// non-matches keep their own `hidden` exactly as they were, so clearing
/// solo restores the view the user had.
///
/// The mask is **scoped to the areas that matched**
/// ({@link soloMatchedAreaIds}): an area holding no match renders as if
/// solo were off, so a pattern aimed at one area doesn't blank the rest
/// of the panel and a pattern matching nowhere changes nothing.
///
/// The subject is the series' **canonical signal path** (ADR 0038),
/// `bus/ecu/message/signal`, matched case-sensitively and partially —
/// exactly the dialect an area's `patterns` list speaks, so one regex
/// selects the same signals wherever it is typed. An unanchored pattern
/// still matches a bare name as the path's tail, so `Cell16` keeps
/// working as a quick name filter. An invalid pattern is **inert**:
/// {@link soloRegex} returns `null` rather than throwing, and an inert
/// pattern filters nothing.
///
/// Stepping is **by group, not by row**, and only a pattern that
/// **captures** steps at all ({@link soloPatternPages}). A pattern's
/// capture groups make each match's key ({@link soloGroups}); every
/// signal sharing a key steps as one, so `Cell(\d+)` walks cell indices
/// however many areas they are spread across. A pattern with no
/// captures has no index to page by, so it is a **flat filter**: every
/// match on show at once, in every area that holds one, with no page
/// state and nothing for the step controls to do. Groups are dealt into
/// pages of
/// `solo_page_size` and the control cycles **all → page 1 → … → page N
/// → all** ({@link stepSoloPage}).
///
/// Either kind of pattern can also be narrowed by **ticking a subset**
/// of its items in the match menu ({@link toggleSoloChecked}): the
/// visible set is then the union of what the ticked items cover, and
/// stepping leaves the subset behind to resume the cycle
/// ({@link stepSoloFromSelection}). A page and a subset are the same
/// slot — one displaces the other — and both are only ever
/// *re-interpreted* against an item list re-derived from the live areas
/// on every change, never written back: a page past the end clamps
/// ({@link clampSoloPage}) and a stale tick is dropped
/// ({@link soloSelectedGroups}), instead of blanking the view.

import { signalKey } from "./plotData";
import { signalRefKey, type PlotAreaConfig, type SignalRef } from "./plotPanelConfig";
import { catalogPath, signalPath } from "./signalSelection";
import type { SignalDescriptorRecord } from "./types";

export interface SoloState {
  /// The regex, verbatim as typed. `""` is solo off; an invalid pattern
  /// is kept (so the user can fix it) and is inert until it parses.
  pattern: string;
  /// Which page of groups is on show (0-based), or `null` for the whole
  /// matched set — which is the only value a pattern that doesn't page
  /// ({@link soloPatternPages}) ever has. A page past the end of the
  /// current group list clamps ({@link clampSoloPage}) rather than
  /// blanking the view, so a restored state survives a catalog that has
  /// shrunk.
  page: number | null;
  /// The ticked subset, as {@link SoloGroup.id}s — the third way to pick
  /// what is on show, and mutually exclusive with `page`: ticking an
  /// item drops the page, and stepping drops the subset
  /// ({@link stepSoloFromSelection}). Ids naming groups the pattern no
  /// longer produces are kept here and dropped on the way out
  /// ({@link soloSelectedGroups}), so a restore survives a catalog that
  /// has not arrived; an empty selection is the whole matched set.
  checked: readonly string[];
}

/// Solo off: no pattern, no subset, and the whole set would be on show.
export const SOLO_OFF: SoloState = { pattern: "", page: null, checked: [] };

/// One entry of the match list — a *series in an area*, since the same
/// signal may be plotted in several areas and solo is panel-wide.
export interface SoloMatch {
  areaId: string;
  /// `signalRefKey` of the matched series.
  key: string;
  /// The display name of the matched series — what a row and a menu
  /// entry read as.
  name: string;
  /// The canonical path the pattern matched, kept so a caller can read
  /// the pattern's captures back off the same subject.
  path: string;
  /// The match's capture array, indexed the way `RegExp.exec` returns
  /// it (`[0]` is the whole match). A group the match didn't exercise
  /// is `undefined`. What {@link soloGroups} keys on.
  captures: readonly (string | undefined)[];
}

/// The subject a plotted series presents to a solo pattern: its
/// canonical path (ADR 0038), built from the catalog entry the series
/// refers to. A series the catalog doesn't carry — a stale ref, or one
/// whose DBC is not loaded — keeps the segment positions and renders
/// the segments it can't know as empty, the same rule
/// {@link signalPath} applies to a missing bus or transmitter.
///
/// Returned as a closure over a prebuilt index so a panel resolves the
/// catalog once per catalog change rather than once per keystroke.
export function soloPathResolver(
  catalog: readonly SignalDescriptorRecord[],
  busNames: ReadonlyMap<string, string>,
): (s: SignalRef) => string {
  const paths = new Map<string, string>();
  for (const d of catalog) {
    paths.set(
      signalKey(d.bus_id, d.message_id, d.extended, d.signal_name),
      catalogPath(d, busNames),
    );
  }
  return (s) =>
    paths.get(signalRefKey(s)) ??
    signalPath(
      s.busId == null ? null : busNames.get(s.busId) ?? s.busId,
      null,
      s.messageName,
      s.signalName,
    );
}

/// The pattern as a matcher, or `null` when it is empty (solo off) or
/// invalid (inert). Case-sensitive (JS default, like `resolvePatterns`)
/// and unanchored — a fragment matches. Never throws.
export function soloRegex(pattern: string): RegExp | null {
  if (pattern === "") return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/// Is `pattern` non-empty but unparseable? What the solo box renders its
/// invalid state from.
export function soloPatternInvalid(pattern: string): boolean {
  return pattern !== "" && soloRegex(pattern) == null;
}

/// The match list over the panel's areas, in panel order: areas in stack
/// order, rows in each area's own order. Empty for an empty or invalid
/// pattern. `pathOf` is a {@link soloPathResolver}.
export function soloMatches(
  areas: readonly PlotAreaConfig[],
  pattern: string,
  pathOf: (s: SignalRef) => string,
): SoloMatch[] {
  const re = soloRegex(pattern);
  if (re == null) return [];
  const out: SoloMatch[] = [];
  for (const a of areas) {
    for (const s of a.signals) {
      const path = pathOf(s);
      const m = re.exec(path);
      if (m != null) {
        out.push({ areaId: a.id, key: signalRefKey(s), name: s.signalName, path, captures: m });
      }
    }
  }
  return out;
}

/// One capturing group of a solo pattern, as a component of the group
/// key — see {@link soloKeySlots} for the order they come in.
export interface SoloKeySlot {
  /// 1-based capture index in the compiled regex.
  index: number;
  /// What the component reads as in a label: a named group's name with
  /// any `$N` ordinal suffix stripped, or `null` for a group with no
  /// name left to show (unnamed, or named `$N` outright).
  name: string | null;
}

/// A named group's ordinal override — `(?<cell$2>…)` is key component
/// 2, whatever order it was declared in. JS group names may contain
/// `$` and may not start with a digit, so the suffix is a legal name
/// and needs no escaping.
const KEY_ORDINAL = /^(.*)\$(\d+)$/;

/// The capturing groups a pattern declares, in source order. A scan
/// rather than a compile, because the compiled `RegExp` exposes named
/// groups only as an unordered bag and unnamed ones not at all.
/// Escapes and character classes are skipped, so `\(` and `[(]` are
/// literals; every `(?…)` form other than `(?<name>` is non-capturing
/// and contributes nothing — which is how `(?:…)` opts a group out of
/// the key.
function declaredGroups(source: string): { index: number; name: string | null }[] {
  const out: { index: number; name: string | null }[] = [];
  let count = 0;
  let inClass = false;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i += 1;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (c === "(") {
      if (source[i + 1] !== "?") {
        out.push({ index: ++count, name: null });
        i += 1;
        continue;
      }
      // `(?<name>` captures; `(?<=` / `(?<!` are lookbehind and don't.
      if (source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!") {
        const end = source.indexOf(">", i + 3);
        if (end > 0) {
          out.push({ index: ++count, name: source.slice(i + 3, end) });
          i = end + 1;
          continue;
        }
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/// The pattern's capture groups in **key order**: the ones carrying a
/// `$N` ordinal first, by that ordinal, then the rest in declaration
/// order. So `Cell(?<cell$2>\d+)_Bank(?<bank$1>\d)` keys by bank and
/// then cell, while a pattern with no ordinals keys left to right.
/// Empty for a pattern that captures nothing (or doesn't parse) — which
/// is what makes stepping positional rather than keyed.
export function soloKeySlots(pattern: string): SoloKeySlot[] {
  const re = soloRegex(pattern);
  if (re == null) return [];
  return declaredGroups(re.source)
    .map((g, declared) => {
      const m = g.name == null ? null : KEY_ORDINAL.exec(g.name);
      const name = m ? m[1] : g.name;
      return {
        index: g.index,
        name: name ? name : null,
        ordinal: m ? Number(m[2]) : null,
        declared,
      };
    })
    .sort((a, b) => {
      if ((a.ordinal == null) !== (b.ordinal == null)) return a.ordinal == null ? 1 : -1;
      if (a.ordinal != null && b.ordinal != null && a.ordinal !== b.ordinal) {
        return a.ordinal - b.ordinal;
      }
      return a.declared - b.declared;
    })
    .map(({ index, name }) => ({ index, name }));
}

/// Does this pattern page? Only a pattern that **captures** does: its
/// capture groups key the matches into groups, and the groups deal into
/// pages. A pattern that captures nothing has no index to page by, so
/// it is a **flat filter** — every match on show at once, in every area
/// that holds one — and has no page state and no step sequence at all.
export function soloPatternPages(pattern: string): boolean {
  return soloKeySlots(pattern).length > 0;
}

/// One step of the solo cycle: the matches that share a group key, or —
/// for a pattern that captures nothing — a single match standing alone.
export interface SoloGroup {
  /// Stable identity, independent of where the group sits in the list:
  /// the captured key for a capturing pattern, and the matched series'
  /// own area-and-signal key for a captureless one. A checked subset is
  /// stored as these, never as positions, so it survives a re-derive
  /// that reorders or shortens the list.
  id: string;
  /// The captured components in {@link soloKeySlots} order. Empty for a
  /// positional group.
  key: readonly string[];
  /// How the group reads in the read-out: `cell=07` for a named group,
  /// `"07"` for an unnamed one, the components comma-joined for a
  /// tuple, and the signal's own name for a positional group.
  label: string;
  /// The {@link soloMaskKey}s of every series in the group, in panel
  /// order.
  members: readonly string[];
}

/// Numeric-aware ascending, so `Cell2` sorts before `Cell10`.
const KEY_COLLATOR = new Intl.Collator(undefined, { numeric: true });

function compareKeys(a: readonly string[], b: readonly string[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = KEY_COLLATOR.compare(a[i] ?? "", b[i] ?? "");
    if (c !== 0) return c;
  }
  return 0;
}

function keyLabel(key: readonly string[], slots: readonly SoloKeySlot[]): string {
  return key
    .map((v, i) => {
      const name = slots[i]?.name;
      return name ? `${name}=${v}` : `"${v}"`;
    })
    .join(",");
}

/// The checkable — and, for a capturing pattern, steppable — item list:
/// the matches bucketed by group key, keys ascending (numeric-aware,
/// component by component). A pattern with no capture groups has no key
/// to bucket on, so every match is its own item and the list stays in
/// panel order; those items don't page ({@link soloPatternPages}), they
/// are just what the flat filter shows and what the menu ticks. Pass
/// `areaLabels` to have them read as `Area 2 · Cell1`, so the same
/// signal plotted twice tells apart in a menu.
///
/// A group the match didn't exercise — the arm of an alternation it
/// took another path through — contributes an **empty component**
/// rather than dropping the match: a match that belongs to no group
/// would be unreachable through every page, which is not what "it
/// matched" should mean.
export function soloGroups(
  matches: readonly SoloMatch[],
  slots: readonly SoloKeySlot[],
  areaLabels?: ReadonlyMap<string, string>,
): SoloGroup[] {
  if (slots.length === 0) {
    return matches.map((m) => {
      const key = soloMaskKey(m.areaId, m.key);
      const area = areaLabels?.get(m.areaId);
      return { id: key, key: [], label: area ? `${area} · ${m.name}` : m.name, members: [key] };
    });
  }
  const buckets = new Map<string, { key: string[]; members: string[] }>();
  for (const m of matches) {
    const key = slots.map((s) => m.captures[s.index] ?? "");
    // A JSON tuple, so no captured text can forge a component boundary.
    const id = JSON.stringify(key);
    const bucket = buckets.get(id) ?? { key, members: [] };
    bucket.members.push(soloMaskKey(m.areaId, m.key));
    buckets.set(id, bucket);
  }
  return [...buckets.entries()]
    .sort(([, a], [, b]) => compareKeys(a.key, b.key))
    .map(([id, { key, members }]) => ({ id, key, label: keyLabel(key, slots), members }));
}

/// The areas solo *applies* to: the ones holding at least one match. An
/// area with none is left exactly as solo-off leaves it — no mask, no
/// collapse — so a pattern aimed at one area's signals doesn't blank
/// the rest of the panel, and a pattern matching nowhere touches
/// nothing.
export function soloMatchedAreaIds(matches: readonly SoloMatch[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const m of matches) out.add(m.areaId);
  return out;
}

/// The mask's key for one series in one area — solo is panel-wide, so a
/// signal plotted in two areas is two independently maskable entries.
export function soloMaskKey(areaId: string, key: string): string {
  return `${areaId}\0${key}`;
}

/// How many pages a group list makes at `pageSize` groups per page.
/// Zero when nothing matched — there is then nothing to page through.
export function soloPageCount(groupCount: number, pageSize: number): number {
  if (groupCount === 0) return 0;
  return Math.ceil(groupCount / pageSizeOf(pageSize));
}

/// A page size below one would make an empty page, so one is the floor.
function pageSizeOf(pageSize: number): number {
  return Math.max(1, Math.trunc(pageSize) || 1);
}

/// The page a group sits on.
export function soloPageOfGroup(groupIndex: number, pageSize: number): number {
  return Math.floor(groupIndex / pageSizeOf(pageSize));
}

/// Pull a page index into range. A restored page past the end lands on
/// the last page rather than showing nothing, and any page at all falls
/// back to the whole set when the pattern currently matches nothing —
/// which is what makes a state restored before the catalog arrived
/// harmless.
export function clampSoloPage(page: number | null, pageCount: number): number | null {
  if (page == null || pageCount === 0) return null;
  return Math.min(Math.max(0, Math.trunc(page)), pageCount - 1);
}

/// The groups one page shows.
function pageSlice(
  groups: readonly SoloGroup[],
  page: number,
  pageSize: number,
): SoloGroup[] {
  const size = pageSizeOf(pageSize);
  return groups.slice(page * size, page * size + size);
}

/// The {@link soloMaskKey}s a set of groups covers — what solo leaves
/// visible once the groups on show have been picked.
export function soloMemberKeys(groups: readonly SoloGroup[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const g of groups) for (const m of g.members) out.add(m);
  return out;
}

/// The {@link soloMaskKey}s solo leaves visible: every match while the
/// whole set is on show (`page` is `null`), otherwise the members of
/// that page's groups. A page past the end shows nothing — callers pass
/// a {@link clampSoloPage}d index so that can't happen from a restore.
/// A *checked subset* is the other way to pick groups: see
/// {@link soloSelectedGroups}, whose result goes straight through
/// {@link soloMemberKeys}.
export function soloVisibleKeys(
  groups: readonly SoloGroup[],
  page: number | null,
  pageSize: number,
): ReadonlySet<string> {
  return soloMemberKeys(page == null ? groups : pageSlice(groups, page, pageSize));
}

/// Tick or untick one item of the match menu, by {@link SoloGroup.id}.
/// Returns a new list; the one passed in is left alone.
export function toggleSoloChecked(checked: readonly string[], id: string): string[] {
  return checked.includes(id) ? checked.filter((c) => c !== id) : [...checked, id];
}

/// The checked items that still exist, in the item list's own order
/// (which is the step order, not the order they were ticked in). A
/// stored id naming a group the pattern no longer produces is dropped,
/// and a selection that drops to nothing reads as no selection at all —
/// the whole matched set, exactly as an empty one does.
export function soloSelectedGroups(
  groups: readonly SoloGroup[],
  checked: readonly string[],
): SoloGroup[] {
  if (checked.length === 0) return [];
  const want = new Set(checked);
  return groups.filter((g) => want.has(g.id));
}

const wrap = (i: number, n: number): number => ((i % n) + n) % n;

/// Step around the solo cycle: **all → page 1 → … → page N → all**, in
/// the `delta` direction (+1 next, −1 previous). So PgDn from the whole
/// set opens page 1, PgUp from page 1 goes back to the whole set, and
/// running off either end returns to the whole set rather than wrapping
/// straight onto the far page. `null` throughout when nothing matched.
export function stepSoloPage(
  page: number | null,
  pageCount: number,
  delta: 1 | -1,
): number | null {
  if (pageCount === 0) return null;
  const at = page == null ? 0 : clampSoloPage(page, pageCount)! + 1;
  const next = wrap(at + delta, pageCount + 1);
  return next === 0 ? null : next - 1;
}

/// Where a step lands while a subset is checked: stepping **leaves the
/// subset** and resumes the ordinary cycle from where the selection
/// sat — forward opens the page after the page of the *last* checked
/// group, backward the page before the *first*. Running off either end
/// lands on the whole set, like every other step. A selection with
/// nothing live left in it steps to the whole set too.
export function stepSoloFromSelection(
  groups: readonly SoloGroup[],
  checked: readonly string[],
  pageSize: number,
  delta: 1 | -1,
): number | null {
  const pageCount = soloPageCount(groups.length, pageSize);
  if (pageCount === 0) return null;
  const want = new Set(checked);
  const at: number[] = [];
  groups.forEach((g, i) => {
    if (want.has(g.id)) at.push(i);
  });
  if (at.length === 0) return null;
  const from = delta === 1 ? at[at.length - 1] : at[0];
  return stepSoloPage(soloPageOfGroup(from, pageSize), pageCount, delta);
}

/// The solo control's read-out, always in one unambiguous form:
///
/// - `no matches` — the pattern selected nothing, so nothing is masked.
/// - `all (96)` — the whole matched set is on show (which is the only
///   form a captureless pattern's flat filter ever takes).
/// - `2/12 · cell=07 (16 of 96)` — page 2 of 12, showing the one group
///   `cell=07`, which is 16 of the 96 matches. A page spanning several
///   groups reads as the range it covers (`1/2 · "0"–"4" (40 of 96)`).
/// - `2 groups · cell=03, cell=07 (12 of 96)` — a checked subset
///   ({@link soloSelectedGroups}), listed while it is short enough to
///   read and collapsed to `4 groups (12 of 96)` past two. A
///   captureless pattern's items are counted in `signals`, since it has
///   no groups.
export function soloLabel(
  groups: readonly SoloGroup[],
  page: number | null,
  pageSize: number,
  matchCount: number,
  selected: readonly SoloGroup[] = [],
): string {
  if (matchCount === 0 || groups.length === 0) return "no matches";
  if (selected.length > 0) {
    const visible = selected.reduce((n, g) => n + g.members.length, 0);
    const noun = selected[0].key.length === 0 ? "signal" : "group";
    const count = `${selected.length} ${noun}${selected.length === 1 ? "" : "s"}`;
    const listed = selected.length <= 2 ? ` · ${selected.map((g) => g.label).join(", ")}` : "";
    return `${count}${listed} (${visible} of ${matchCount})`;
  }
  if (page == null) return `all (${matchCount})`;
  const pageCount = soloPageCount(groups.length, pageSize);
  const at = clampSoloPage(page, pageCount)!;
  const shown = pageSlice(groups, at, pageSize);
  const visible = shown.reduce((n, g) => n + g.members.length, 0);
  const keys =
    shown.length === 1
      ? shown[0].label
      : `${shown[0].label}–${shown[shown.length - 1].label}`;
  return `${at + 1}/${pageCount} · ${keys} (${visible} of ${matchCount})`;
}

/// Apply the mask to one area's (or derived axis's) series: a series
/// outside `visible` reads as hidden. Returns `signals` itself when
/// nothing is masked, so an untouched axis keeps its array identity.
export function soloMaskSignals(
  areaId: string,
  signals: readonly SignalRef[],
  visible: ReadonlySet<string>,
): SignalRef[] {
  let masked = false;
  const out = signals.map((s) => {
    if (visible.has(soloMaskKey(areaId, signalRefKey(s)))) return s;
    masked = true;
    return s.hidden ? s : { ...s, hidden: true };
  });
  return masked ? out : (signals as SignalRef[]);
}

/// The series solo's mask actually took off the view: not in `visible`,
/// *and* not already hidden on its own — a signal the user had hidden
/// before solo was typed isn't solo's doing, so it's left out. This is
/// the view-feedback question ("which rows does *solo* explain?"), a
/// narrower one than {@link soloMaskSignals}'s ("what draws?"), so it's
/// its own pass rather than a byproduct of that one.
export function soloMaskedKeys(
  areaId: string,
  signals: readonly SignalRef[],
  visible: ReadonlySet<string>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const s of signals) {
    if (s.hidden) continue;
    if (!visible.has(soloMaskKey(areaId, signalRefKey(s)))) out.add(signalRefKey(s));
  }
  return out;
}

/// Parse the persisted `solo` blob. Anything unrecognised reads as solo
/// off, and junk is dropped rather than rejecting the blob (same
/// tolerance as the rest of the panel's parsers): a non-integer page, a
/// `checked` that isn't a list of strings, the non-string entries of one
/// that is. A page stored against a pattern that doesn't page
/// ({@link soloPatternPages}) names nothing, so it drops too and the
/// pattern reads as the flat filter it is; a subset wins over a page,
/// since the two forms are exclusive. A blob written before solo paged
/// carried raw match indices; those index a list that no longer exists,
/// so the pattern is kept and the whole set is shown.
export function soloFromRaw(raw: unknown): SoloState {
  if (typeof raw !== "object" || raw === null) return SOLO_OFF;
  const o = raw as Record<string, unknown>;
  const pattern = typeof o.pattern === "string" ? o.pattern : "";
  if (pattern === "") return SOLO_OFF;
  const checked = Array.isArray(o.checked)
    ? [...new Set(o.checked.filter((c): c is string => typeof c === "string"))]
    : [];
  if (checked.length > 0) return { pattern, page: null, checked };
  const page =
    typeof o.page === "number" &&
    Number.isInteger(o.page) &&
    o.page >= 0 &&
    soloPatternPages(pattern)
      ? o.page
      : null;
  return { pattern, page, checked };
}

/// The sparse persisted shape, in one of three mutually exclusive
/// forms: `undefined` while solo is off (so the key is absent from the
/// panel blob), `{pattern, checked}` while a subset is ticked,
/// `{pattern, page}` while a page of a capturing pattern is on show, and
/// the pattern alone for the whole matched set.
export function soloToParams(
  state: SoloState,
): { pattern: string; page?: number; checked?: string[] } | undefined {
  if (state.pattern === "") return undefined;
  if (state.checked.length > 0) return { pattern: state.pattern, checked: [...state.checked] };
  return state.page == null ? { pattern: state.pattern } : { pattern: state.pattern, page: state.page };
}
