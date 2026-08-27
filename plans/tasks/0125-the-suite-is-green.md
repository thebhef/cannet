# 0125 — The Suite Is Green

> **Opened 2026-08-26** by owner ruling on queue finding 3.63:
> *"re-run/fix."* The frontend suite is not reliably green, and
> `implement-phase` makes a green `frontend` job an exit criterion of
> every phase — so either phases have been reporting a flake as green,
> or the flake is recent. Both readings end the same way: the flake is
> found and fixed, not retried around.

## The finding (overseer, 2026-08-26)

`PlotPanel.dom.test.tsx` → *"re-renders no plot area when only
panel-local state changes"* fails intermittently with
`expected 1 to be +0` — one extra `PlotArea` render arriving between
the baseline read and the click.

- **Reproduced in two of three full runs**; one of three runs of the
  file alone. Real, not noise.
- Not caused by the change that surfaced it (a docs/CSS-comment-only
  commit).
- **One hypothesis raised and refuted**: the test's comment says *"a
  stopped panel, so no self-paced resample can land between the
  baseline read and the click"*, which looked like it disagreed with
  the fixture's `isPaused: false` — but "stopped" in this file means a
  finite `end` (`trace.ts`'s `traceStatus`), which the fixture has. The
  cause is **not established**; no fix should land without the
  experiment that confirms it.

## Scope

1. Instrument or bisect the extra render to its trigger (scientific
   method: observation → hypothesis → falsifying experiment), then fix
   the cause — in the test if the test's isolation is broken, in the
   panel if the render is real churn a stopped panel should not do.
2. If the render is real churn, that is a behaviour fix with the
   regression test failing first; the perf implications go to the
   ADR 0031 series like any render-path change.

## Exit criteria

1. The root cause is stated with the experiment's data that confirmed
   it — a hypothesis that survived a falsification attempt, not a
   plausible story.
2. The fix lands with the test deterministic: **ten consecutive full
   `pnpm --dir apps/gui test` runs green**, stated with the runs.
3. If the extra render was real panel churn, a regression test pins it
   gone, written failing first.
4. Full local CI green — seven jobs, each named with its command.
