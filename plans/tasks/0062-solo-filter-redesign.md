# Task 62 — Solo Filter Redesign

Opened 2026-08-09 from owner feedback on live use ("I don't really
get visibility on what indices are produced or which ones are showed…
I would like things that don't match the regex at all to not be
solo'd / for it only to apply to the areas with matches"), after a
semantics map of the current implementation (2026-08-09) confirmed
the behaviors behind each symptom. Groomed to completion 2026-08-09;
slotted first in the roadmap by owner directive 2026-08-09
("implement 0062").

## Current semantics (mapped 2026-08-09)

- One solo per panel (`SoloState` in `plotSolo.ts`), matching the
  **bare signal name only**, case-insensitive — while area patterns
  match the full `bus/ecu/message/signal` path case-sensitively (two
  regex dialects in one panel).
- Solo masks **panel-wide**: a zero-match area is force-hidden
  entirely and collapses (`collapsedBySolo`); a zero-match pattern
  blanks the whole panel (currently pinned by a dom test as
  intended).
- Stepping is a single-match cursor over one flat panel-wide match
  list — no pages, no "all" re-entry: from `1/3`, PgUp wraps to the
  last match. The all-visible label (`3`) vs last-match label (`3/3`)
  is ambiguous by the module's own doc comment. Escape/× clears the
  pattern entirely.
- Feedback: one toolbar counter + a right-click-only match menu; a
  solo-hidden row styles identically to a user-hidden row.
- `solo_page_size` setting (default 1) added 2026-08-09 as a stopgap
  stepper knob; this redesign gives it its real meaning (groups per
  page).

## The groomed design (owner rulings 2026-08-09)

### 1. Scope — zero-match areas are untouched

Solo applies only to areas with at least one match; an area with
none renders exactly as if solo were off — no masking, no collapse.
A pattern matching nothing anywhere therefore touches nothing (the
dom pin asserting today's blank-panel behavior flips deliberately).

### 2. Match subject — the pattern dialect, exactly

Solo matches the full `bus/ecu/message/signal` path, case-sensitive
— identical to the area-pattern regex dialect. One regex language in
the panel. Unanchored regexes still match bare names as the path's
tail, so quick name filters keep working. (Rejected: bare-name-only
(today), and a case-insensitive hybrid.)

### 3. Stepping — group-by-capture, paged, with All in the cycle

- **Group key**: if the regex has capture groups, each match's key
  is the captured text; distinct keys form the step sequence. One
  step highlights every signal sharing the key, across all areas
  (`Cell(\d+)` steps by cell index). No capture group → each matched
  signal is its own group (positional stepping).
- **Key ordering**: numeric-aware ascending per component (Cell2
  before Cell10). Multi-group keys are tuples; priority is
  declaration order, overridable by a `$N` ordinal suffix in a named
  group's name — `Cell(?<cell$2>\d+)_Bank(?<bank$1>\d)` makes bank
  primary. The suffix is stripped for display; ordinal-less groups
  follow the ordinal-carrying ones in declaration order; `(?:…)`
  opts a group out of the key. (Identifier note: JS group names
  cannot start with a digit but may contain `$`.)
- **Pages**: a page is `solo_page_size` consecutive groups (default
  1). With `Cell0*(\d+)` and page size 5, page 1 = cells 0–4, page 2
  = cells 5–9 — the range-bucketing the owner attempted with
  `Cell0*([0-4]||5-9])` falls out with no special regex.
- **Cycle**: All → page 1 → … → page N → All. PgDn from All → page
  1; PgUp from page 1 → All; wrapping past the last page returns to
  All. **Entering or modifying the pattern lands on page 1** (owner
  detail). Escape/× keeps clearing the pattern entirely; ‹ › follow
  the same cycle.
- **Labels**: always two-form and unambiguous — `all (96)` vs
  `2/12 · cell=07 (16 of 96)` (named), `2/12 · "07" (…)` (unnamed),
  ranges as `1/2 · "0"–"4" (40 of 96)`. The bare-number form dies.

### 4. Visibility feedback (all four approved)

1. Solo-masked rows styled distinctly from user-hidden rows (a solo
   marker, not the plain hidden treatment).
2. A per-area match chip while solo is active (`3 of 12 match`);
   zero-match areas show nothing — they are untouched.
3. The toolbar readout is the aggregate two-form label, with an
   explicit `no matches` state.
4. Left-click on the position label opens the match menu
   (right-click stays).

### Design consequences (recorded, not separately asked)

- Restored solo state against a catalog that has not yet populated
  pattern rows is no longer a blank-panel hazard (zero matches →
  untouched panel); a restored page index past the end clamps to the
  last page.
- Persisted solo state becomes `{pattern, page}` (a page of group
  keys, not raw match indices).

### Addendum — owner rulings 2026-08-09 (grooming for phase 62.D)

Three owner statements, in the order they were made; the later ones
supersede the earlier where they conflict.

1. **The match menu becomes checkable.** Verbatim: *"the solo menu that
   expands showing the selection; you should be able to check/uncheck
   menu items there"*. The design put to the owner and approved with
   *"that's fine for now"*:

   - Menu items are checkable; clicking one **toggles** it (replacing
     62.A's click-jumps-to-the-page), and the menu stays open while
     ticking.
   - Selection is **group-keyed** — the identity of an item is its
     group key tuple (or, for a pattern with no captures, the match's
     own stable identity), never a position in a list.
   - While a subset is checked, the visible set is the union of the
     checked items' members; masking, the per-area chip and the
     zero-match-untouched rule all follow from the visible set.
   - **Stepping leaves the subset** and resumes the
     all → page 1 → … → page N → all cycle: forward goes to the page
     *after* the page of the **last** checked group, backward to the
     page *before* the **first** checked group.
   - Persisted as `{pattern, checked}`.
   - Entering or modifying the pattern still lands a capturing pattern
     on page 1 (and clears any selection).

2. **The captureless pattern is applied like the capturing one, per
   plot area.** Verbatim: *"the captureless one should be applied the
   same way; it should be applied per plot area"*. This superseded
   62.C's open question (whether a captureless pattern should land on
   All rather than page 1).

3. **…and then: a captureless pattern has no pages at all.** Verbatim:
   *"the captureless version should have no pages, at least
   conceptually; it's just whatever matches in every signal panel, all
   at once. There's nothing to page since there's no index captured"* …
   *"but retains the detail that if there are no matches in a signal
   panel, that panel is left alone."* This refines — and supersedes —
   statement 2's per-area reading: a captureless pattern is a **flat
   filter**, not a paged view applied per area.

**What this supersedes.** §3's sentence *"No capture group → each
matched signal is its own group (positional stepping)"* is dead: a
captureless pattern has no step sequence and no pages, so every match
is on show at once, masked per matching area, with zero-match areas
untouched exactly as §1 rules. It also closes 62.C's open landing
question — dead rather than answered, because a captureless pattern has
no landing state to choose. Capturing patterns are unchanged: cross-area
key groups, pages, the All-cycle, and enter-lands-on-page-1 all stand.

## Exit criteria

- Zero-match areas render untouched under an active solo (dom-tested
  both ways: matching area masked, zero-match area identical to
  solo-off); a zero-match pattern touches nothing and the toolbar
  shows `no matches`.
- Solo and area patterns share one regex dialect (path,
  case-sensitive), pinned by a test that runs the same regex through
  both.
- Group-by-capture stepping: keyed grouping, numeric-aware ordering,
  `$N` ordinal override, `(?:…)` opt-out, tuple keys — each
  pure-function tested; paging honors `solo_page_size`; the
  All-cycle and enter-lands-on-page-1 rules dom-tested.
- The four feedback surfaces land (distinct solo styling, per-area
  chip, two-form/no-matches readout, click-to-open match menu),
  dom-tested.
- Stale-restore behavior: page past end clamps; pre-catalog restore
  leaves the panel untouched until matches exist (dom-tested).
- Docs updated where solo behavior is described; ADR only if a
  boundary proves hard-to-reverse (grouping semantics are view-local
  and revisable — default is no new ADR).

## Status log

### 2026-08-09 — phase 62.A (branch `task62a-solo-groups`)

The whole new solo model — dialect, scope, grouping, paging, labels,
persistence — plus its panel wiring. The four feedback surfaces
(distinct solo-row styling, per-area chip, upgraded toolbar surfaces,
left-click menu) are 62.B and are **not** in this phase; the existing
toolbar read-out was kept working by feeding it the new label text.

Five commits, each green on `pnpm --dir apps/gui test` +
`pnpm --dir apps/gui build`:

| commit | subject |
| --- | --- |
| `6f59669` | `docs(task62): open the solo-filter redesign — groomed design + roadmap slot` |
| `653fc16` | `feat(gui): give solo the area patterns' regex dialect` |
| `f8c8ced` | `feat(gui): scope the solo mask to the areas that matched` |
| `5c9f3e7` | `feat(gui): group a solo pattern's matches by what it captures` |
| `55b1f89` | `feat(gui): page the solo groups, with the whole set in the cycle` |
| `464983b` | `docs(gui): describe the solo view as it now behaves` |

Final gates: frontend **142 files / 1836 tests** passing (1809 at the
phase's start, +27), `pnpm build` clean; `cargo test -p cannet-gui`
531 passing and `cargo clippy -p cannet-gui --all-targets` clean (the
`solo_page_size` label/help/rustdoc changed, which is host code).

What landed, against the groomed design:

1. **One dialect** (§2). `soloRegex` dropped its `i` flag; the subject
   is the ADR-0038 canonical path built by a new `soloPathResolver`,
   which indexes the same `scopedCatalog` / `busNameLookup` the area
   patterns resolve through and reuses `catalogPath` / `signalPath`.
   A series the catalog doesn't carry falls back to
   `signalPath(busName, null, messageName, signalName)` — the ecu, the
   one segment only the catalog knows, goes blank; the rest keeps its
   position. Pinned by a test that runs four patterns through both
   `soloMatches` and `resolvePatterns` and asserts the same selection.
2. **Scope** (§1). `soloMatchedAreaIds`; the panel hands an unmatched
   area the same `null` mask solo-off gives it, so it is untouched
   *and* stays off the re-derive.
3. **Grouping** (§3). `soloKeySlots` scans the pattern source (escape-
   and character-class-aware) for declared capture groups, because a
   compiled `RegExp` exposes named groups only as an unordered bag and
   unnamed ones not at all. `$N` suffixes reorder and are stripped for
   display; ordinal-less groups follow in declaration order; `(?:…)`
   contributes nothing and so opts out. `soloGroups` buckets matches by
   the captured tuple, ordered by `Intl.Collator({numeric:true})` per
   component.
4. **Pages and the cycle** (§3). `soloPageCount` / `clampSoloPage` /
   `stepSoloPage` / `soloPageOfGroup`; the cycle is a ring of
   `pageCount + 1` positions with the whole set at 0, so PgUp from the
   whole set lands on the last page by the same rule that takes PgDn to
   page 1. `solo_page_size` is now read on render (it sizes a page, not
   just a keystroke) instead of at press time.
5. **Labels** (§3). `soloLabel` — `no matches` / `all (96)` /
   `2/12 · cell=07 (16 of 96)`, with a multi-group page reading as
   `1/2 · "0"–"4" (40 of 96)`. The bare-number form is gone.
6. **Persistence.** `{pattern, page}`; the page is only ever
   *re-interpreted* (clamped) at render, never written back, which is
   what makes a restore against an unpopulated catalog harmless.
   Solo rides inside the plot element's `config`, which
   `elementHistory.UNDOABLE_FIELDS` already covers wholesale — no
   field-shape change was needed there.

Decisions taken inside the groomed design (none of them a divergence):

- **Undefined capture** (design left the treatment open): a group the
  match didn't exercise contributes an **empty component** rather than
  dropping the match. A match belonging to no group would be
  unreachable through every page, which is not what "it matched" can
  mean. Pinned by `keeps a match whose group did not participate…`.
- **Tuple label separator**: components join with `,`
  (`bank=1,cell=3`), since `·` is already the label's own separator
  between position and key.
- **Match menu**: the subset-checkbox model died with `indices`. The
  menu now lists the step sequence's *groups* and a click opens the
  page one sits on; it keeps its right-click opener (the left-click
  opener is 62.B).

Regex-engine verification (the design's identifier note): `$N`-suffixed
group names **do** parse in V8 — `Cell(?<cell$2>\d+)_Bank(?<bank$1>\d)`,
`(?<$1>x)`, `(?<cell$10>x)` all compile and capture; only a
digit-leading name (`(?<1cell>…)`) throws. No variant of the groomed
form failed.

Dom pins flipped deliberately (each per the groomed design):

| pin | was | now |
| --- | --- | --- |
| `shows only the matching series across every area` | `.?cell16.?` matched case-insensitively | case-sensitive; a message-path fragment selects, and the zero-match area keeps its rows |
| `masks pattern-derived series like manual picks` | zero-match Area 1 blanked | Area 1 untouched; menu labels are group labels, not `Area N · name` |
| `is inert while the pattern is invalid` | completed pattern left the zero-match area blanked | untouched, and the completed pattern's capture group makes two pages |
| `collapses an area with no solo-visible series` (renamed `…a matching area whose matches are all off the visible subset`) | a zero-match area collapsed | only an area solo applies to can collapse |
| `persists the pattern with the panel config` | `{pattern}` | `{pattern, page: 0}` (typing lands on page 1) |
| `steps one match at a time…` (renamed `cycles all -> page 1 -> …`) | flat wrap over matches | the all-in-the-cycle ring |
| `cycles the matches with PgDn / PgUp` | one match per press | one page per press |
| `pages by the configured number of matches` (renamed `puts the configured number of groups on a page`) | setting moved the cursor N matches; buttons stayed 1-at-a-time | setting sizes a page; buttons and keys walk the same cycle |
| `ignores PgDn / PgUp while no solo pattern is matching` | everything masked, read-out `0` | nothing masked, read-out `no matches` |
| `restores the full view from step mode on Escape` | `{pattern, indices:[0]}` | `{pattern, page:0}` |
| `starts a re-typed pattern back at the matches-only view` (renamed `lands a modified pattern back on page 1`) | back to all-visible | back to page 1 |
| `lists the current matches as checkboxes` / `shows any checked subset` / `generalizes step mode to a subset` | per-match checkbox subset | replaced by `lists the step sequence's groups…` and `opens the page a group sits on…` |

New pins added: the one-dialect agreement test, `soloPathResolver`'s two
paths, `soloKeySlots` (7 cases incl. `$N`, `(?:…)`, escaped/class
parens), `soloGroups` (8 cases), `soloPageCount` / `clampSoloPage` /
`stepSoloPage` / `soloPageOfGroup` / `soloLabel`, plus dom pins for the
zero-match area, the nowhere-matching pattern, keyed cross-area
stepping, the restored-page clamp, the pre-catalog restore, and the
pre-paging blob.

### 2026-08-09 — phase 62.B (branch `task62b-solo-feedback`)

The four visibility-feedback surfaces from §4, plus the two small
items (the `plotSolo.ts` NUL spelling, this doc sweep). Six commits,
each green on `pnpm --dir apps/gui test` + `pnpm --dir apps/gui build`
(no Rust touched — frontend-only phase):

| commit | subject |
| --- | --- |
| `6d22fc3` | `style(gui): spell soloMaskKey's separator, not embed it` |
| `e582274` | `feat(gui): mark a solo-masked row distinctly from a user-hidden one` |
| `f096406` | `feat(gui): show a per-area solo match chip in the signal-panel heading` |
| `bff8a39` | `feat(gui): give the solo toolbar's no-matches state its own look` |
| `366e08c` | `feat(gui): open the solo match menu on a left-click too` |
| `05ca732` | `docs(readme): describe the solo view's four new feedback surfaces` |

Final gates: frontend **142 files / 1842 tests** passing (1836 at the
phase's start, +6 — 2 pure-function cases for `soloMaskedKeys` plus 4
dom pins, one per surface); `pnpm build` clean.

What landed, against the groomed design (§4):

1. **Distinct solo-masked styling.** `soloMaskedKeys(areaId, signals,
   visible)` (`plotSolo.ts`) names the rows solo itself took off the
   view — explicitly excluding a signal already hidden on its own, so
   a row you really did hide keeps the plain treatment and solo isn't
   blamed for something it didn't do. `deriveAreaConfigs` computes it
   once per axis alongside the existing `soloMaskSignals` call (one
   place, no duplicated mask logic) and hands it down as
   `DerivedAreaConfig.soloMaskedKeys`; the row renderer adds a
   `solo-masked` class *alongside* `hidden` (never replacing it, so
   every existing visibility dom pin reading the `hidden` class kept
   passing unchanged) and `index.css` gives it its own inset marker
   and opacity, overriding the plain-hidden italic.
2. **Per-area match chip.** `soloAreaMatchCounts` (a `Map<areaId,
   count>` built off `soloMatchList`) feeds `DerivedAreaConfig.soloChip
   = {matched, total}`, set only on an area's first derived axis (like
   `patterns`) and only when solo applies to that area — so a
   zero-match area gets `null` and renders no chip, matching §4.2
   exactly. `PlotArea.tsx` renders it as `3 of 12 match` beside the
   area label.
3. **Toolbar readout finish.** The read-out's text is now computed
   once (`soloPosLabel`) and compared against `soloLabel`'s own
   documented `"no matches"` literal to add a `plot-solo-pos-empty`
   class — muted-italic, distinct from an ordinary position label.
4. **Left-click opens the match menu.** The position span's own
   `onClick` opens the same `SoloMatchMenu` the control's right-click
   does (right-click, which was already bound to the whole `.plot-solo`
   label and so already fired from the read-out too, is untouched);
   styled clickable (cursor, hover) only while there's a menu to open —
   the no-matches state has nothing behind it.
5. **`plotSolo.ts` NUL spelling.** The one literal `NUL` byte
   (`soloMaskKey`'s separator) is now the escaped `\0` — same runtime
   character, source-only change. `git diff` for the file now renders
   as text.
6. **Docs.** README's solo section (rewritten in 62.A) now covers all
   four surfaces; no other doc needed touching (`docs/adr/0026`'s solo
   paragraph states the model rule, which none of this phase's changes
   touch — a masked row's `hidden` flag and the mask's area-scoping are
   exactly as 62.A left them, only the view's *labeling* of the two
   hidden causes changed).

Every exit criterion in this task file now reads as met, including the
"four feedback surfaces land, dom-tested" line this phase closes.

### 2026-08-09 — ADR-0031 gate (orchestrator)

Five harness runs on the task62 build (tip `e5fe450`, release,
`ev-zonal` project, scrub interaction, expected 1608 rx/tx fps). Runs
2–5 passed all 31 gated metrics; run 1 failed a single metric,
`jsheap_mb_drift_per_min`, at 17.7 MB/min against the 16.4 MB/min limit
(baseline 5.7), with the other 30 metrics green.

Investigation (observation → hypothesis → experiment → data →
conclusion): task62's five samples were 17.7 / 14.0 / 5.7 / 4.0 / −1.9;
the pre-task62 build (`9dcfa87`) sampled the same day gave 13.1 / 8.7 /
2.5 committed earlier plus 2.0 / 11.6 from a same-day fresh-rebuild
control. The fresh 59h control's FIRST post-build run landing at 2.0
refuted the cold-machine-state hypothesis, and its 2.0 → 11.6 ordering
refuted run-order decay; means 7.9 vs 7.6 MB/min across five runs each
are statistically indistinguishable, so the conclusion is run-to-run
GC-timing variance unchanged by task 62 — run 1's 17.7 is the tail of
the same distribution, not a regression.

Verdict: gate green; runs 2–4 committed as the record; the excursion
documented here rather than in a committed report so future
worst-to-worst comparisons aren't poisoned by a known-noise sample.
(Owner may overrule at review.)

### 2026-08-09 — phase 62.C (branch `task62c-solo-followup`)

Investigation of the owner's live-use report: *"the filters seem to
work on pattern-provided signals, but only when a capture group
provides an index."* Reading taken: solo behaves on rows an area's
`patterns` materialized when the solo regex captures, and not when it
doesn't.

**Observation (raw).** The report above, plus one existing pin that
already reads that way: `masks pattern-derived series like manual
picks` asserts `typeSolo("Limit")` (no capture group) over two
pattern-provided rows shows `1/2 · LimitNominal (1 of 2)` — one row
visible out of two matches.

**Hypothesis H1 (defect).** Pattern-provided rows are matched, grouped
or masked differently from manual picks when the solo pattern has no
capture group — suspects: `soloPathResolver`'s catalog-miss fallback,
`signalRefKey` identity for materialized refs, `effectiveAreas` vs
derived-axis identity.

**Hypothesis H2 (by design).** Nothing distinguishes the two row kinds;
what the owner is seeing is the groomed design's positional grouping
(§3, "No capture group → each matched signal is its own group") meeting
`solo_page_size` = 1 and the "entering or modifying the pattern lands
on page 1" rule, so a captureless pattern lands showing exactly one
matched row.

**Experiment.** A panel area holding *both* kinds — manual picks
`LimitNominal` + `EngineTemp` and an area `patterns` entry
`EngineData/Limit` materializing `LimitEffective` — beside a
zero-match area (`EngineSpeed`), driven through the real panel; plus a
pure-function comparison of `soloMatches` / `soloGroups` over a manual
pick list and the same signals materialized by `applyAreaSelection`.

**Data.**

| configuration | observed | expected per design | verdict |
| --- | --- | --- | --- |
| captureless `Limit`, page 1 (as typed) | pick `LimitNominal` visible; **pattern row `LimitEffective` masked**; `EngineTemp` masked; `EngineSpeed` untouched; read-out `1/2 · LimitNominal (1 of 2)` | 2 positional groups, page size 1 → one match on show; zero-match area untouched | matches design |
| captureless `Limit`, next page | pick masked; **pattern row visible**; read-out `2/2 · LimitEffective (1 of 2)` | the pattern row is group 2 and reachable | matches design |
| captureless `Limit`, All | both kinds visible, `EngineTemp` still masked; `all (2)` | whole matched set on show | matches design |
| capturing `(Limit)\w+`, page 1 | **both kinds visible together**; `EngineTemp` masked; `1/1 · "Limit" (2 of 2)` | one shared key → one group → one page | matches design |
| capturing `Limit(\w+)`, pages 1–2 | one row per page, pick and pattern row in key order (`"Effective"`, then `"Nominal"`) | distinct keys → distinct groups | matches design |
| unit: `soloMatches` over picks vs `applyAreaSelection` output, patterns `Cell`, `Cell(\d+)`, `Cell(\d)` | identical name / path / captures lists, and identical `soloGroups` output (`Cell(\d)` → 2 groups, first with 2 members) | one subject, one dialect | matches design |

**Conclusion.** H1 is refuted: a pattern-provided row and a manual pick
of the same catalog signal are indistinguishable to solo at every level
measured — same canonical path, same captures, same group membership,
same mask. H2 is confirmed: the variable is the *solo* pattern, not the
row's provenance. Without a capture group every match is its own group,
so at `solo_page_size` = 1 the page a freshly typed pattern lands on
shows one matched row; with a capture group whose key several matches
share, that same page shows all of them at once. The report's
association with pattern-provided signals follows from volume rather
than kind — an area defined by a pattern typically carries tens of
rows, so positional grouping there collapses the view to 1-of-N — and
from row order: picks sort ahead of an area's pattern-provided rows, so
page 1 of a captureless pattern over a mixed area shows a *pick*, which
reads as the pattern-provided rows having been left out.

**No semantics changed.** The behaviour is the groomed design as
written (§3), so this phase lands tests only. One commit, green on
`pnpm --dir apps/gui test` + `pnpm --dir apps/gui build`:

| commit | subject |
| --- | --- |
| `026d13d` | `test(gui): pin how solo reads an area's pattern-provided rows` |

Frontend **142 files / 1845 tests** passing (1842 at the phase's start,
+3 — one pure `soloMatches` pin for the two row kinds, two dom pins for
the mixed area under a capturing and a captureless pattern); `pnpm
build` clean. No Rust touched.

**Open owner design question (not decided here).** Landing a
*captureless* pattern on page 1 is what makes a quick name filter read
as "it only kept one signal". The alternative — a captureless pattern
lands on **All**, so it reads as a plain filter, and only a capturing
one lands on page 1 to start stepping — is a change to the "entering or
modifying the pattern lands on page 1" ruling (§3) and so needs an
owner ruling; it was deliberately not made here. A second, smaller
option is to raise the default `solo_page_size`, which is a setting
rather than a semantics change.

### 2026-08-09 — phase 62.D (branch `task62d-solo-subset`)

The two changes the grooming addendum above records: a captureless
pattern becomes a **flat filter** (the semantics change, landed first),
and the match menu becomes a **checkable subset** on top of it. Five
commits, each green on `pnpm --dir apps/gui test` + `pnpm --dir apps/gui
build` (frontend-only phase — no Rust touched):

| commit | subject |
| --- | --- |
| `5c93c85` | `docs(task62): record the 62.D grooming — flat captureless, checkable subset` |
| `c0fc33e` | `feat(gui): give a captureless solo pattern no pages to be on` |
| `4adce13` | `feat(gui): filter flat on a solo pattern that captures nothing` |
| `0f14525` | `feat(gui): model a checked subset of the solo match list` |
| `bccbbef` | `feat(gui): tick a subset of the solo match menu to show exactly those` |

Final gates: frontend **142 files / 1876 tests** passing (1845 at the
phase's start, +31); `pnpm build` clean.

What landed:

1. **Flat captureless (`soloPatternPages`).** One predicate — *only a
   pattern that captures has a step sequence* — is the whole semantics
   change. The panel feeds it into `soloPages`, so a captureless
   pattern has **zero** pages and everything downstream falls out of
   the machinery that already existed: `clampSoloPage` gives `null`
   (the whole matched set), `stepSoloPage` has nowhere to go, the
   read-out is `all (96)`, and the ‹ › buttons are `disabled` (with a
   dimmed style) rather than silently inert. Masking stays per matching
   area and a zero-match area stays untouched, exactly as §1 rules —
   nothing in the mask path needed to change to get the owner's "just
   whatever matches in every signal panel, all at once".
2. **No page is ever written under a captureless pattern.**
   `setSoloPattern` lands a capturing pattern on page 1 and a
   captureless one on the flat view; `soloFromRaw` drops a page stored
   against a captureless pattern (a blob from an older build, or from
   an edit that removed the capture group), so it restores flat.
3. **Item identity (`SoloGroup.id`).** The captured key's JSON tuple
   for a capturing pattern; the match's own `soloMaskKey` (area id +
   signal ref) for a captureless one — never a list index, so a subset
   survives a re-derive that reorders or shortens the list. Captureless
   items also take the area label (`Area 2 · Cell1`) so the same signal
   plotted twice reads apart in the menu; `soloGroups` takes the label
   map as an optional third argument and the panel's existing
   `areaLabels` memo (moved up above the solo block) feeds it.
4. **Selection, as pure functions.** `toggleSoloChecked`,
   `soloSelectedGroups` (item-list order, stale ids dropped, an
   all-stale selection reading as no selection), `soloMemberKeys`, a
   subset form for `soloLabel`, and `stepSoloFromSelection`.
   `PlotPanel.tsx` only wires: one `soloSelected` memo, one branch in
   `soloVisible`, one branch in `soloMenuItems`, and `toggleSoloGroup`
   replacing `showSoloGroup`. Because the mask, the collapse rule and
   the per-area chip all read the *visible set*, none of them knows a
   subset exists.
5. **The exact stepping semantics** (pinned by
   `stepSoloFromSelection`'s unit cases and the
   `leaves a ticked subset behind…` dom pin): a step **leaves** the
   subset (`checked` is emptied) and resumes the ordinary ring —
   forward from the page *after* the page of the **last** checked item,
   backward from the page *before* the page of the **first**; running
   off either end lands on the whole set, like every other step; a
   selection with nothing live left in it steps to the whole set. With
   a captureless pattern there is no ring, so a step is a no-op and the
   subset stays put.
6. **Persistence: three mutually exclusive forms.** `{pattern}` (flat,
   or the whole matched set), `{pattern, page}` (a capturing pattern's
   page), `{pattern, checked: [...]}` (a subset). Ticking an item drops
   the page and stepping drops the subset, so the state can't hold
   both; a blob carrying both parses as the subset. Tolerant parse:
   a `checked` that isn't a list of strings is dropped, non-string
   entries within one are dropped and duplicates collapsed, an empty or
   fully stale selection reads as the whole set. As with the page, the
   stored ids are only ever *re-interpreted* against the live item
   list, never written back — which is what makes a restore against an
   unpopulated catalog harmless.

Decisions taken inside the groomed design (none of them a divergence):

- **Subset read-out for one item** reads `1 group · cell=03 (4 of 96)`
  (singular), the design having specified only the ≤2 and >2 forms.
- **Captureless item label separator** is ` · `, matching the v1 menu's
  `Area N · name` the design cites; a subset of them therefore reads
  `2 signals · Area 1 · Cell1, Area 2 · Cell1 (2 of 96)`.
- **The step buttons are `disabled`** (the design said "prefer visibly
  disabled"), which also covers the `no matches` state — there is
  nothing to step in either case.

Dom pins flipped deliberately:

| pin | was | now |
| --- | --- | --- |
| `masks pattern-derived series like manual picks` | `Limit` paged: `1/2 · LimitNominal (1 of 2)`, one row on show, `next` steps | flat: both rows on show, `all (2)`; menu labels carry the area |
| `makes every match its own page when the solo pattern captures nothing` (renamed `shows both row kinds at once…`) | 62.C's positional paging over a mixed area | both kinds on show together, `next` disabled |
| `persists the pattern with the panel config` | `{pattern: "Cell16", page: 0}` | `{pattern: "Cell16"}` — captureless has no page |
| `pulls a restored page past the end onto the last one` | stored page under `Cell` | stored page under `(Cell\d)`, the only kind with a page to clamp |
| `opens the page a group sits on, and stays open` (replaced by `ticks a subset of the groups…`) | click jumped to the group's page | click toggles the item |
| the stepping / paging / menu pins (`cycles all -> page 1 -> …`, `cycles the pages with PgDn / PgUp`, `puts the configured number of groups on a page`, `steps after a click…`, `restores the full view from a page on Escape`, `lands a modified pattern back on page 1`, `lists the step sequence's groups…`, `opens the match menu on a left-click…`) | driven by the captureless `Cell` | driven by the capturing `(Cell\d)` — same one-group-per-match sequence, labels now quoted |
| persistence unit fixtures carrying a page | `{pattern: "Cell", page: 2}` | `{pattern: "Cell(\\d)", page: 2}` |

New pins added: `soloPatternPages` (2 cases), group identity and the
area-labelled captureless label (3), `toggleSoloChecked` (2),
`soloSelectedGroups` (3), `soloMemberKeys` (1),
`stepSoloFromSelection` (5), `soloLabel`'s subset forms (4), the
`checked` persistence forms (4 cases across the subset, junk-drop,
exclusivity and round-trip pins); plus dom pins for the flat filter
across areas with a zero-match area untouched and the step controls
inert, a page stored under a captureless pattern restoring flat,
ticking a subset of groups, ticking captureless matches, stepping out
of a subset, a modified pattern dropping one, a subset persisting and
restoring, and an all-stale subset reading as the whole set.

**ADR 0026 needed no change.** Its solo paragraph states the model rule
(a view mask composed on `hidden`, scoped to matching areas), which this
phase leaves exactly as it was, and its `plotSolo.ts` inventory already
says "checked subset" — true again as of this phase.

### 2026-08-10 — ADR-0031 gate for 62.C/62.D (orchestrator)

Five harness runs on the 62.D build (tip `58aeb06`, release, `ev-zonal`
project, scrub interaction, expected 1608 rx/tx fps). Run 1 failed one
metric, `rx_gap_short_frac_worst`, at 0.057 against the 0.041 limit
(baseline 0.006); runs 2–5 passed all 31 gated metrics
(`rx_gap_short_frac_worst` 0.005 / 0.006 / 0.003 / 0.006).

Because this metric caught a real regression once before (the
cadence-flush round), a control experiment ran: rebuild at the 62.C
tip (`b9dec14`, runtime-identical to the already-gated 62.B build
since 62.C added only tests/docs) under the same machine state — its
OWN first post-build run failed the same metric at 0.055, runs 2–3
clean (0.006, 0.004).

Conclusion: the excursion reproduces on a build containing none of
the 62.D diff, at the same magnitude, in the same first-run-after-build
position — machine-state interference, not the diff (which is
frontend-only, with longtask/lag/jank clean even in run 1).

Verdict: gate green; runs 2–4 committed as the record; excursion
documented here, not committed, so worst-to-worst comparisons stay
clean. (Owner may overrule at review.)

## Blockers / side effects

- **A shell heredoc ate a level of backslashes and wrote a NUL into a
  test file** (62.D). Editing `plotSolo.test.ts` through
  `python - <<'PY'` collapsed `\\\\d` to `\d` (so a capturing fixture
  pattern silently became `Cell(d)`) and `\\0` to a literal NUL byte —
  which is exactly the byte that made `plotSolo.ts` binary to git for
  most of this task. The same write also left the file with mixed
  CRLF/LF endings, the whole-file-diff hazard 62.A hit. Caught before
  committing (`git show --stat` on the commit is the check that catches
  it; `git -c core.autocrlf=false diff` is *not* — under this repo's
  `core.autocrlf=true` it reports every CRLF line as changed and is
  pure noise). Fixed by doing the edit from a script *file* rather than
  a heredoc. Rule for future sessions: don't pipe source edits through
  a shell heredoc on this repo.
- **The `plotSolo.ts` NUL fix nearly re-triggered the whole-file-diff
  hazard, from the opposite direction.** Once the byte was replaced,
  `git diff` against the pre-fix blob (still holding the `NUL`, so git
  still sniffs it as binary on that side) reported all 467 lines
  changed under this repo's `core.autocrlf=true`, even though the
  working file differed from `HEAD` by exactly the one intended byte —
  confirmed with a raw byte-for-byte comparison. `git -c
  core.autocrlf=false diff` showed the true 1-line diff; staging with
  `git -c core.autocrlf=false add` before committing kept the landed
  commit proportionate. The file is ordinary text to git from this
  commit on, so a normal `git add` normalises it like any other
  tracked file from here — this was only a one-time risk for the
  commit that flipped its binary status.
- **`plotSolo.ts` is a binary file to git.** `soloMaskKey` joins its
  two parts with a literal `NUL`, which predates this task; git
  therefore skips CRLF normalisation on the file, and a tool that
  rewrote it with LF endings turned one commit into a whole-file diff.
  Caught and corrected before reporting (the commit was re-made with
  CRLF restored, so `55b1f89`'s diff is proportionate). Not otherwise
  touched — changing the separator is out of scope here.
- **ADR 0026 corrected, no new ADR.** Its solo paragraph asserted the
  display-name subject and the collapse-any-blank-area rule, both of
  which this phase changes; the paragraph now states the path subject
  and the match-scoped mask. The decision it records (solo masks the
  view, never rewrites `hidden`) is unchanged, so no superseding ADR
  was needed — matching the exit criteria's default.
- **`solo_page_size` is read during render, not memoised.** A settings
  change therefore takes effect on the panel's next render rather than
  immediately; the previous code had the same property (it read the
  setting at press time). Left as is.

## Exit-criteria walk (2026-08-09)

1. **MET.** Zero-match areas render untouched under an active solo,
   pinned both ways by 62.A's dom tests (matching area masked,
   zero-match area identical to solo-off) and the nowhere-matching
   pattern; the toolbar's `no matches` state is 62.B's readout test.
2. **MET.** Solo and area patterns share one regex dialect — 62.A's
   agreement test runs the same regexes through `soloMatches` and
   `resolvePatterns` and asserts the same selection.
3. **MET.** Group-by-capture stepping is covered by 62.A's
   pure-function suites for `soloKeySlots`, `soloGroups`, paging, and
   the cycle, plus the dom-tested All-cycle and lands-on-page-1 rules.
4. **MET.** The four feedback surfaces (distinct solo styling,
   per-area chip, two-form/no-matches readout, click-to-open match
   menu) land dom-tested in 62.B.
5. **MET.** Stale-restore behavior is covered by 62.A's restored-page
   clamp and pre-catalog restore dom pins.
6. **MET.** Docs: the README solo section was rewritten in 62.A and
   extended in 62.B; ADR 0026 was corrected in place; no new ADR, per
   the default.

ADR-0031 gate green per the gate entry above.

### Addendum (2026-08-10) — after phases 62.C/62.D

Re-walking only what the extensions changed, reading the 62.C/62.D
status-log entries above as evidence.

**Criterion 3, captureless clause — MET, superseded.** §3's
positional-stepping sentence — "No capture group → each matched signal
is its own group (positional stepping)" — was superseded by owner
ruling, recorded in the 62.D grooming addendum: a captureless pattern
is now a flat filter (no pages, step controls inert, all matches on
show at once, zero-match areas untouched), dom-pinned in 62.D. The
capturing-pattern clauses (keyed grouping, ordering, `$N`, `(?:…)`,
tuples, paging, the All-cycle, lands-on-page-1) remain MET, unchanged.

New capability walked, not in the original six criteria: the checkable
subset (menu ticking, group-keyed/match-keyed identity, `{pattern,
checked}` persistence, stepping-out semantics) — dom- and unit-pinned in
62.D.

62.C landed no semantics change; its verdict was the owner report
reproduced as by-design, with three pins added as a regression guard.

The ADR-0031 gate for the extension is green per the entry above.

Final test counts: frontend **142 files / 1876 tests**; host untouched.
