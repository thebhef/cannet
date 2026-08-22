# ADR 0047 — Persisted signal pyramids

Status: accepted (2026-08-08); amended (2026-08-15) — validity is judged
per signal (global capture gates + a per-signal encoding fingerprint)
rather than by one whole-set key; amended (2026-08-15) — a pyramid whose
definition has gone is retained in a bounded pool rather than deleted;
amended (2026-08-19) — a DBC-backed row's candidate chain is the
databases that may decode the series' bus, not every database that
defines the signal; amended (2026-08-19) — bus assignment governs
decode, so an unassigned database is in no chain and a series that
names no bus has the empty chain; amended (2026-08-19) — the encoding
fingerprint is stamped when a cache is built, not at persist; amended
(2026-08-21) — the fingerprint identifies the **winning** definition
alone, per [ADR 0054](0054-a-decoded-value-has-one-definition.md)

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

Reuse is gated at **two levels**, and the split is the point: the
capture the frames came from is a fact about the whole set, while what a
sample *is* is a fact about one signal.

**Global gates**, recorded in the manifest and recomputed by the session
that wants to adopt it. A mismatch in either discards every pyramid,
files and all:

- **Capture identity.** A `capture_id` minted whenever a capture starts,
  stored beside the project identity that already gates the raw reload
  (DS-7's `identity.json`). It is stable across relaunches of the same
  capture — nothing rewrites the identity on reload — and distinct for
  the next one. A pyramid's decode cursor is a frame index, and a frame
  index is only meaningful within one capture.
- **Eviction low-water.** The raw store's windowed-ring mark (DS-8). The
  pyramid is front-trimmed to follow it, so a pyramid trimmed to one
  mark does not describe a capture retained to another.

**A per-signal encoding fingerprint**, carried by each manifest row and
recomputed against the model now loaded. It is what makes a row's
samples reusable or not, and it is judged **alone**: a match reopens
that pyramid, a mismatch rebuilds that signal and only that signal.

- For a **DBC-backed** row the fingerprint is over the **one
  definition that decodes the series** — the first database assigned to
  the series' bus that defines the signal in that message, or the one a
  per-signal pick names — as the fields a decode actually reads: start
  bit, length, byte order, sign, factor, offset, float kind, mux arm,
  the message's mux gate. Nothing else about the loaded set enters it,
  and nothing about the files the databases were parsed from: not the
  other buses the winner is assigned to, and not the databases behind
  it, neither of which can move a sample
  ([ADR 0054](0054-a-decoded-value-has-one-definition.md); see the
  2026-08-21 amendment). A series that names no bus, or one no assigned
  database defines, has **no definition**: well-defined, and distinct
  from every fingerprint that decodes something.
- For a **file-backed** row it is over the source the samples were
  imported from — path, signal channel group, channel name. No DBC bears
  on such a series, so no DBC-set change may touch it; and none can,
  because every input to its fingerprint is carried in the row itself.
  That matters beyond tidiness: nothing rebuilds one. Its samples were
  read once, at import, from a file that may be long gone.
- A row with **no fingerprint at all** — a manifest written before they
  existed — rebuilds if it is DBC-backed (the model it was decoded
  against is not in the row, so there is nothing to judge it by) and
  reopens if it is file-backed (its fingerprint is a function of the row,
  so its absence hides nothing).

Plus one bound checked rather than keyed, per row: **no decode cursor may
sit past the restored store's tip.** The pyramids are persisted on their
own cadence, so a crash between the raw store's last flush and the
pyramid's can leave a cursor ahead of the frames the store comes back
with — and a cursor ahead of the tip never revisits the frames it
skipped.

**Reopening**, as against judging, stays all-or-nothing within a
provenance: a level file that does not answer to its manifest row means
the directory is not what the manifest says, and trusting the rest of it
on that evidence would be guessing. **Rejection is the safe direction and
is always available** — for a decoded pyramid the raw frames remain the
source of truth — which is what makes an aggressive reuse rule tolerable.

What the invalidated subset then costs is **one shared scan**, not one
per signal. The rebuilt caches come back empty, so the next serve over
their message groups walks each group's frames once for all of them, and
the reopened caches — whose cursors are already at the tip — are skipped
frame by frame and never re-decoded.

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

**A pyramid nothing references any more is parked, not deleted.** The
judgement above says whether a pyramid describes what is loaded now; it
says nothing about whether it will again. A database unloaded for an
afternoon, a signal edited and edited back, a project reopened against
last week's DBC set — in each the samples on disk are exactly what the
returning definition would decode, and deleting them buys back disk at
the price of re-decoding a capture. So a pyramid whose fingerprint no
longer answers to the loaded set moves to a **retention pool**:

- **Bounded in bytes, evict-oldest.** `pyramid_retention_bytes` in
  `settings.json`, default 16 GiB. The unit of parking is not one signal
  but a session's worth of them — unloading a database unreferences every
  pyramid it decoded at once, ~1.6 GB on the reference workload — so a
  bound that holds only one such set would evict the previous set every
  time, which is the case the pool exists for. Oldest first, because the
  pool is a bet on a definition returning and an old park is a bet that
  has been losing for a while. `0` keeps nothing, which is what this ADR
  specified before.
- **Parking renames, it does not copy.** A parked pyramid must not sit
  under the file-name base a rebuild of the same signal would append
  into, so its level files are renamed aside and renamed back on revival.
  Nothing is read or written but directory entries.
- **A revival is the same proof as a reopen.** The pool hands a pyramid
  back exactly when the fingerprint it was parked with matches the set
  now loaded — the judgement is not weakened for being made later, and a
  key that is already live is never displaced by one.
- **The hard gates stay hard.** The pool is discarded whole on a
  `capture_id` or `low_water` change, and a row whose decode cursor sits
  past the restored tip is discarded rather than parked. Those are facts
  about the *frames*: no returning definition can make such a pyramid
  valid again, so keeping it would be keeping something that can only
  ever be thrown away.
- **This applies in-session too.** A DBC-set change judges the live
  pyramids the same way a restore judges persisted ones: one whose
  definition has not moved keeps decoding, one whose has is parked,
  and one the pool can answer for is revived — all in the one call. **A
  cache is stamped where it is created**, against the set that is about to
  decode it, so a pyramid built in the current session parks like any
  other. Stamping only at the next manifest write made this rule true of a
  long-running session and false of one that had just plotted a signal: an
  unstamped cache cannot be judged, and unjudgeable was discarded.

**What the cache is doing is answerable from a log.** Reuse this
aggressive is only worth having if "are we saving time or wasting disk"
can be answered without instrumenting anything, so both halves of it are
reported through the two seams that already exist — no new telemetry
channel:

- **Per restore**, in its breakdown line: signals reopened, revived and
  rebuilt, plus the **bytes** reused and the bytes owed. Counts alone do
  not answer the question — one reopened pyramid over a long capture and
  one over a short capture are the same count and wildly different
  savings — and the honest byte figure is the samples themselves, live
  slots at the stored slot size.
- **Ongoing**, in the health sample's cache accounting: live pyramids,
  how many of them this session has **never read** and what they hold,
  the pool's occupancy against its bound, and the session's revivals and
  evictions. Never-read is the one that catches the failure this
  retention could cause — disk kept for signals nobody looks at — and
  revivals against evictions is what says whether the pool is paying for
  itself or churning.

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

## Amendment (2026-08-19) — the candidate chain is bus-scoped

The decode path now judges every database against the bus a frame
arrived on (`filter::dbc_applies`), the same scoping every other
decode consumer already used. A database scoped to another bus can no
longer supply a value for a series scoped to this one, so it is not a
candidate, so it does not belong in the fingerprint. Before this, a
`ch`-scoped database was mixed into a `pt`-scoped signal's chain, and
editing it forced a rebuild that provably could not change a sample.

`bus_id = None` was the exception at the time of this amendment — a
series whose bus was unknown kept every defining database. The
assignment amendment below retires that case.

The cost is a **one-time rebuild of the affected signals** the first
time a project runs with this amendment: the chain shrank, so the
fingerprint moved, so those pyramids are parked and rebuilt from the
raw frames. Only signals whose chain actually contained a database
scoped elsewhere pay it.

## Amendment (2026-08-19) — bus assignment governs the chain

A database decodes a frame only when the frame's bus is in the set the
project **assigns** it to; an empty set is "assigned to nothing", not
"applies to everywhere" (`filter::dbc_applies`). Two consequences for
the fingerprint, both of which are the bus-scoping amendment above read
under the new rule rather than a second mechanism:

- **An unassigned database is in no chain.** Loading a file, unloading
  it, re-ordering it or editing it moves no fingerprint until it is
  assigned to a bus, because until then it could not have supplied a
  sample. Assigning it is what puts it in the chain — and, from the
  fingerprint's point of view, is indistinguishable from any other
  change that grows a candidate chain.
- **A series that names no bus has the empty chain.** No assignment
  contains "no bus", so nothing is a candidate. The fingerprint is
  well-defined and distinct from every chain that decodes something.

The cost is again a one-time rebuild, and this time it falls on every
project whose databases were relying on the old default: their chains
are empty until the databases are assigned, at which point the chain is
whatever that assignment admits. Pyramids are parked rather than
deleted, so assigning a database back to the bus it used to decode for
hands the samples back rather than re-decoding them.

**Assignment is therefore the cache lifecycle boundary**, and it needs no
machinery of its own: changing a database's buses is a DBC-set change like
any other, so the one in-session judgement above runs — unassigning
empties the chains that database was in and parks what it decoded,
assigning restores them and the pool hands back every pyramid whose
fingerprint the new chain answers for. What revives one is the
fingerprint, not the file: any assigned database that defines the signal
the way the samples were decoded brings them back.

## Amendment (2026-08-21) — the fingerprint identifies the winning definition

[ADR 0054](0054-a-decoded-value-has-one-definition.md) states that a
decoded value comes from exactly one signal definition and that
anything derived from it depends on that definition and **nothing
else**. The fingerprint is bound by part 3 of it, and was not meeting
it. Two inputs come out, and what remains is the winner's decode
specification:

- **The winner's other bus assignments.** They were hashed after the
  eligibility filter had already narrowed the walk to databases
  assigned to the series' own bus, so every one of them decodes a frame
  on that bus identically however else it is assigned. Unchecking an
  unrelated bus parked pyramids whose samples could not move.
- **The candidates behind the winner.** Resolution is first-wins per
  signal, so a database further down the load order supplies no sample.
  Loading one that defines the signal, or editing it, parked pyramids
  whose values were unchanged.

Both faults have the same shape, and it is the one a derived key must
never have: **two states that decode identically hashed differently.**
The amendments above are unaffected — an unassigned database still
decodes nothing and so is still no candidate for anything; what changes
is that eligibility now selects one definition rather than an ordered
chain.

**What this gives up, stated plainly.** `sample_shared` still resolves
per *frame*: where the winning definition withholds a value — a
multiplexor arm that does not match, a payload too short — the next
assigned database can still supply one for that frame. Those samples now
sit under a fingerprint that cannot see the database that produced them,
so editing it does not invalidate them. The chain covered that corner,
at the price of invalidating on every state that could not change a
sample; this is the trade ADR 0054 makes, and the exposure is one
narrow shape (two assigned databases defining the same signal on one
bus, the second reached only through a mux arm, edited without the
first). It is worth naming rather than discovering.

The cost is a **one-time rebuild of every DBC-backed pyramid**: the
hashed encoding changed shape, so no persisted fingerprint matches. Ruled
payable — pyramids are caches, and the spurious rebuilds this ends were
being paid over and over.

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
  the frame count matches" would be guesses. Naming the inputs a pyramid
  depends on makes reuse a proof rather than a bet, and makes each
  rejection explicable.
- **The failure mode of getting it wrong is silent and bad.** A stale
  pyramid does not crash; it draws a plausible wrong plot, or a plot
  that is quietly missing a range of history. That is why every gate is
  conservative in the same direction: a fingerprint covers every input
  to the winning definition's decode and one that only *might* be one (a
  `0.0` → `-0.0` edit that changes no value), a crash-truncated store
  invalidates, and an unjudgeable row rebuilds.
- **The whole-set stamp was the wrong grain.** It read each database's
  path, size and modification time, so a copy, a checkout or a backup
  tool discarded every pyramid in the session for a decode that had not
  changed by a bit — minutes of re-decoding, on evidence about files
  rather than about samples. Naming what a *sample* depends on costs a
  fingerprint per row and answers the question that was actually being
  asked.

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
  Considered and deferred when this ADR was first written, then adopted:
  it does need the parsed model's decode-relevant surface exposed for
  hashing (`Database::signal_decode_specs`), and that turned out to be
  the cheap half. Hashing whole file contents would still be the wrong
  answer — it invalidates on a comment or a `VAL_` relabel, neither of
  which changes a sample. What the fingerprint hashes is the *decode
  spec*, per signal.
- **One fingerprint over the whole parsed set, still whole-set.** Fixes
  the touched-file case and nothing else: an edit to one signal's scaling
  still discards every other signal's pyramid, which on a large session
  is the same minutes for the same reason.
- **Fingerprint the ordered candidate chain rather than a winner.**
  What this ADR said until the 2026-08-21 amendment, on the argument
  that resolution is per frame — a multiplexor arm that does not match,
  or a payload too short, hands the signal to the next database for that
  frame. Rejected because the chain fails the test a derived key has to
  pass: two states that decode identically hashed differently, so a
  second definition that never wins, or an assignment to an unrelated
  bus, parked pyramids whose samples provably could not move. One
  definition is what a value has
  ([ADR 0054](0054-a-decoded-value-has-one-definition.md)); the residual
  per-frame fall-through is named in that amendment.
- **Bound the retention pool as a share of the scratch cap.** Ties two
  budgets that bound different things: the scratch cap bounds the capture
  being worked on, the pool bounds what is kept for a session that may
  never come. A user who raises the cap to hold a longer capture has said
  nothing about how much they want to keep for a database they might
  reload, and an unbounded-scratch project (the default) would have no
  share to take.
- **Keep unreferenced pyramids under their live file names and refuse to
  rebuild over them.** The collision is real — a rebuild of a parked
  signal opens the same `key_prefix` files — and "refuse" would mean a
  signal whose definition changed could never be decoded again while its
  old samples were retained. Renaming aside costs a directory entry and
  keeps both.
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
- The scratch can now hold pyramids **no loaded model references** — up
  to `pyramid_retention_bytes` of them — so a project's cache footprint
  no longer falls when a database is unloaded. That is the trade, it is
  bounded and settable, and what it is buying is visible in the health
  sample beside it.
- Every rejection path costs exactly what it did before: a wipe of the
  rejected rows' files and a rebuild on the next serve. What has changed
  is how much of a set one rejection takes with it.
- A rejection is visible: the restore's system-log line says how many
  caches did not match, its breakdown line carries the
  reopened-vs-revived-vs-rebuilt split with the bytes on each side, and
  the status bar carries a rebuild chip with a discard action
  until the rebuilt caches have caught up. The pyramids the same restore
  reopened are not evidence about that — their cursors came back at the
  tip — so they are left out of the answer. The fast path stays silent: a
  reuse says nothing, which is the point of it.
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
