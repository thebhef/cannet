# Task 20 — Signal View Panel

A latest-snapshot-of-all-signals surface: the **'by-id' trace view
analog for signals**. Three deliverables share one model and one set
of shared components:

1. an element-backed **signal view panel** (user-selected signals,
   flat table),
2. a **live value column** in the existing DBC panel,
3. the **plot panel adopting the shared signal-selection and palette
   implementations** (fixing its known picker gaps along the way).

Spec settled 2026-07-12 (grilling session). Historical note: this
task's original DBC/drag-drop scope shipped in Tasks 12/15/33; the
trace-row inline signals shipped with former Task 32.

## Model (host)

- **Per-signal latest snapshot, mux-aware.** "Latest value" means the
  last frame *whose mux selector matched the signal's group*, not the
  message's last frame — decoding only the latest frame would blank
  every other mux group (the ev-zonal 500-mux-signal messages are the
  stress case). Host keeps an incremental latest-matching-frame index
  per (bus, message, mux group) on the append path; paused windows
  answer with a cache-assisted / bounded backward scan (give up after
  a sane bound → blank). The mux-aware decode itself already exists in
  `signal_sampler.rs` (mux-gated frames are skipped for plots); the
  new piece is the point-query index.
- **`fetch_signal_page`** — the paged snapshot query:
  `(window, selection, sort, offset, limit) → { total, rows }`.
  Selection, sort, and paging all evaluate **host-side** (thin-view
  rule; the frontend never holds the full descriptor set). Row payload:
  `bus, ecu, message, signal, fps, time, count, value (+ resolved
  colormap color), unit` (+ raw and enum label where applicable).
  Every column is sortable; `value` sorts numerically on the physical
  value (enums by raw); blank values sort last.
- **Rows are descriptors, always present.** A matching signal that
  hasn't appeared in the window is still a row — blank value, no
  time/fps/count. A dashboard that silently drops a dead ECU's rows
  hides exactly the failure being watched for.
- **Selection** = manual descriptor keys + regex patterns,
  OR-combined, deduped on descriptor key. Regex evaluates host-side
  against the **canonical signal path** (below); invalid patterns
  surface as a panel error, never a crash.
- **Per-signal update statistics.** `time` / `fps` / `count` count the
  *signal's* updates (mux selector matched), which reduces to the
  message statistics for plain signals — message-level stats on a mux
  signal would claim updates the signal never received. Column
  **headers and value formatting stay identical to the by-id view**
  (`count`, `time (s)`, `msg/s` — see `traceColumns.ts`); only the
  counted population differs.
- **Bulk values-for-keys** — sibling query the DBC panel uses for its
  visible slice (same decode path, same row payload, so the two
  surfaces cannot drift).
- **ECU everywhere:** `transmitter` joins the trace/by-id row records
  and gets a column in those views too.

## Canonical signal path (small ADR ships with this task)

`bus/ecu/message/signal` is the one human-readable way to reference a
signal app-wide: the regex subject, the fzf-match subject, and the
display form. (The plot's C++-style display strings migrate
opportunistically.) Internal descriptor keys — `(bus, message id,
extended, signal name)` — remain the stable identity; the path is
presentation and matching only.

## Signal view panel

- **New element kind `signals`** — element-backed like trace/plot;
  panel component, `FocusedPanelKind`, toolbar + palette add-commands,
  project-graph presence as a **sink node** whose `sources` wiring
  scopes its bus set (unwired = all buses, like other consumers).
- **Full trace-state analog**: Start/Pause/Stop with the shared trace
  controls; running follows live (values update on the live tick),
  paused/stopped snapshots latest-per-signal within `[start, end)`.
  Session re-anchor semantics identical to by-id.
- **Looks like the by-id view**: same table chrome, same column model
  (`traceColumns` pattern — widths, hide/show, sort), columns
  `bus, ecu, message, signal, fps, time, count, value, unit`.
- **Shared selector implementation with the plot panel** (one
  component/model): manual picks + regex patterns, plus **convert:
  regex → manual** (materialize the pattern's current matches into
  explicit picks; one-way — generated alternations aren't wanted).
- **Signal-name color wheel**: names render in the shared 16-color
  wheel (ADR 0026), **stable by identity** (`wheel[hash(descriptor
  key)]`) and **configurable per signal** — the override persists at
  project level (a signal-key → color map), so a signal keeps its
  color across sorts, views, and sessions. All wheel colors must hold
  excellent contrast against the panel background.
- **Drag and drop**: the existing DBC→plot drag payload (message or
  signal — container drags of ECU/bus stay unsupported) also drops
  onto a signal view (adds to the manual list; a message adds its
  signals), and signal-view rows are draggable out to plots. One
  shared drag type across all three surfaces.

## DBC panel value column

- Toggleable column in the DBC panel's own toolbar; the DBC panel
  stays a **singleton navigator with no graph presence** and no
  window state — values are **live-latest only** (pausing belongs to
  signal-view elements).
- Value cell shares one renderer with the signal view: value + unit +
  colormap color + enum label.
- Values fetch per visible tree slice at the live tick cadence
  (the panel already pages by viewport); search/collapse behavior
  unchanged.

## Plot panel adoption (same task, shared implementations)

- Selector: regex + manual + convert, replacing the catalog-only
  picker; catalog scoped by the plot's effective `sources` (absorbs
  the standing backlog item).
- Palette: extract the shared 16-color wheel module; `plotFilter.ts`'s
  stale 8-color copy is deleted (absorbs the standing backlog bug).

## Exit criteria

- A signal view shows selected signals with live values; pause
  snapshots latest-per-signal within the window; blank rows for
  not-yet-seen descriptors.
- Mux correctness: on a multiplexed message, every group's signals
  hold their latest values simultaneously (no blanking by the last
  frame's group), covered by a host test against a mux fixture.
- Selection: regex + manual, host-side evaluation, regex → manual
  materialization; the same selector component drives the plot panel,
  whose catalog is now `sources`-scoped.
- Host paging/sorting: the panel fetches only its viewport slice;
  all columns sort host-side; value sorts numerically, blanks last.
- DBC panel value column: toggleable, live-latest, colormap + enum
  labels, shared value renderer with the signal view.
- Signal-name colors: stable by identity, per-signal override
  persisted in the project, shared wheel module (plot migrated,
  `plotFilter.ts` duplicate gone), contrast verified on the dark
  theme.
- ECU (transmitter) column available in trace and by-id views.
- Canonical-path ADR recorded (`bus/ecu/message/signal`); regex and
  fzf subjects use it.
- Drag/drop: DBC panel → signal view, signal view → plot, message and
  signal payloads only.
