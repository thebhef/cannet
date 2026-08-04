# ADR 0030 — Project files may reference DBC/RBS files by relative path

Status: accepted (2026-06-22)

## Decision

A project document references its DBCs and its `.cannet_rbs`
simulation configs by path. Those paths may be **relative to the
project file's own directory**, and a relative reference is resolved
against that directory when the project is opened. Absolute references
are honoured as-is.

**A reference to a file inside the project directory is written
relative; everything else is written absolute.** That is the rule in
both directions — the GUI stores what it can anchor and leaves the rest
alone. So a self-contained project that ships its DBCs and RBS
alongside it (the `examples/` projects, and now any project directory)
opens correctly from any clone location, not just from whatever
directory the app happened to launch in, and a project directory is
movable and shareable as a unit.

Containment is decided on the path text, not by asking the filesystem —
the renderer, which does this, has none. A reference the test is unsure
about stays absolute, which is always correct. Nothing climbs out with
`../`: a reference that escaped the project directory would break the
moment the directory moved, which is the very thing the relative form
exists to survive.

Resolution happens once, on open, before the paths reach the host
commands (`add_dbc`, `rbs_load`) that read straight from disk, and the
inverse rewrite happens once, on save. Those commands continue to take a
single ready-to-open path; they do not know about project directories.

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
- Re-saving a relative-path example over itself keeps its references
  relative. That was not true when the GUI wrote absolute paths
  unconditionally: a save rewrote every reference to a machine-local
  absolute path, which is why the `relativize-project-paths` pre-commit
  hook exists. The hook stays as the backstop — it relativizes anything
  inside the *repository*, a wider net than the project directory — but
  it should now have nothing to do.
- The rule applies to what the project *stores*. In memory the host and
  the frontend still work in absolute paths throughout; the translation
  happens at the project-document boundary, on open and on save.
