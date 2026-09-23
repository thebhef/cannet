# ADR 0049 — A serve is bounded; a partial answer is first-class

Status: accepted (2026-08-09); amended (2026-08-15) — the budget is spent
in *rounds* across the batch's message groups, not group by group;
amended (2026-09-23) — the rule is general (any command, any derivation),
foreground polls never drive unbounded derivation, and a regression guard
names every synchronous command

## Context

A view's data arrives through a host command. Most of those commands
read state that already exists. A few have to *build* it first: the
plot's per-signal decimation pyramid
([ADR 0002](0002-disk-spill-store.md) DS-5,
[ADR 0047](0047-persisted-signal-pyramids.md)) is caught up from the
last frame it decoded to the capture's tip before the window is served.
In steady state that is a tick's worth of frames. On the first use of a
signal over a long capture it is the whole history.

[ADR 0048](0048-no-model-lock-across-a-rebuild.md) chunked that work and
took it off the model lock, which fixed everything that had been queued
*behind* it — other plots, eviction, the exit path. It did not change
what the calling plot saw: the command still ran chunk after chunk until
the cursor reached the tip, so its own answer was one finished series
minutes later. The plot showed an indeterminate `building…` placeholder
for the whole time, with no way to tell a slow rebuild from a hung one,
and a plot open during a file import stopped updating for the same
reason.

The samples exist the entire time. Nothing about the first chunk's
points is provisional — they are exactly the points the finished series
begins with. What was missing was a way to say "here is what I have, and
there is more".

## Context — the same shape, three more times (2026-09-23)

This ADR was written for one cache. The shape it describes turned out to
be general, and the places that did not follow it were found by an audit
of every host command and every frontend poller:

- **The logger folder listing** scanned the header of every `.blf` it had
  no cached metadata for, inline, while the file grid re-asked for the
  listing four times a second. A scan is 7.2 s for a 492 MB file and
  24.8 s for 1.2 GB (local NVMe, release); the cache filled only after a
  scan finished, so every poll during one started another full read of
  the same file. The machine saturated, the list never converged, and a
  reopened panel came up empty.
- **The project cache list** walked every registered cache directory to
  size it, on the IPC thread, every time the settings view was shown.
- **The filtered trace's index** rebuilt over the whole capture under the
  mutex that serves its pages, so every other filtered fetch parked a
  runtime worker on that lock for the rebuild's duration.
- **`useHostMirror`**, the shared frontend poller behind the logger file
  grid, the RBS panel and the transmit panel, had no in-flight guard and
  no ordering check: a fetch slower than the poll interval produced one
  more request per tick, and responses could land out of order.

None of these were "the signal cache", and none of them were on the IPC
thread except the cache walk. What they had in common was the rule this
ADR states.

## Decision

**A serve of derived state is bounded, and it reports whether its answer
is the whole answer.**

**This is a rule about every command and every derivation, not about the
signal cache.** Concretely, and binding on new code:

- **A command answers with what exists.** Work whose duration scales with
  a directory, a file, a capture or a folder is not done inside the
  request that noticed it was missing. The request returns the state it
  has, marked as incomplete where it is, and the derivation runs as a
  background job. `list_logger_files` is the reference case: it returns
  stat data at once, and a file whose header is not cached lists with its
  trace columns pending.
- **A background job is single-flight per key, and announces itself.**
  One scan per unscanned file, one walk per cache list, however many
  overlapping requests name it; a finished job emits an event and the
  view re-asks. Deduplicating by key is what makes a polled view safe:
  the cost is the number of *things*, never the number of *requests*.
- **A foreground poll never drives unbounded derivation.** A view's
  cadence may not decide how much work the host does. If a poll can
  trigger derivation, that derivation is a deduplicated background job —
  otherwise the poll's interval becomes a work multiplier.
- **One request in flight per poller, newest answer wins.** A tick that
  finds its own request still out marks the view stale instead of issuing
  another, and exactly one refetch follows when it lands; an answer that
  has been superseded is dropped rather than applied. `useWindowedQuery`'s
  `fetching` + `pending` coalescing is the reference implementation, and
  `useHostMirror` now shares it.
- **Pending is not empty, and not zero.** A column with no answer yet says
  so; a measured zero and an unmeasured value are different facts, and a
  view that renders them the same way is lying about one of them.
- **The guard is a test, not a convention.** `command_surface`'s
  allow-list test reads the crate's own sources, lists every
  `#[tauri::command]` that is not `async`, and fails on one the list does
  not name. Tauri runs a synchronous command on the webview's IPC thread,
  so "is it `async`" is a *declaration* nothing can be asked at run time —
  the check has to read the source. A new command that walks a directory
  therefore cannot land synchronous unnoticed: adding it to the list is a
  deliberate act with a reason written beside it.

- **Bound the call in wall-clock time, not in work.** The signal cache
  catches up for at most `CATCH_UP_SERVE_BUDGET` (150 ms, about a plot's
  resample period) and then serves what it has. A work bound — N chunks
  — is deterministic but wrong: a chunk of a *rare* message decodes
  almost nothing, so a fixed chunk budget would need hundreds of
  round-trips to walk a capture it could scan in seconds. Time
  self-adapts: cheap chunks, many per serve.
- **Spend the budget across the batch, not down it.** A serve's step is a
  *round*: every message group that is still behind the tip scans one
  chunk, and only between rounds is the budget checked. So a serve
  overruns by at most a round, always advances every cursor it touched,
  and — the part a per-group spend got wrong — advances them *equally*.
  A batch's per-group throughput must not divide by its group count:
  the frames a round materializes are the frames of that chunk of
  capture however many groups they are shared between, so a serve
  carrying sixteen messages walks each as far as a serve carrying one.
  Spending group by group instead pinned every group after the one that
  exhausted the budget to a single chunk per serve, which a capture
  growing faster than a chunk per serve outruns forever.
- **Carry a completeness token in the response, and make it the only
  evidence of completeness.** A non-empty result never means "finished":
  under ADR 0048 a caller can observe a series mid-rebuild anyway. The
  token is a model fact, computed by comparing each queried cursor with
  the tip *this serve read*, and it travels on the accessor's own
  response (`DecimatedRange.complete`, [ADR 0025](0025-frontend-windowed-source-contract.md)).
- **The view re-requests; it does not poll.** A partial answer is drawn
  immediately and does not satisfy the fetch memo, so the view's existing
  self-paced fetch loop issues the next request. No loop of its own, no
  accumulation across responses, no completeness re-derived in the
  frontend — the cache is authoritative on every call.
- **A wait indicator ends at first paint, not at completion.** "There is
  something to look at" and "the host has finished" are two moments; the
  placeholder belongs to the first. An answer with no points that is
  *not* the host's final word is not an outcome — it is the wait, still
  going.

## Why

- **The growing picture is the progress report.** A determinate progress
  bar was considered and rejected: the host discovers the work while
  doing it, so a percentage would need a progress channel of its own, and
  a plot that visibly fills in tells the user more than a bar does.
- **Partial is the honest description of what already happens.** Once a
  rebuild runs off the lock, a serve that slots between two chunks sees a
  prefix. The alternative to naming it is a caller that quietly guesses
  from a non-empty result — which is wrong for a signal that genuinely
  has no samples yet, and wrong again for one that has some.
- **Bounding the call is what bounds the *view's* latency.** ADR 0048
  bounded the lock hold, which is a different quantity: it is why the
  rest of the app kept working, not why this plot answers.
- **The token has to be per-response, not per-signal state.** Completeness
  is a fact about one serve against one tip; a live capture's tip moves.
  Answering "is this series complete" out of band would mean a second
  round-trip that can disagree with the one that returned the points.

## Consequences

- A cold plot paints within about a resample period and fills in from
  there. `building…` is visible only until the first points exist.
- Plots keep painting during a file import, because the serve no longer
  runs to a tip the pump is still moving.
- The same request is issued repeatedly while a rebuild runs — bounded by
  the view's own fetch cadence, and each one returns strictly more than
  the last. The per-serve overhead is one lock round-trip and one window
  read per signal, negligible beside the decoding.
- The y-extent sidecar (`signal_min_max`) is bounded by the same budget
  and widens as the rebuild advances, exactly as it does while a live
  capture grows. It carries no token of its own: it rides the same
  round-trip as the window that does.
- An area holding many message groups keeps up with a live capture as
  well as an area holding one. That is what a per-unit panel needs: its
  enum lanes all share a single axis, so the lanes area is structurally
  the one with the most groups on the panel, and it is also the one the
  panel's pacing leaves longest between serves.
- A group that has reached the tip leaves the rotation, so the rest of
  the serve goes to whichever groups are behind — a signal added to an
  area that is already current gets the whole budget for its backfill
  rather than a chunk of it.
- Rounds cost one extra index lookup and lock round-trip per group per
  round, both `O(log n)` or less beside the chunk's decoding.
- Every future derived-state serve inherits the rule. A command that
  cannot answer inside its budget answers partially and says so; it does
  not make the caller wait.
- A view that shows pending state needs somewhere to put it. That is
  view-local (CLAUDE.md § GUI architecture) — the *fact* that a row is
  pending is the host's, and travels on the row.
- The single-flight guard changes when a poller's second fetch lands: it
  is one round trip after the first, not one interval after it. A test
  that counted requests per interval counts them per answer now.
- Deduplicating a background job by key means a request made while the
  job runs is answered by that job, not by a second one. The result a
  caller reads may therefore have been planned slightly before its own
  request — which is [ADR 0048](0048-no-model-lock-across-a-rebuild.md)'s
  "treat the plan as a hint", and the same discipline applies: the job
  re-reads live state where it matters rather than trusting what it was
  planned against.
