# ADR 0030 — Project files may reference DBC/RBS files by relative path

Status: accepted (2026-06-22)

## Decision

A project document references its DBCs and its `.cannet_rbs`
simulation configs by path. Those paths may be **relative to the
project file's own directory**, and a relative reference is resolved
against that directory when the project is opened. Absolute references
are honoured as-is.

The GUI writes absolute paths when you add a file through the picker
(it has nowhere else to anchor them). A relative reference is something
you author deliberately — chiefly so a self-contained project that
ships its DBCs and RBS alongside it (the `examples/` projects) opens
correctly from any clone location, not just from whatever directory the
app happened to launch in.

Resolution happens once, on open, before the paths reach the host
commands (`add_dbc`, `rbs_load`) that read straight from disk. Those
commands continue to take a single ready-to-open path; they do not know
about project directories.

## Why

A checked-in example project that named its DBCs by absolute path would
only work on the machine that authored it. The alternative — making the
example load only when the app is launched from the example's own
directory — is a trap: the reference "works" by accident of the
process working directory and breaks the moment anyone opens it the
normal way. Anchoring relative references to the project file's
directory is the one interpretation that is both portable and
launch-location independent.

This stays consistent with [ADR 0010](0010-no-sidecar-files.md): the
DBC and RBS files are first-class inputs the project legitimately
references, not sidecars carrying the project's own state.

## Consequences

- Hand-authored / checked-in projects (the `examples/` set) reference
  their DBCs and `.cannet_rbs` with paths relative to the project file
  and open from anywhere.
- The backend harness already resolves the example's DBC and RBS paths
  against the example directory; this aligns the GUI's open path with
  that behaviour, so both consume the same artifacts the same way.
- Resolution is open-time only. Saving a project through the GUI
  snapshots the host's currently-loaded (absolute) paths — it does not
  re-derive the relative form. Re-saving a relative-path example over
  itself would rewrite its references to absolute; the examples are
  read-mostly, so this is an accepted limitation rather than a feature
  to build.
