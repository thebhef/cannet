# Task 84 — Make the MDF's Embedded DBC Durable

Opened by owner ruling 2026-08-16 at cycle-end housekeeping, split out
of the cycle follow-ups as its own feature. **Needs grilling before
any implementation** — the scope below is the problem statement, not
a groomed design.

## Problem

An MDF's embedded DBC attachment already streams into the loaded set
at import: it decodes frames, appears in the Database view and the
signal catalog, under an identity like `<capture>#<name>.dbc`. But it
is session-scoped by construction — it is not added to the project's
DBC list and not persisted with it, because the project's DBC
references are project-relative file paths (ADR 0030) re-loaded from
disk on open, and a `#`-suffixed capture identity has no disk file to
read. Consequences:

- The project panel's DBC list and the loaded set differ after an MDF
  import; closing and reopening the project drops the embedded
  definitions until the capture is imported again.
- Name-matching file-backed signals against DBC definitions — the leg
  the owner deferred "until the DBC can be gotten out of the MDF
  itself (its embedded/external attachments)" — has nothing durable
  to match against.

## Scope (to be grilled)

Make an MDF-carried DBC usable beyond the importing session, then
revisit name-matching on top of it. Open design questions for the
grilling session:

- Extraction to disk (user-visible file the project can reference
  normally) vs. a durable project reference back into the MDF's
  attachment chain — and what happens when the MDF moves or changes.
- Where an extracted file lands, given ADR 0042 §2 (never write into
  a directory the user did not name).
- Whether name-matching then becomes automatic, offered, or stays
  manual.
- Interaction with per-signal cache fingerprints (a DBC arriving by a
  new route must fingerprint identically to the same DBC from disk).

- Enum labels for MDF-imported content. `list_value_tables` resolves
  a DBC-backed signal through the databases scoped to its bus (task
  81); a signal whose bus is unknown falls back to every loaded
  database. MDF content is what reaches that fallback today, because
  those signals have no DBC of their own. When the embedded DBC
  becomes durable, revisit whether they should resolve through it
  instead (owner ruling 2026-08-19).

## Constraints

- ADR 0010 (no sidecar files): whatever persists must not invent a
  companion-file format.
- ADR 0030 (project-relative references) governs how a project names
  the result.

## Exit criteria

Firm at grooming — not before.
