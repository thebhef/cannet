# ADR 0048 — No model lock is held across a rebuild

Status: accepted (2026-08-09)

## Context

The host owns the model and the GUI renders windows onto it, so every
view's data arrives through a host command that locks some part of the
model. Most of those holds are microseconds. A few are not.

The per-signal decimation pyramid ([ADR 0002](0002-disk-spill-store.md)
DS-5, [ADR 0047](0047-persisted-signal-pyramids.md)) is the extreme
case. Its **catch-up** decodes every frame of a message that arrived
since the series was last served. In steady state that is a tick's worth
of frames. On the first use of a signal — a plot opened over a long
capture, or one whose persisted pyramid did not validate — it is the
whole history: minutes of fetching and decoding.

That catch-up ran with the signal-cache mutex held from the first frame
to the last. The consequences were not local to the cache:

- One cold area's rebuild serialized **every other plot's** serve, and
  the y-extent sidecar (`signal_min_max`) queued behind the same lock.
- The periodic flusher's `evict_below` — the front-trim that keeps the
  scratch footprint under its cap — parked on it, so the cap was not
  enforced for as long as a rebuild ran.
- Each stalled command was an `async` Tauri command doing synchronous
  work, so it also **parked a tokio worker**. With one such command per
  plotted area, the async runtime ran out of workers and the close
  path's own command could not be dispatched: the window could not be
  closed while the plots were building.

The last item is the one that made this a correctness problem rather
than a latency problem. A user could not exit the application.

## Decision

**No lock over host model state is held across work whose duration
scales with the capture. Long derived-state work is done off the lock,
in bounded steps, with the lock taken only to read the step's inputs and
to commit its results.**

Concretely, for any rebuild of derived state:

- **Chunk it.** The work is split into steps of bounded size (the
  signal cache's is `CATCH_UP_CHUNK_FRAMES` store frames), so every
  hold is bounded by a step, not by the capture.
- **Plan under the lock, work off it, apply under it.** A step reads
  the cursors it needs under the lock, releases, does the fetching and
  decoding holding nothing, then re-takes the lock to append.
- **Treat the plan as a hint.** By the time a step applies, another
  caller may have advanced the same cursor. The commit re-applies the
  same gate against the live cursor and drops what is already covered —
  it never trusts the snapshot it planned from.
- **Version the set, and abandon rather than guess.** Any operation
  that replaces the collection wholesale (clear, re-root, restoring a
  persisted set) bumps a generation counter. A step whose generation no
  longer matches discards its results instead of appending them: they
  describe state that no longer exists, and appending them to whatever
  took its key would mix two captures into one series.
- **A command that does synchronous, capture-scaled work runs off the
  async runtime's workers**, on the blocking pool. An `async fn`
  command that never yields is a worker held for the duration, and the
  close path needs a worker.

## Why

- **Granularity, not parallel structure, was the defect.** Per-key
  locking or a lock-free map would also let two areas proceed, but they
  do nothing about the operations that legitimately touch *every* series
  — eviction, the manifest write, the clear on exit. Those still have to
  wait for the series being rebuilt. Bounding the hold fixes all of them
  at once, including the ones that are the exit path.
- **It keeps the atomicity that already exists.** Every mutation of the
  cache set still happens under the one lock, so re-rooting still moves
  the root and the caches together, and the eviction front-trim is still
  atomic with respect to the fold cursor. A design that hands out
  per-entry handles has to re-establish both, and has to answer what
  happens when the set is wiped while a handle is outstanding (on
  Windows, a mapped file cannot even be deleted). The generation counter
  answers that question once, for a set that is never handed out.
- **The expensive part is where the parallelism matters.** Fetching and
  decoding is essentially all of a rebuild's cost; the append is a
  memcpy into a mapped page. Moving the decode off the lock lets two
  cold areas rebuild on two cores while their appends interleave — the
  same concurrency a per-entry design buys, without the handles.
- **The exit contract is testable at the seam.** "The window closes
  during a rebuild" reduces to: with a rebuild blocked mid-step, the
  operations the close path performs complete on their own. That is a
  would-block probe over threads and channels, not a UI test.

## Consequences

- The longest hold of the signal-cache lock is one chunk's appends and
  fold — milliseconds — instead of a whole rebuild.
- A concurrent caller can observe a series **mid-rebuild**: a serve that
  slots in between two chunks sees the points decoded so far. That is a
  visible change from the previous all-or-nothing serve, and a caller
  that needs a complete series must not infer completeness from a
  non-empty result.
  [ADR 0049](0049-bounded-serves-and-partial-answers.md) takes that
  consequence the rest of the way: a serve is bounded in time and says
  whether its answer is the whole answer.
- A rebuild interrupted by a clear / re-root / restore discards its
  in-flight step. The work is lost, not corrupted, and the next serve
  starts a fresh rebuild against the new set.
- Commands that do capture-scaled synchronous work are dispatched to the
  blocking pool. They still take as long; they no longer make the app
  unresponsive to *other* commands while they do.
- This rule is about model locks, not about the trace store's own append
  lock, which is held per frame and is bounded by construction.
