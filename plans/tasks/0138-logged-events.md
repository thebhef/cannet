# 0138 — Events in Logged BLFs

> **Opened 2026-09-06** from owner instruction while task 137 closed
> out ("we need to make sure events get written into the blf as
> well"). Groomed 2026-09-06; all design questions ruled.

The export path already writes user-authored timeline events into the
BLF as `GLOBAL_MARKER` records carrying the `cannet-event/1` block
(ADR 0057). The project logger (task 137) streams frames through the
same `BlfCaptureWriter` and writes no events at all. Close that gap —
and settle how edits the user makes after a marker is written
propagate into an append-only streaming file.

## Grooming notes

**2026-09-06 (owner rulings):**

1. **Live append, history in the file.** Markers are written the
   moment an event is created *and* on every subsequent edit — not
   buffered to part close, not patched in place (BLF is append-only
   while streaming and the text block is variable-length). The file
   accumulates the revision history; ingest reconstructs the current
   state from it; a re-export from the corrected model writes the
   clean, collapsed file. Rejected: write-at-part-close (edits after
   close would be lost silently); append-then-rewrite-on-close (close
   cost is a full part rewrite on multi-GB logs).
2. **Fresh id per revision, chained by `edited:`.** Each superseding
   marker carries a newly minted id and an `edited: <prior-revision-id>`
   key naming the revision it replaces. Rejected: same-id-last-wins
   (no explicit chain); reusing `link:` (ADR 0056's untyped links
   cannot distinguish "supersedes" from a user's own event-to-event
   link).
3. **Deletion is a tombstone revision.** Deleting an event appends a
   marker with a fresh id, `edited:` naming the last written revision,
   and a `deleted` key. It carries the event's last label as the
   marker name, so a foreign reader sees a final marker rather than
   nothing; ingest reads the chain as dead (absent from the model,
   history retained); re-export writes nothing for it.
4. **Accepted design corollaries** (recommended 2026-09-06, owner
   accepted):
   - The chain is a *file encoding*, not a model change: the session
     event keeps its one stable id; the logger tracks per event the
     id of the last revision it appended. The first marker written
     for an event carries the session id.
   - Cross-part chains may dangle: an event created during part 1 and
     edited during part 3 leaves the revision in part 3 with `edited:`
     pointing into part 1. Ingesting all parts resolves it; ingesting
     one part keeps the reference unresolved — a state, not a fault,
     exactly ADR 0057's dangling-`link:` rule.
   - Ingest collapses to current state: chains group via `edited`,
     the chain head is the live event, user `link:` references
     resolve through the chain so links to superseded revisions still
     land. History stays available for rendering.
   - Re-export writes collapsed state only — one marker per live
     event, no chains. (The export path already writes from the
     session model, which is collapsed by construction; this is a
     test obligation, not new code.)
   - Additive keys under the existing `cannet-event/1` header — no
     version bump. A `/2` header would make older builds read the
     whole block as prose (the split-at-recognised-header rule),
     strictly worse than an unknown key the parser already keeps
     verbatim.
   - Foreign tools show every revision as its own marker. Inherent
     to live append; the user's re-export is the cleanup path.

**Resolved from existing ADRs (not new rulings):**

- Which kinds: **user-authored only** (note, message-bound), per
  ADR 0035's source categories. Host-derived (busError, trigger) and
  frontend-derived (truncation) events never reach the file — same
  boundary the export path already enforces.
- A revision marker carries the event's *current* timestamp (so a
  time edit moves the marker), clamped to the open part's
  representable range through the writer's existing clamp machinery —
  BLF timestamps are unsigned offsets from the file's start, and the
  open part's start is fixed when it opens.
- Markers are written into whichever part is open when the change
  happens; closed parts are never reopened or rewritten.

## Phases

**Phase 1 — Revision grammar and the corrected read** (host:
`event_text.rs`, `capture.rs` read path; new ADR). Serialize and
parse `edited:` and `deleted:`; BLF ingest groups revision chains,
admits chain heads only, drops dead chains from the model while
keeping history, resolves `link:` references through chains, keeps a
dangling `edited:` unresolved. Foreign markers and unknown keys still
round-trip unharmed. Prove the re-export collapse: a chain-carrying
file, imported then exported, emits one marker per live event. The
ADR recording rulings 1–4 lands here, cross-referenced from ADR 0057.

**Phase 2 — The logger writes events** (host: `logger.rs`, the event
store's change surface). The running logger appends a marker on
create, edit, and delete of a user-authored event: first write with
the session id, revisions with fresh ids and `edited:`, deletion as
the tombstone. Per-run map of event id → last-written revision id;
timestamps clamped per part; chains crossing split parts exercised;
derived kinds proven absent. Tests over generated runs, no hardware.

## Exit criteria

- [ ] A capture logged live — events created, edited, and deleted
      during the run — reopens (all parts imported) with exactly the
      current event set; re-export writes one collapsed marker per
      live event and nothing for deleted ones.
- [ ] Importing a single mid-run part keeps its dangling `edited:`
      references as unresolved state, not an error.
- [ ] Foreign markers, prose mentioning `cannet-event`, and unknown
      keys from later schema versions still round-trip unharmed.
- [ ] Host-derived and frontend-derived events never appear in a
      logged file.
- [ ] The ADR is recorded and ADR 0057 points at it; docs match the
      shipped behaviour.

## Status log

(none yet)

## Blockers / side effects

(none yet)
