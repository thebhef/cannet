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

## Status log

### 2026-08-27 — root cause found, test made deterministic

**Observation.** On `plans-review-and-closeout` (0fe50c89) the test's
pass/fail is not random noise but a race whose sign flips with machine
speed. Measured on this machine, unmodified: an early batch of runs
(6 × the file alone, 3 × `pnpm --dir apps/gui test`) was green; a later
batch of 10 runs of the test alone was **10/10 red**, `expected 1 to be
+0`, with no source change in between. So the failure is reachable at
will, and the earlier "two of three" is the same race seen from the
other side.

**Instrumented run.** The suite's own diagnostic counters (`diag.ts`)
were snapshotted at three points — after the signal drop, after the
settle sleep, and after the context-menu `act` — with each
`void resampleRef.current()` call site in `PlotArea.tsx` temporarily
tagged with its own counter. The settle sleep was swept, since that is
the test's only wall-clock assumption.

| settle | during the sleep | during the context menu | result |
|---|---|---|---|
| 150 ms | *(nothing)* | `render.PlotPanel: 2` | pass |
| 200 ms | 1 × postMount rebuild | `XP.raf: 2`, `plotarea.resample: 3`, `render.PlotArea: 3` | fail |
| 260 ms | 2 × postMount rebuild | `XP.raf: 2`, `plotarea.resample: 2`, `render.PlotArea: 1` | fail |
| 400 ms | 2 × postMount rebuild | `XP.raf: 2`, `plotarea.resample: 2`, `render.PlotArea: 1` | fail |

Each "postMount rebuild" is `uplot.resizeTick.postMount` +
`uplot.destroy` + `uplot.create` for one area.

**Conclusion (the data, not a story).** The extra `PlotArea` render is
the re-sample kicked from the `requestAnimationFrame` that
`PlotArea`'s uPlot construction effect schedules. That effect re-runs
because of the once-per-area post-mount rebuild it arms on a 250 ms
timer — a deliberate workaround for a real-browser axis-layout bug,
not churn. Lengthening the sleep cannot drain it: the timer fires
*inside* the settle `act`, so React defers the `setResizeTick` commit
to the moment that scope closes, the construction effect runs there,
and the animation frame it schedules is still pending when the very
next line reads the baseline. Whether that frame runs before the
baseline read or inside the following `act` is the race — hence
`XP.raf: 2` landing in the context-menu window at every settle value
from 200 ms up, and nothing at all at 150 ms, where the timer has not
fired yet.

The refuted hypothesis in "The finding" stays refuted; `isPaused` is
not involved. The self-paced loop is genuinely off — what the test's
comment missed is that a stopped panel still has mount-time one-shots.

**Fix.** Test-side, because the render is mount settling rather than
panel churn: sleep past the one-shot timers
(`FIRST_SAMPLE_INDICATOR_MS + 100`), then flush 60 ms `act` windows
until one costs no `PlotArea` render — the idiom already used by
*PlotPanel per-area render scoping* and *PlotPanel signal-row
selection* in the same file. A quiet window means no animation frame
fired in it and none was scheduled at its close, so the baseline is
read against a drained panel instead of a guessed duration. No
retries, no test-order pinning, no product change. Exit criterion 3
does not apply — the extra render was not real panel churn.

**Verification.** The test alone: 10/10 red before, 12/12 green after.
Full suite (`pnpm --dir apps/gui test`): **ten consecutive green runs**,
219 files / 3002 tests each.

| # | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| result | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**CI — full local run, seven jobs.**

| Job | Command | Result |
|---|---|---|
| comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | ✅ no hits |
| frontend | `pnpm --dir apps/gui test` (×10), `pnpm --dir apps/gui build` | ✅ 3002 tests; build ok |
| python | `uv sync --extra dev --frozen`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy`, `uv run pytest` | ✅ 200 tests |
| rust | `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings` | ✅ |
| mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample -- <tmp>/sample.mf4`, `uv run --with asammdf --with numpy python crates/cannet-mdf/tests/fixtures/validate_export.py <tmp>/sample.mf4` | ✅ 30 frames / 3 signals / 3 events OK |
| rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | ✅ |
| sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | ✅ smoke ok on 127.0.0.1 |

No perf capture was taken: the phase touches no render path, and the
render-tier harness is under repair.

## Blockers / side effects

None. The test's fixed 400 ms sleep was the only thing that changed;
no product code was touched.

Worth knowing for whoever writes the next render-count test in this
file: **a wall-clock sleep inside `act` is never a settle.** React
holds every commit scheduled during an async `act` scope until the
scope closes, so any effect that runs at that commit — and anything it
schedules on an animation frame — is still outstanding on the next
line. Only a quiet-window loop drains it.
