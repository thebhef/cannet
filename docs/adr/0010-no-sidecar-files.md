# ADR 0010 — No sidecar files: data lives inside the file it belongs to

Status: accepted (2026-05-23)

## Decision

Data we want to associate with a file lives **inside** that file. When
the file format provides an extension mechanism — DBC's `BA_` custom
attributes, BLF's `GLOBAL_MARKER` records, and equivalents in any
format we adopt later — we use it freely; that is what those
mechanisms are for, and every reader of the format sees the data
whether or not it interprets it. What we do not do is **create sidecar
files**: separate companion files holding data that logically belongs
to the primary file. The pattern is forbidden.

## Why

Sidecar files split the source of truth. Third-party tools that read
the primary format silently lose half the project's state (Vector's
CANalyzer reads BLF, not BLF + JSON sidecar). The two files drift,
get copied separately, and the sidecar becomes invisible glue that
has to be re-explained to every reader. Worst of all, sidecars
accumulate by precedent — once one exists, the second one looks
reasonable.

In-format custom attributes are categorically different: the data
lives in the file, the format spec defines the carriage, and tooling
reads it for free. Use them.

## Outstanding violation

`<file>.blf.notes.json` exists alongside saved captures today. It
was introduced because the BLF library cannet then used supported
neither `GLOBAL_MARKER` writes nor reads, so a marker authored by
cannet would have been invisible and one authored by Vector
CANalyzer was already invisible. Reaching for a sidecar was the
wrong response — the correct one is to control the BLF
implementation enough to use the format's own extension mechanism,
which is exactly what [ADR 0009](0009-dbc-blf-readers.md) commits
cannet to doing.

The codec prerequisite is now done (Phase 9.5 landed `GLOBAL_MARKER`
read+write in `cannet-blf::format::marker`). The migration work in
`cannet-gui` — read `.notes.json` once on open, promote to BLF
markers on save, delete the sidecar code path — remains as the
highest-priority follow-up on this surface; see `plans/backlog.md`
§ High priority.

## Consequences

- When a feature needs storage the chosen format does not currently
  expose, the options are: (a) contribute the missing API to the
  format library upstream and use the format's extension mechanism;
  (b) pick a different format; (c) don't store the data. A sidecar is
  not an option.
- Library evaluations weigh whether the library exposes the
  format's extension mechanisms — a library that hides them turns
  this rule into a recurring contribution burden, or forces the
  kind of own-implementation decision recorded in
  [ADR 0009](0009-dbc-blf-readers.md) for BLF.
- The return-to-compliance path for `<file>.blf.notes.json` is:
  `cannet-blf` gains `GLOBAL_MARKER` read+write per
  [ADR 0009](0009-dbc-blf-readers.md); migrate `cannet-blf`'s
  `BlfCaptureWriter` to write markers; one-shot read-and-promote
  of any legacy `.notes.json` on `open_log`; delete the sidecar
  code path; scrub residual mentions of the sidecar from active
  project docs as the cleanup lands.
