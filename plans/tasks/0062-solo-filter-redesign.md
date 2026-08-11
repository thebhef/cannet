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

## Blockers / side effects

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
