# Task 41 — DBC Panel Performance with Large DBCs

The GUI becomes unusable on projects with large DBC sets. Reference
project: 5 DBCs, ~1,400 messages / ~18,500 signals, two DBCs (~1.4 MB
and ~0.8 MB) each scoped to two buses — so the per-bus expansion yields
~2,628 message-instances / 32,902 signal-descriptors. Observed
2026-07-27 on a macOS release build (`cannet.app`): interaction latency
of seconds, no capture running, empty session buffer.

## Root cause (confirmed by profiling the running app)

The WebContent process had consumed **2m46s of CPU in a 3m11s
lifetime**; the Rust host sat at ~1%. A 5-second `sample` of the busy
WebContent process put **100% of samples in one synchronous stack**: a
single typed character in an input element → WebKit editing
(`TypingCommand::insertText` → `VisibleSelection::validate`) →
`Document::updateLayout` → full recursive relayout. **No JavaScript
frames** — the cost is WebKit layout over the DOM itself.

The DBC panel renders every row as real DOM with no virtualization
([DbcPanel.tsx:1027](../../apps/gui/src/DbcPanel.tsx#L1027)), and
`groupByBus` duplicates a DBC's subtree into every bus group it is
scoped to ([DbcPanel.tsx:338](../../apps/gui/src/DbcPanel.tsx#L338)) —
~2,628 message rows for the reference project, tens of thousands of
layout boxes. Every layout invalidation (each filter keystroke, a
selection click, a resize, a value tick) then costs a synchronous
full-document layout measured in hundreds of ms to seconds.

This is the CLAUDE.md "thin views over a paged model" rule violated in
the message/signal dimension: the host deliberately declines to expand
the tree per bus because it "would multiply the payload"
([dbc_commands.rs:233](../../apps/gui/src-tauri/src/dbc_commands.rs#L233));
the frontend re-expands it anyway and renders all of it.

## Secondary hot spots (measured or read from code, same scaling cliff)

Benchmarked against the reference project's real DBC files (release
build, M-series):

- **`fetch_signal_page` descriptor rebuild** — `scoped_descriptors`
  rebuilds and sorts all 32,902 descriptors on every call (12 ms), and
  `select_descriptors` is O(descriptors × manual keys)
  ([signal_snapshot.rs:95](../../apps/gui/src-tauri/src/signal_snapshot.rs#L95)):
  65 ms at 500 expanded rows, 250 ms at 2,000. The DBC panel polls this
  at 2 Hz while `showValues` is on
  ([DbcPanel.tsx:803](../../apps/gui/src/DbcPanel.tsx#L803)) with no
  panel-visibility gate; each signal-view panel adds the same rebuild at
  4 Hz. Fix shape: cache the descriptor snapshot (invalidate on DBC/bus
  change) and index manual keys with a hash lookup.
- **Eager search index + per-keystroke fzf** — ~35k haystack strings
  (value tables inlined) built even with an empty query
  ([DbcPanel.tsx:751](../../apps/gui/src/DbcPanel.tsx#L751)), and a new
  `Fzf` over the full index per keystroke
  ([DbcPanel.tsx:559](../../apps/gui/src/DbcPanel.tsx#L559)).
- **`DbcRow` not memoized** — every panel state change re-executes all
  rows; with virtualization in place this shrinks to the viewport, but
  memoization is still right.
- **Whole-tree IPC payload** — `list_dbc_content` ships the full parsed
  tree (~5 MB serialized for the reference project) and the panel
  re-pulls it once per changed file on `dbc-changed` and on any
  bus/scope edit
  ([DbcPanel.tsx:705](../../apps/gui/src/DbcPanel.tsx#L705)).

Ruled out: DBC parse (~120 ms total for all 5 files at project open),
`dbc_content()` clone cost (~1.7 ms for all 5), and the per-frame
ingest path (HashMap probe + decode-on-fetch — O(1) in DBC size).

## Work items, in order

1. **Virtualize the DBC panel row list.** The panel already flattens to
   a `rows` array; render only the viewport slice plus a bounded
   margin. Windowing library choice (or hand-rolled fixed-row-height
   windowing, as the trace table does) goes through
   `plans/technology-inventory.md` first.
2. **Memoize `DbcRow`; debounce the filter input.**
3. **Host-side signal-page snapshot cache + keyed selection lookup**
   (the `scoped_descriptors` / `select_descriptors` items above), and
   gate the panel's value poll on panel visibility (the
   `SystemMessagesPanel` pattern).
4. **Lazy/incremental search index** — build on first non-empty query,
   reuse the `Fzf` instance across keystrokes.

Item 1 alone should restore usability; 2–4 are the same cliff and are
in scope, but each lands as its own commit with its own test. The IPC
payload shape (paged `list_dbc_content`) is explicitly **out of scope**
— note it in `plans/backlog.md` if it still matters after 1–4.

## Exit criteria

- With the reference project's DBC set loaded (a synthetic fixture of
  equivalent scale is fine for CI), typing in the DBC panel filter and
  clicking rows respond at interactive latency; DOM row count is
  bounded by the viewport, not the DBC size (asserted by a frontend
  test).
- `DbcRow` render count per value tick is bounded by visible rows
  (test via render-count probe or memo identity).
- `fetch_signal_page` no longer rebuilds the descriptor universe per
  call (host-side test: snapshot reused across calls, invalidated on
  DBC change); manual-key selection is no longer a linear scan per
  descriptor.
- The DBC panel's value poll stops when the panel is hidden.
- No regression in the existing DBC panel and signal-view test suites.

## Status — all four items landed

Removed from `plans/tasks/roadmap.md`; this file can go with the commit
that lands the work. What shipped, against the exit criteria:

- **Item 1 — virtualization.** `apps/gui/src/dbcPanelViewport.ts` (pure
  prefix-offset geometry, unit-tested without a DOM) plus the windowing
  glue in `DbcPanel.tsx`. Row heights are pinned by `.dbc-row` /
  `.dbc-details-grid` in `index.css`; the "details" toggle's per-row
  block is measured through `detailLinesFor`. The value column's
  `fetch_signal_page` selection is now the *visible* slice, not the
  whole tree. Windowing library decision recorded in
  `plans/technology-inventory.md` (hand-rolled, re-confirming the
  `@tanstack/react-virtual` rejection).
- **Item 2 — `memo(DbcRow)` + a 150 ms filter debounce.** Guarded by a
  `dbcpanel.rowRender` diag counter (`diag.ts` grew a `diagCounts()`
  reader): a cursor move re-renders ≤ 4 rows rather than the window,
  and a burst of keystrokes rebuilds the tree once.
- **Item 3 — host-side descriptor-snapshot cache**
  (`signal_snapshot::DescriptorSnapshot`,
  `AppState::scoped_descriptor_snapshot`, dropped by
  `invalidate_derived_caches`), **hashed manual-key selection**, and the
  **panel-visibility poll gate** (`api.onDidVisibilityChange`).
  `select_descriptors` took over the `source_buses` scope filter so the
  cached universe stays shareable instead of being pruned per call.
- **Item 4 — lazy matcher.** `lazyMatcher` builds the haystack index
  *and* the `Fzf` instance on the first non-empty query and reuses both
  until the tree changes; counted by `dbcpanel.searchIndexBuild`.

The out-of-scope IPC-payload item moved to `plans/backlog.md`.
