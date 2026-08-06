/// The gridview's opt-in filter slot (ADR 0044): a shared search-box
/// affordance plus one fzf-over-client-rows implementation — query →
/// matching rows and their ancestors, with the ancestors treated as
/// expanded so a match is visible without the user unfolding the path to
/// it.
///
/// **Only for views that hold their whole row space client-side** (the
/// DBC tree, the RBS tree, the transmit list). A host-paged view holds
/// one page of the row space; fuzzy-filtering it in JS would need the
/// whole dataset in frontend state, which the paged-model rule forbids —
/// those views keep their host-side narrowing.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Fzf } from "fzf";

import { diagCount } from "./diag";

/// One searchable node: its row id, the ids of the rows on the path to
/// it, and the single string fzf matches against. Panels build the
/// haystack from whatever text a query should hit — names, ids,
/// comments, units, value-table labels, attributes — joined with spaces.
export interface GridviewFilterEntry {
  id: string;
  ancestors: readonly string[];
  haystack: string;
}

/// Score floor, as a fraction of the best match's score. fzf accepts any
/// subsequence, so on a large tree a query like "pressure" also
/// "matches" text where the letters merely appear scattered across word
/// boundaries — and unlike a ranked list, a tree shows every member of
/// the match set with equal prominence. fzf scores contiguous,
/// boundary-aligned matches far above scattered ones, so a relative
/// floor keeps the real matches — including abbreviation queries, whose
/// score spread is narrow — and drops the noise.
export const MIN_RELATIVE_SCORE = 0.7;

/// How long the filter input settles before the rows re-filter. Short
/// enough to feel immediate, long enough that a burst of keystrokes
/// costs one match-and-rebuild instead of one per character.
export const FILTER_DEBOUNCE_MS = 150;

/// A memoised fzf matcher over one row set, built on first use.
///
/// Neither half is cheap at scale and neither is needed until the user
/// actually types: the entry list allocates one haystack string per
/// searchable node (tens of thousands on a large DBC set) and `Fzf`'s
/// constructor preprocesses every one of them. Building it eagerly means
/// opening a project pays for a search nobody asked for; building it per
/// keystroke means paying again on every character. This does neither —
/// one build on the first non-empty query, reused until the rows change.
export type GridviewMatcher = () => Fzf<readonly GridviewFilterEntry[]>;

export function lazyGridviewMatcher(
  buildEntries: () => GridviewFilterEntry[],
): GridviewMatcher {
  let fzf: Fzf<readonly GridviewFilterEntry[]> | null = null;
  return () => {
    if (fzf === null) {
      diagCount("gridview.filterIndexBuild"); // DIAG
      fzf = new Fzf<readonly GridviewFilterEntry[]>(buildEntries(), {
        selector: (e) => e.haystack,
        casing: "case-insensitive",
      });
    }
    return fzf;
  };
}

export interface GridviewFilterMatches {
  /// The rows the query matched.
  matchSet: ReadonlySet<string>;
  /// Every row on a path to a match — what the panel renders as
  /// structure and treats as expanded.
  ancestorsOfMatches: ReadonlySet<string>;
}

const NO_MATCHES: GridviewFilterMatches = {
  matchSet: new Set(),
  ancestorsOfMatches: new Set(),
};

/// Run `query` through `matcher`. An empty query short-circuits to empty
/// sets without ever forcing the matcher, so a panel that is never
/// searched never builds an index.
export function gridviewMatches(
  matcher: GridviewMatcher,
  query: string,
): GridviewFilterMatches {
  if (query.trim() === "") return NO_MATCHES;
  const matchSet = new Set<string>();
  const ancestorsOfMatches = new Set<string>();
  const results = matcher().find(query.trim());
  const floor = (results[0]?.score ?? 0) * MIN_RELATIVE_SCORE;
  for (const res of results) {
    // Results arrive score-descending; everything past the floor is
    // scattered-subsequence noise.
    if (res.score < floor) break;
    matchSet.add(res.item.id);
    for (const a of res.item.ancestors) ancestorsOfMatches.add(a);
  }
  return { matchSet, ancestorsOfMatches };
}

export interface GridviewFilter extends GridviewFilterMatches {
  /// What the search box shows — updates on every keystroke.
  input: string;
  setInput: (value: string) => void;
  /// The settled query the matches were computed from.
  query: string;
  /// Is the filter narrowing anything? Panels gate their structural
  /// hiding on this rather than on `matchSet.size`, so a query that
  /// matches nothing hides everything instead of showing everything.
  active: boolean;
  /// The panel's own expansion set with every ancestor of a match folded
  /// in, so a match is visible without the user unfolding the path.
  /// Returns the argument unchanged while the filter is inactive.
  effectiveExpanded: (expanded: ReadonlySet<string>) => ReadonlySet<string>;
}

/// Wire a panel's rows to the filter slot. `buildEntries` must be
/// memoised by the caller — it identifies the row set, so a fresh
/// closure per render would rebuild the index on every render.
export function useGridviewFilter(
  buildEntries: () => GridviewFilterEntry[],
  initialQuery = "",
): GridviewFilter {
  const [input, setInput] = useState(initialQuery);
  // The query the rows are filtered by, trailing the box by
  // [`FILTER_DEBOUNCE_MS`]. Typing re-renders only the `<input>`; the
  // matcher run and the whole-tree rebuild behind it happen once the
  // user pauses, not once per keystroke.
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(input), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [input]);

  const matcher = useMemo(() => lazyGridviewMatcher(buildEntries), [buildEntries]);
  const { matchSet, ancestorsOfMatches } = useMemo(
    () => gridviewMatches(matcher, query),
    [matcher, query],
  );
  const active = query.trim() !== "";

  const effectiveExpanded = useCallback(
    (expanded: ReadonlySet<string>): ReadonlySet<string> => {
      if (!active) return expanded;
      const merged = new Set(expanded);
      for (const a of ancestorsOfMatches) merged.add(a);
      return merged;
    },
    [active, ancestorsOfMatches],
  );

  return { input, setInput, query, active, matchSet, ancestorsOfMatches, effectiveExpanded };
}

interface GridviewFilterBoxProps {
  filter: GridviewFilter;
  /// The panel's own class on the input — the slot is shared behaviour,
  /// not a shared look.
  className?: string;
  placeholder?: string;
  ariaLabel: string;
  /// `search` renders the platform clear affordance; `text` doesn't.
  inputType?: "search" | "text";
  /// When set, a live match count renders after the box while the filter
  /// is active, carrying this class. Omitted ⇒ no count (the panels that
  /// never showed one keep their toolbar as it was).
  matchCountClassName?: string;
}

/// The shared search box. Rendered wherever the panel's own toolbar
/// wants it — the slot supplies the behaviour, the panel the placement.
export function GridviewFilterBox({
  filter,
  className,
  placeholder,
  ariaLabel,
  inputType = "search",
  matchCountClassName,
}: GridviewFilterBoxProps) {
  return (
    <>
      <input
        type={inputType}
        className={className}
        placeholder={placeholder}
        value={filter.input}
        onChange={(e) => filter.setInput(e.target.value)}
        aria-label={ariaLabel}
      />
      {matchCountClassName && filter.active && (
        <span className={matchCountClassName} aria-live="polite">
          {filter.matchSet.size} match{filter.matchSet.size === 1 ? "" : "es"}
        </span>
      )}
    </>
  );
}
