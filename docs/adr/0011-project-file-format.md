# ADR 0011 — Project file is a single JSON document; the dockview layout is stored verbatim

Status: accepted (2026-05-23)

## Decision

A project is a single JSON file with explicit open and save
operations. It carries the panel layout, the project's elements
(`trace` / `plot` / `transmit` / `filter`), the logical buses and
interface bindings, the loaded DBC references with per-DBC bus
scoping, and the remote-server address. DBCs are **referenced by
path** — the project never embeds the DBC content, so reloading from
disk picks up the user's edits.

The `dockview` panel layout is one field — `layout: serde_json::Value`
— and the host **does not interpret it**. It is stored verbatim and
round-tripped between disk and frontend; the per-panel UI state that
lives in dockview's `params` (trace column layout, plot cursors and
measurements, sort/scroll, panel mode toggle, etc.) rides along inside
that blob.

The file carries an explicit `schema_version`. When the shape changes
incompatibly the version bumps and a migration runs on parse; the
next save rewrites the file at the new version. A file from a newer
build is rejected rather than misread.

## Why

**JSON, not a binary format.** The project is human-readable,
version-controllable, and grep-able; it changes rarely, is small, and
reading it is not on any performance path. JSON also lets the
dockview blob and our schema share one document.

**`serde_json` and not a new crate.** `serde` / `serde_json` were
already in the dependency graph via Tauri's IPC; using them for the
project file added no new dependency.

**Dockview layout verbatim, not normalised.** The library owns the
shape — split sizes, tab orders, group geometry, panel kinds — and
replicates them faithfully on `fromJSON`. Re-encoding it into our own
schema would mean keeping the two structures in sync forever or
losing whichever fields dockview adds in future versions. Verbatim is
the cheap, future-proof shape; the cost is that the host treats
`layout` as opaque.

**Not a sidecar.** The project file is a first-class file the user
creates and owns. [ADR 0010](0010-no-sidecar-files.md) governs what
*isn't* allowed alongside a format file we don't own; the project
file is in a different category.

## Consequences

- Adding fields means bumping the schema version and adding a
  migration step. Version history is documented in place.
- The "host doesn't interpret the layout" rule has one documented
  exception: schema migrations that need to reach into the dockview
  blob walk it deliberately and locally. That is the only time the
  host parses the blob's shape.
- The schema version is defined in both TypeScript and Rust; they
  must stay in lockstep. They currently do not — see
  `plans/backlog.md`.
- When dockview is one day swapped (it sits behind a thin adapter —
  see [ADR 0005](0005-dockview-panel-layout.md)), the on-disk
  `layout` field can either migrate forward or be re-derived from
  project state. Both paths are bounded because nothing else in the
  system reads the blob.
