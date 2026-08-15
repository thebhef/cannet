# ADR 0047 — Persisted signal pyramids

Status: accepted (2026-08-08)

## Context

A plotted signal's decoded samples live in a per-signal **resolution
pyramid** on disk ([ADR 0002](0002-disk-spill-store.md) DS-5): mmap'd
append-only runs of `(t_seconds, value)` pairs, built by decoding the
signal's frames once and folding min/max buckets upward. Building one is
`O(that id's occurrences)` — cheap per frame, but the occurrences of a
plotted signal over a multi-million-frame capture are millions.

ADR 0002 classified the pyramid as *derived* state that "carries no
manifest" and is "rebuilt from the reopened frames on serve". The
practical consequence, on a real workload: a 6.53 M-frame capture
reloads in about a second (DS-7's reopen is `O(segment files)`), and
then the first plot over it sits on the `building…` placeholder for
**minutes** while every pyramid rebuilds from frame zero. Every
relaunch pays it again. The samples were on disk the whole time; what
was missing was any way to prove they still described the capture.

"Derived" was doing two jobs in that classification. It is true that the
raw frames are the source of truth and a pyramid can always be rebuilt
from them — that is a correctness property and it stays. It does not
follow that a pyramid *should* be rebuilt whenever the process restarts;
that is a cost decision, and it was made implicitly, by never writing
down what a pyramid is a pyramid *of*.

## Decision

**Signal pyramids survive the session that built them, and are reused on
the next launch when — and only when — they provably still describe the
model.**

A `pyramids.json` manifest in the pyramid scratch records, per cached
signal, its key, its decode cursor, its all-time value extent, and each
level's `(len, first_slot)`. That is all a level needs to be mapped back:
the segment chain's geometry is deterministic in its length, so no level
carries a manifest of its own.

Reuse is gated on a **validity key**, recorded in the manifest and
recomputed by the session that wants to adopt it. It has three
components, one for each way a pyramid can stop describing the model
without the pyramid itself changing:

- **Capture identity.** A `capture_id` minted whenever a capture starts,
  stored beside the project identity that already gates the raw reload
  (DS-7's `identity.json`). It is stable across relaunches of the same
  capture — nothing rewrites the identity on reload — and distinct for
  the next one. A pyramid's decode cursor is a frame index, and a frame
  index is only meaningful within one capture.
- **DBC set.** A fingerprint over each loaded database's path, its bus
  scoping, and its load position (which is decode priority), plus the
  file's size and modification time. A pyramid holds *decoded* samples;
  a changed set decodes different values, or decodes a signal the old
  set could not ([ADR 0033](0033-model-layer-build-order.md)).
- **Eviction low-water.** The raw store's windowed-ring mark (DS-8). The
  pyramid is front-trimmed to follow it, so a pyramid trimmed to one
  mark does not describe a capture retained to another.

Plus one bound checked rather than keyed: **no decode cursor may sit
past the restored store's tip.** The pyramids are persisted on their own
cadence, so a crash between the raw store's last flush and the pyramid's
can leave a cursor ahead of the frames the store comes back with — and a
cursor ahead of the tip never revisits the frames it skipped.

Anything that does not match, and any level file that does not answer to
its manifest row, discards the whole set — files and all — and the next
serve rebuilds exactly as before. **Rejection is the safe direction and
is always available**, which is what makes an aggressive reuse rule
tolerable: the raw frames remain the source of truth.

**A rejection is announced, and the user may decline to pay for it.**
Reuse being the normal case is what makes the exception worth saying out
loud: a launch that discards its set restores the frames in a second and
then spends minutes re-decoding them, which — silently — reads as the
application being broken rather than as work being done. So the host
records the discard where it happens (the wipe leaves no other trace of
it), reports it as a fact the frontend can read and re-read, and the
frontend announces it for as long as the caches are behind the capture's
tip. Beside the announcement is the way out: **drop the restored capture
instead**. It runs the same session clear a new capture runs — one
deletion path, not a second one — so what is left is an empty session,
with the project, its DBCs, the layout and the server configuration
untouched. The offramp needs no cancellation of its own: a rebuild is
already abandonable mid-flight ([ADR 0048](0048-no-model-lock-across-a-rebuild.md)),
and the clear is one of the paths it yields to.

**The level pages are flushed synchronously, and the manifest is written
after them — on a periodic cadence and once more at exit.** The pyramid
is part of the cache, and the cache's shutdown flush covers all of it
(ADR 0002 DS-2); a manifest that outran its own pages would describe
bytes the disk was never given, and the validity key cannot detect that
— it proves the pyramid describes the right capture, not that its bytes
are on the platter. So the flush comes first, and the manifest second.

What makes that affordable is that **a flush is incremental**. A level
run records the slot it last flushed to and waits on the device only for
the segments it has not yet covered. Flushing the whole of a
freshly-built pyramid in one go costs seconds — which is a cost the exit
path must not pay ([ADR 0048](0048-no-model-lock-across-a-rebuild.md)) —
but that is the cost of never having flushed, not the cost of flushing.

**The periodic caller takes only what has come to rest, and only so much
of it per tick.** The two restrictions are separate and both load-bearing:

- **Sealed segments only.** A level's chain grows by whole segments, so
  every append lands in the same *hot tail* until it fills. Waiting on
  that file is worse than useless: the pages are dirty again before the
  next tick, so the cost recurs forever and the residue never shrinks.
  Waiting on a segment the chain has grown past costs once, ever.
- **A budget per tick.** Sealing is bursty — the plotted signals of one
  bus share a rate, so their chains cross a boundary on the same tick —
  and each wait is a device barrier that everything else on the volume
  queues behind. A tick that took them all would land as one stall in
  the middle of a live capture, which is a receive-cadence defect, not a
  durability feature. What the budget defers is immutable, so it is
  still there, and no larger, on the next tick.

The budget is a function of whether frames are arriving. It exists to
protect a receive cadence; a stopped capture, a finished import or a
restored session being plotted has none, so an idle tick takes far more
and drains a rebuild's backlog while the user works rather than leaving
it for the quit.

Two exposures follow, both narrow and named. A **power loss** can lose
the appends since the last flush — what that costs is a rebuild's worth
of samples in a *derived* structure, whose raw frames are flushed
synchronously on the same exit path. And **quitting within a minute or
so of a large rebuild** still pays for it: a pyramid built in seconds
outruns any cadence, and the shutdown flush is what covers the case the
cadence has not reached yet. That is the trade this ADR makes on
purpose — the wait belongs on the path the user has already decided to
leave, not on the one where frames are arriving.

Two lifecycle rules complete it:

- **A new capture wipes the pyramids**, including anything a prior
  session left staged. That is Clear, connect, and a file import alike —
  they all run through the same "a capture is starting" restamp.
- **A DBC-set change drops the live pyramids but leaves a *staged* set
  alone.** A staged set is not decoded state yet; it is a candidate
  whose own recorded DBC fingerprint is part of the check about to be
  made. This matters because of boot order: a project's DBCs load
  *before* that project's capture is restored, so wiping on the boot-time
  load would mean no persisted pyramid could ever be reused. Once a set
  has been adopted it is live like any other, and the next DBC change
  wipes it.

## Why

- **The cost is asymmetric and the data was already there.** The rebuild
  is minutes; the reuse is a directory of `mmap` calls. The disk retained
  between sessions is the pyramid size — proportional to how many signals
  have been plotted, ~230 MB on the reference workload — in a scratch
  directory the user can already reclaim per project (DS-7), and which
  already holds a raw capture an order of magnitude larger.
- **The scratch already survives exit; the pyramid was the exception.**
  DS-7 keeps `cache/` across a process exit precisely so a launch can
  present the prior session. Every other family in it — raw frames,
  by-id, the filter index — is reload-compatible by construction. The
  pyramid's exclusion was not a property of its format (it is
  append-only mmap'd runs like the rest); it was the absence of a
  validity key.
- **A key beats a heuristic.** "Reuse if the file looks recent" or "if
  the frame count matches" would be guesses. Naming the three inputs a
  pyramid depends on makes reuse a proof rather than a bet, and makes
  each rejection explicable.
- **The failure mode of getting it wrong is silent and bad.** A stale
  pyramid does not crash; it draws a plausible wrong plot, or a plot
  that is quietly missing a range of history. That is why the key is
  conservative (a cosmetic DBC edit invalidates, a crash-truncated store
  invalidates) and why rejection is all-or-nothing.

## Alternatives considered

- **Keep rebuilding, but make it incremental / backgrounded.** Doesn't
  address the cost, only its visibility — the CPU is still spent, every
  launch, decoding samples that are already on disk. (Painting
  incrementally during a rebuild is worth doing on its own merits, for
  the rebuilds that genuinely do have to happen.)
- **Key on the raw store's frame count alone.** Cheap, and wrong: two
  different captures of the same length collide, and it says nothing
  about the DBC set.
- **Key on the DBC file *contents* rather than path + size + mtime.**
  More precise — a cosmetic edit would not invalidate — but it needs the
  parsed model's decode-relevant surface exposed for hashing, and the
  gain is avoiding a rebuild after an edit that changed nothing. Not
  worth the API surface today; the fingerprint is a single function to
  revisit if it proves too eager.
- **Persist the pyramid inside the raw store's own manifest.** Couples
  two families with genuinely different write cadences: the pyramids
  move when a plot is served, the raw store when frames arrive. A
  stopped restored capture extends its pyramids while the raw store
  never changes — the exact case this ADR exists for.
- **Rename the pyramid directory aside at boot so the DBC-load wipe
  cannot reach it.** Solves the boot-order problem with a filesystem
  trick instead of by saying what the wipe is *for*. Distinguishing "the
  live decode state is stale" from "this candidate has not been judged
  yet" is the honest fix and needs no second directory.

## Consequences

- A launch over a restored capture paints its plots from the pyramid on
  disk; `building…` appears only for signals that were never plotted in
  the prior session — and then only until their first points arrive
  ([ADR 0049](0049-bounded-serves-and-partial-answers.md)).
- The scratch keeps the pyramid bytes between sessions. They are inside
  DS-8's cap like everything else in `cache/`, and the windowed-ring
  eviction trims them with the raw store.
- Every rejection path costs exactly what today costs: a wipe and a
  rebuild on the next serve. There is no half-adopted state.
- A rejection is visible: the restore's system-log line says the caches
  did not match, and the status line carries a rebuild chip with a
  discard action until the caches have caught up. The fast path stays
  silent — a reuse says nothing, which is the point of it.
- Exit hardens the pyramid scratch alongside the trace store's own
  synchronous shutdown flush (DS-2), and what it costs falls as the
  cadence works through the sealed segments — to milliseconds for a
  session that has been running, and to what the cadence has not reached
  yet for one that quits straight after a rebuild.
- A live capture's flush tick costs what the raw store's own periodic
  flush costs, by construction, because that is what the budget is set
  against.
- `cannet-spill`'s sample sequence gained a reopen path. It still carries
  no manifest of its own — `(len, first_slot)` from the caller's manifest
  is enough to map it back — because the caller is what decides validity.
