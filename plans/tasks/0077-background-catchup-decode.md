# Task 77 — Catch-Up Decode Off the Serve Path

Opened by owner ruling 2026-08-15 out of Task 72 phase 3's
attribution ("1 and 3 seem worth doing" — this is shape 3; shape 1,
the batched chunk scan, lands as Task 72 phase 5 and is this task's
prerequisite baseline).

## The mechanism this replaces

Task 72 phase 3 attributed the enum leading-edge lag: signal decode
catch-up happens inside a plot serve, under one budget per serve,
one chunk per `(message_id, extended)` group — so per-group
throughput divides by the area's group count, and the shared enum
lanes axis (structurally the most-groups area) settles at a
window-proportional shortfall once capture growth outruns one chunk
per serve. Shape 1 removes the redundant per-group scans; the
structural coupling — decode progress gated on views fetching —
remains.

## Scope

Move catch-up decode progression off the serve path: the host
advances decode cursors toward the capture tip independently of view
fetches (background progression with a bounded duty cycle), and a
serve reads whatever the cursors have reached — the serve-time
budget then bounds only the serve's own read/assembly work. Design
against ADR 0049 (which this amends): the completeness token, the
`catchingUp` frontend latch (task 75 phase 1), the rebuild
announcement (task 75 phase 5's chip polls a fact derived from
decode cursors), and pyramid persistence cadence all consume decode
progress and must keep their semantics.

Design questions for grooming (before implementation):

- Scheduling: duty-cycle/idle-priority background progression vs
  event-driven on append; interaction with `plotPacing`.
- Prioritization among signals (plotted first? all cached keys?)
  and fairness across groups.
- Contention: the append mutex and the health sampler (task 75
  phase 1's blocker note about O(buffer) passes under that mutex is
  adjacent).
- Perf: the ADR-0031 gate must hold; background work must not steal
  from ingest at peak rates.

## Exit criteria (draft — firm at grooming)

- Decode cursors reach the capture tip without any view fetching
  (tested at the store seam).
- The task 72 phase 3 reproduction (16-group axis, growth > one
  chunk per serve) converges to the tip instead of settling at a
  window fraction (re-run of the same experiment, recorded).
- Serve latency stays within its budget regardless of group count.
- ADR 0049 amended to record the decoupling; ADR-0031 gate passes
  (all metrics, no baseline promotion).
