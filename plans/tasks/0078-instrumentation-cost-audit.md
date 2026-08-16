# Task 78 — Automation-Instrumentation Cost Audit

Opened by owner ruling 2026-08-15 (mid-cycle, during the task-72
phases that extended the harness): "we need to make sure all of this
automation instrumentation is lightweight and has no adverse
performance impact _or_ that it gets disabled by default and/or costs
nothing if it's not used."

## Scope

Inventory every piece of automation/measurement machinery that ships
in the product binary, classify each as **product feature** (health
sampler, UI-liveness heartbeat — deliberately always on, cost
budgeted) or **harness-only** (perf capture, perf-interact scripts,
screenshot/DevTools hooks, hover-photograph support, DIAG
counters/gauges, `--app-data-dir`), and for the harness-only set
prove one of:

- **flag-gated off**: the code path is not scheduled/registered/opened
  at all on a normal launch (not "runs but does nothing"), or
- **measurably free**: cost when unused is indistinguishable from
  zero at the gate's sensitivity.

Fix anything that fails both. Candidates known at opening: the diag
reporter's 1 Hz tick (carries the product heartbeat — budget it
explicitly), `diagCount`/`diagGauge` call sites on render hot paths
(are they no-ops without a flag, and how cheap is the no-op?), the
WebView2 DevTools port (must not open unless requested), the
perf-interact tick scheduler, and any listener the screenshot/hover
machinery installs unconditionally.

## Grooming (2026-08-15, owner-confirmed)

Two phases, investigation-then-fix:

1. **P1 — inventory.** Every measurement/automation hook in the
   shipping binary enumerated and classified (product feature vs
   harness-only), with default state, unused cost, and evidence (code
   path or measurement) per row; the table lands in the status log.
   No fixes. **Includes** a bounded side-investigation attributing
   the screenshot-scenario empty-plot flake (recorded in 0072's
   blockers: ~1 in 3 runs across three binaries, correct on re-run) —
   it lives in the same harness code the inventory walks.
2. **P2 — fix.** Anything harness-only that is neither
   flag-gated-off ("not scheduled at all") nor measured-free at the
   ADR-0031 gate's sensitivity is fixed test-first; README/ADR-0031
   gain the flag inventory; product-feature costs come back to the
   owner as a stated budget for acceptance.

The draft exit criteria below are confirmed as written.

## Exit criteria (firmed at grooming, 2026-08-15)

- The inventory table lands in this file's status log: every hook,
  its classification, its default state, its unused cost, with the
  evidence (code path or measurement) per row.
- Harness-only machinery is flag-gated off or measured-free by the
  ADR-0031 gate's own sensitivity; anything fixed lands test-first.
- Product-feature instrumentation (health sampler, heartbeat) has
  its cost stated and accepted by owner ruling.
- README/ADR-0031 document which flags enable what, so an operator
  can see the full instrumentation surface in one place.
