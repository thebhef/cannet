# ADR 0049 — A serve is bounded; a partial answer is first-class

Status: accepted (2026-08-09); amended (2026-08-15) — the budget is spent
in *rounds* across the batch's message groups, not group by group

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

## Decision

**A serve of derived state is bounded, and it reports whether its answer
is the whole answer.**

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
