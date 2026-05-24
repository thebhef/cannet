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

`<file>.blf.notes.json` exists alongside saved captures today. It was
introduced because `blf_asc` 0.2 supports neither `GLOBAL_MARKER`
writes (no public `BlfWriter` hook for arbitrary object emission) nor
reads (the reader silently drops unrecognised object types), so a
marker authored by us would be invisible and one authored by Vector
CANalyzer is already invisible. Reaching for a sidecar was the wrong
response — the correct one was to contribute the missing API upstream
(the crate is small, 1.6 kloc, MIT/Apache, contribution-friendly).
Returning to compliance is the highest-priority follow-up on this
surface; see `plans/backlog.md` § High priority.

## Consequences

- When a feature needs storage the chosen format does not currently
  expose, the options are: (a) contribute the missing API to the
  format library upstream and use the format's extension mechanism;
  (b) pick a different format; (c) don't store the data. A sidecar is
  not an option.
- Library evaluations (see [ADR 0009](0009-dbc-blf-readers.md) once it
  lands) weigh whether the library exposes the format's extension
  mechanisms — a library that hides them turns this rule into a
  recurring contribution burden.
- The return-to-compliance path for `<file>.blf.notes.json` is:
  contribute `GLOBAL_MARKER` write/read to `blf_asc`; migrate
  `cannet-blf`'s `BlfCaptureWriter` to write markers; one-shot
  read-and-promote of any legacy `.notes.json` on `open_log`; delete
  the sidecar code path; scrub residual mentions of the sidecar (and
  of the phase that introduced it) from active project docs as the
  cleanup lands.
