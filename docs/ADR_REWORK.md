# ADR rework — running checkpoint

Working doc for the in-progress migration of cannet's architectural
decisions out of `plans/*.md` and the technology inventory into
focused ADRs under `docs/adr/`. Updated as the migration progresses;
delete when the migration is complete and no ADRs remain on the
outstanding list.

## Conventions in force

Established earlier in the migration session. These bind every new
ADR until explicitly revised.

- **Lightweight format default.** Title + 1–3 sentences is the
  minimum; optional sections (Status, Context, Decision,
  Alternatives, Consequences) appear only when they add real value.
  Err on keeping relevant detail when extracting from existing
  inventory or plan-doc entries — don't strip the rationale.
- **One ADR per architectural decision.** Dependencies pulled in by
  a decision are named in the ADR's Consequences (with role + first-
  mention license tag). Trivial dependency picks (de-facto standards
  with no real alternative) stay inventory-only with no ADR.
- **License at first mention of each library; never repeated.**
  Engineering rationale leads; license-status framing kept minimal.
  Removing performative license discussion was a deliberate steer.
- **Inventory after migration = thin registry of pointers.**
  `plans/technology-inventory.md` shrinks each migrated entry to a
  one-liner + ADR pointer. Trivial picks (no-alternative dev-deps,
  helper crates) stay as one-line inventory entries with no ADR.
- **Plan docs after migration = scope + TODOs + exit criteria.**
  Decisions extract to ADRs; plan docs keep the phase scope, the
  acceptance criteria, and what's out-of-scope. Each affected plan
  section gains a "decisions: see ADR-NNNN" pointer.
- **Source docs that are pure decision** (e.g. the dissolved
  `plans/project-panel-design.md`) **disappear** when their ADR
  lands.
- **CLAUDE.md edits scoped.** The "thin views over a paged model"
  rule must stay loud and binding in CLAUDE.md — do not weaken
  during extraction (see memory [[dont-weaken-thin-views-rule]]).
- **Numbering.** Today's ADRs use a taxonomy-based numbering that
  predates the writing order (gap at 0003-0008). Going forward we
  use the next-sequential convention (scan `docs/adr/` for highest,
  increment). The gap at 0003-0008 is reserved-ish for the
  inventory-derived ADRs below; if they don't land in those slots,
  the gap simply persists as a documented quirk of this migration.
- **Architecture, not implementation.** ADRs record the *shape* of
  the decision (contracts, defaults, invariants, asymmetries).
  Specific UI affordances, button locations, file-level identifier
  names, field-level type details (e.g. `channel: u8`), and
  "this particular instance shows the pattern" historical bullets
  belong in plan docs, code comments, or rustdoc — not in ADRs.
- **Describe what is, not what was.** No comparisons to superseded
  implementations ("changed from X," "used to leak," "the
  explicit-source model imposed setup cost") — the ADR records the
  current decision, not the diff from history. Git carries the
  diff. (Caught on ADR 0013 in two passes after the initial draft.)

## ADRs done

| # | File | Source(s) | Notes |
|---|---|---|---|
| 0001 | [`adr/0001-indefinite-length-capture.md`](adr/0001-indefinite-length-capture.md) | pre-existing | — |
| 0002 | [`adr/0002-disk-spill-store.md`](adr/0002-disk-spill-store.md) | pre-existing | — |
| 0009 | [`adr/0009-dbc-blf-readers.md`](adr/0009-dbc-blf-readers.md) | inventory § File Formats | Revised this session: own BLF crate, retire `blf_asc`, clean-room from Vector public spec, test oracle = python-can + `vector_blf` (pulled at pinned ref at test time, not vendored) |
| 0010 | [`adr/0010-no-sidecar-files.md`](adr/0010-no-sidecar-files.md) | CLAUDE.md § File formats + backlog | High-priority cleanup of the `.blf.notes.json` sidecar tracked in backlog |
| 0011 | [`adr/0011-project-file-format.md`](adr/0011-project-file-format.md) | Phase 3 in `plans/phased-implementation.md` | TS/Rust `PROJECT_SCHEMA_VERSION` mismatch flagged in backlog as bug |
| 0012 | [`adr/0012-project-panel-graph-split.md`](adr/0012-project-panel-graph-split.md) | `plans/project-panel-design.md` (deleted, fully dissolved) | — |
| 0013 | [`adr/0013-default-receive-all-edge-edits-transmit-by-bus.md`](adr/0013-default-receive-all-edge-edits-transmit-by-bus.md) | Phase 6.5 in `plans/phased-implementation.md` | Three coordinated decisions: consumers receive from every bus by default, user-editable graph edges, transmit binds to `bus_id` not wire channel |
| 0014 | [`adr/0014-host-system-log.md`](adr/0014-host-system-log.md) | Phase 7 in `plans/phased-implementation.md` | Bounded, session-scoped, flood-protected in-process bus tee'd to `tracing`; sidecars contribute via wire `Log` envelope. **Framing under review** — see Open questions. |
| 0015 | [`adr/0015-fetched-runtime-binaries.md`](adr/0015-fetched-runtime-binaries.md) | Phase 18 + backlog uv-fetch item | External runtime binaries fetched at a pinned version, not committed or bundled; `uv` is today's instance |

## ADRs outstanding

### Inventory-derived (consolidate meaty entries in `plans/technology-inventory.md`)

| # | Title | Source material |
|---|---|---|
| 0003 | GUI is a single-window Tauri shell with a React/TS frontend | Tauri 2, React 18, Vite, TS entries; the hand-rolled scaled-scrollbar virtualizer (deliberate `@tanstack/react-virtual` replacement); Qt / Electron / ImGui / wxWidgets rejections |
| 0004 | Wire protocol is gRPC over HTTP/2; wire is the universal driver contract | tonic, prost, tonic-build, async-stream, clap; raw-TCP / ZMQ / WebSockets rejections; `bus-config` and `LogMessage` envelope shape |
| 0005 | Multi-panel UI uses `dockview` | dockview entry; flexlayout / rc-dock / react-mosaic / golden-layout rejections |
| 0006 | Project graph uses `@xyflow/react`; filter predicates stay structured JSON (no DSL) | `@xyflow/react` entry; cytoscape / d3-force / reaflow rejections; the explicit filter-DSL rejection |
| 0007 | Plot renderer is uPlot | uPlot entry; dygraphs / Chart.js / lightweight-charts / ECharts / Plotly / Highcharts / hand-rolled rejections |
| 0008 | Hardware drivers via one `python-can` sidecar | python-can, uv, grpcio entries; Vector XL / Kvaser / PEAK vendor blobs; native-FFI rejection; socketcan-only rejection; multi-sidecar deferral |

### Plan-doc-extracted (typically one phase's decision)

| # | Title | Source material |
|---|---|---|

## Surfaced this session but not promoted to ADRs

- **GPL-3.0-only project license** — lives in memory as
  [[licensing-decision]]. Considered for promotion; the user's
  steer about not enshrining license-as-architecture means it
  stays a memory unless explicitly promoted later.
- **Clean-room rule for `cannet-blf`** — captured inside ADR 0009;
  no separate ADR. Also in memory as
  [[clean-room-blf-constraint]] for agent-side discipline.
- **Test-oracle pattern (pull GPL libs at pinned ref, build at
  test time)** — captured inside ADR 0009. Would earn its own ADR
  if it became a general project-wide pattern beyond BLF.

## Source docs scheduled to dissolve when their ADR lands

| Doc | Dissolves into |
|---|---|
| `plans/project-panel-design.md` | ADR 0012 — **already done; deleted** |

(All other plan docs survive the migration as scope + TODOs, with
"decisions: see ADR-NNNN" pointers added where applicable.)

## Open follow-ups / threads worth not losing

- **TS/Rust `PROJECT_SCHEMA_VERSION` mismatch** — Rust at 4, TS at
  3, frontend stamps new projects with the TS value. Tracked in
  `plans/backlog.md` § "Other near-term work" as `[bug]`.
- **`<file>.blf.notes.json` sidecar removal** — tracked in
  `plans/backlog.md` § High priority. Blocked on tranche 2 of the
  `cannet-blf` own-implementation work (GLOBAL_MARKER read+write).
  See ADR 0010.
- **`cannet-blf` own implementation work** — `[phase]` item in
  `plans/backlog.md` § High priority. Per ADR 0009. Needs scheduling
  as a phase in `phased-implementation.md` when picked up.
- **Phase-9 mentions to scrub from rustdoc** when the sidecar
  removal above lands — listed in the sidecar-removal backlog
  item's task body.

## Process notes (so we can resume cleanly)

- ADR migration has been **ADR-by-ADR with user review between
  tranches** since Tranche 1. Each tranche = one new ADR + its
  associated edits across `plans/`, `technology-inventory.md`,
  `backlog.md`, `CLAUDE.md`, and `README.md`.
- The user picks which ADR is next (typically via an
  `AskUserQuestion` round); never assume the next one based on
  numbering.
- After each tranche, summarise *what changed in which file* so
  the user can review at a glance.
- Pre-existing markdown lint warnings (MD060 table-pipe alignment,
  MD049 italic-underscore, MD041 first-line h1 on memory files,
  MD004 literal-`+`-in-prose in `xyflow` inventory entry) are
  not from this migration — leave them per the surgical-changes
  rule.

## Resuming this work after a compaction

1. Read this file.
2. `ls docs/adr/` to confirm what's actually on disk vs the "done"
   table above.
3. Pick the next outstanding ADR (or ask the user).
4. For inventory-derived ADRs, the source material is the matching
   entry in `plans/technology-inventory.md`. For plan-doc-extracted
   ADRs, the source is the cited phase / section in
   `plans/phased-implementation.md` or `plans/backlog.md`.
5. After writing the ADR, update the inventory / plan-doc to
   shrink the source entry to a pointer (per conventions above),
   and update this checkpoint doc's "done" table.
