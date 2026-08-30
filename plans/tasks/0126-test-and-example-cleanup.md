# 0126 — Test and Example Cleanup

> **Opened 2026-08-26** by owner ruling on queue findings 3.45 and all
> of § 3F: *"those and everything in 3F seem to me like they merit a new
> 'test & example cleanup' task that will basically: resolve
> regressions/rot in our perf test; furnish example files for everything
> we want to demo in the frontend (use LFS, keep files small)."*
>
> This task gates the chain's close-out: the render-tier gate must not
> run until the harness stops lying (§ 1), and the verification
> checklist's acceptance rows must not claim walks that never happened
> (§ 3).

## 1. The perf harness stops lying

> **Owner, 2026-08-27:** once this section makes the harness effective
> again, per-phase captures **resume immediately** — collect the data
> along the way, gate only on severe regressions (the 2026-08-22
> thresholds), and the series is reviewed at the end of the chain.

Every finding here is a check that passed while measuring nothing — the
silent-disarm family.

- **3.35 — memory metrics are not isolated.** *(landed 2026-08-27)* Windows never clears a
  dead parent's `ParentProcessId`, so `descendant_pids` (`crash.rs`)
  adopts unrelated orphans on pid reuse (a 4 GB foreign app was measured
  as ours), and when another cannet owns the shared WebView2 browser
  process our own renderer is *not* our descendant — `webview_mb` reads
  0.0 and the gate passes. Fix the attribution (ground-truth
  `Win32_Process` walk, job objects, or equivalent), and make an
  implausible zero **fail loudly** instead of passing.
- **3.62 — the `__shot` helpers have no guard test.** *(landed 2026-08-27)* `importIdle()`
  silently returned true mid-import when the label it polled for was
  restyled away; fixed, but the helpers are JS embedded in a Rust
  string, exercised only by a real capture run, so the next markup
  change breaks them just as silently. Add a test that exercises the
  helpers without a full capture run.
- **3.36 — one clean memory capture set.** *(owed — needs the owner's machine)* Task 107 phase 5's memory
  behaviour is unmeasured because every capture ran beside the owner's
  own cannet (which 3.35 makes unreadable). One capture set with the
  machine to itself, coordinated with the owner.
- **3.46 — the two unstable metrics get their ruling on evidence.** *(evidence charted 2026-08-27; the ruling is owed)*
  `lag_ms_max` spanned 2.8–37.6 ms against a 41 ms limit across eight
  captures of one unchanged binary; `rx_gap_short_frac_worst` breached
  on a byte-identical GUI. Chart the distributions across every stored
  run and put the band-vs-worst-of-N question to the owner **before**
  the close-out gate, with ADR 0031 amended per the ruling (limits still
  ratchet down only).
- **The interaction script's gestures are counted.** *(landed 2026-08-27)* Every gesture
  function in `perfInteract.ts` returns a label naming what it did, and
  `startPerfInteraction` discards the return value — a gesture whose
  target is missing is skipped silently (deliberate, so a layout with
  no plot is still a legitimate capture), but nothing records how often
  that happened. A run where the script drove nothing produces a report
  structurally identical to a good one. And a target *has* gone
  missing before: task 108 moved follow-live onto a chip
  (`button[aria-label="Follow Live"]`) that spills into the `…`
  overflow at narrow widths, where the script cannot reach it. Tally
  the gestures performed and carry the tally in the render report, so a
  disarmed harness is visible in the data. Overseer inspection
  2026-08-22; precondition for the close-out gate run.
- **3.34 — already fixed**, recorded for completeness: the README's
  capture recipe omitted `--rbs-run-on-start` and two phases measured an
  idle bus that passed. The standing rule it produced — sanity-check
  `ids_measured` and rx/tx rates on every report — becomes part of this
  task's exit criteria.

## 2. Example files for everything the frontend demos

> **Owner, 2026-08-26:** this task happens **first** on the roadmap,
> and this section's gap list is driven by the verification checklist
> (`plans/owner-review-queue.md`) — furnish any input files its
> acceptance walk needs.

Furnish a small example file for every frontend surface worth
demonstrating — captures (BLF/MDF, events, error frames, file-backed
signal series), databases, projects — so demos and eyeball reviews stop
depending on whatever happens to be lying around.

- **Git LFS carries them** (owner ruling 2026-08-26); keep each file
  small. LFS goes in `plans/technology-inventory.md` with this decision,
  and README § Prerequisites gains the `git lfs` requirement.
- Existing `examples/` content is the seed; the gap list is drawn up at
  grooming (what does each panel need on screen to show itself off?).

## 3. The missing exit-criteria verdicts (3.45)

The acceptance record claimed every task was walked criterion by
criterion; five never were, and one is partial. As test cleanup, produce
the verdicts — each criterion against a named test or artifact. The six
task files are retired from `plans/tasks/`; read a file's criteria from
git history, e.g.
`git show $(git rev-list -1 HEAD -- <path>)^:<path>`.

| Task | Owed |
|---|---|
| 89 — signal mapping panel | 8 criteria, no verdicts |
| 90 — cycle 86/27/87 follow-ups | 3 live criteria (one retired into 91) |
| 93 — source comments name tasks | 3 criteria |
| 105 — unfinalized-BLF recovery | 5 criteria |
| 110 — chain CI repair | none written — ratify its "Every job, green" table as the criteria, or write them |
| 27 — project/RBS disk watch | criterion 4 partial (Tauri mock runtime will not load on Windows) — verdict on whether inspection suffices |

Also from this walk, **3.4**: nothing in the 2,421-test suite caught
task 98's defect, and the two tests nearest it asserted the very rule
that produced it. As part of the same cleanup: **audit the suite for
other wrong-rule pins** — tests that assert a behaviour because the code
does it, not because anything decided it should — starting where task
98's investigation pointed; and 98's verification matrix gains a
manual-y-limits row (the one combination the fix's tests do not pin —
owner asked 2026-08-26).

## Exit criteria

1. A capture taken beside a second cannet either attributes memory
   correctly or **fails loudly** — no metric silently reads 0.0 or
   adopts a foreign process; pinned by a test against faked process
   tables.
2. The `__shot` helpers are exercised by a test that runs without a
   full capture; breaking a helper's selector fails it.
3. One clean-machine capture set exists and task 107 phase 5's memory
   question is answered from it.
4. The 3.46 ruling is made on charted evidence and recorded in ADR
   0031 before the close-out gate runs.
5. The render report carries a tally of the gestures the interaction
   script performed; a capture whose script found none of its targets
   is visibly disarmed rather than silently clean.
6. Every demoable frontend surface has a small example file, in LFS;
   the inventory and README record the LFS decision; `git lfs pull` on
   a fresh clone yields a working demo set.
7. The § 3 verdict table above is complete — every named criterion has
   a verdict against a named test or artifact — and the verification
   checklist's acceptance rows match the evidence. The wrong-rule-pin audit's findings
   are recorded, each either fixed or accepted with its reason.
8. Full local CI green — seven jobs, each named with its command.

## Status log

### 2026-08-27 — § 1, the perf harness stops lying (phase 1)

Branch `task-126-harness-truth` off `task-80-stopped-resample`
(89b57387). Scope: § 1 only, minus 3.36 and the 3.46 ruling itself.

**3.35 — memory attribution.** Two distinct failures, both fixed in
`crash.rs` and pinned against faked process tables.

- *Observation.* `descendant_pids` decided the family from
  `(pid, parent_pid)` alone. Windows recycles PIDs and never clears a
  dead parent's `ParentProcessId`, so an orphan whose real parent died
  holding the PID we now hold still claims us — measured once as a 4 GB
  foreign app billed to this process.
- *Design chosen: a creation-time-guarded walk*, not a WMI
  `Win32_Process` query and not job objects. A parent link now counts
  only when the child's creation time is known and not earlier than the
  parent's — the one fact a stale link cannot fake. The alternatives
  were both worse here: WMI is a new dependency and a per-sample
  out-of-process query on a path that already runs once a second, and
  job objects need `unsafe` (the workspace forbids it) plus assigning
  every child at spawn, which the WebView2 runtime spawns outside our
  control. `sysinfo` already carries `start_time()`, so the fix costs
  one field and stays a pure function over a table — which is what
  makes it testable.
- *The unknown-time rule.* `start_time()` is `0` on Windows when no
  handle can be opened. Those processes still report memory (it comes
  from `NtQuerySystemInformation`, not the handle), so admitting them
  is the expensive mistake. *Experiment:* enumerated every
  `msedgewebview2` process on the reference machine from an ordinary
  medium-integrity caller — all 13 reported a creation time. Our own
  family is therefore always readable, so an unreadable time means
  stranger, and unknown is excluded.
- *Falsification.* Disabling the creation-time rule fails
  `a_pid_reuse_orphan_is_not_adopted` and
  `an_unreadable_creation_time_is_not_ours`; restoring it passes both.
- *The implausible zero.* When a second cannet owns the shared
  `WebView2` browser process our renderer descends from *its* host, so
  the family contains no `WebView` process and `webview_mb` reads
  `0.0` — which no gate can tell from a renderer that grew not at all.
  `attribution_fault` now reports that family, `diag_capture_finish`
  returns an error, and the run exits non-zero writing **no report**.
  macOS is exempt (launchd-owned `WebKit` XPC helpers are never our
  descendants — the documented normal there).

**3.62 — `__shot` guard test.** `PRELUDE_JS` moved out of the Rust
string into `crates/cannet-perf-measurement/src/shot-prelude.js`
(`include_str!`, so the harness is byte-identical). New
`apps/gui/src/shotPrelude.dom.test.tsx` loads that exact file,
evaluates it, and drives every helper against the **real** components:
`Toolbar` (`toolbar`, `importIdle`, `openSeededCapture`), the real
`App` (`openPalette`, `command`, `state`), `CloseConfirmModal`
(`modal`), plus `waitFor` and the console tap. 12 tests, 1.3 s.
*Falsification:* breaking `aria-busy="true"` → `"yes"` and
`.recent-captures > button` → `> a` fails exactly the two tests that
claim them. `hoverPlot`'s `.u-over` is uPlot's own markup, which the
suite's fake uPlot does not render, so what is pinned here is
`.plot-area[data-area-id]`; the Rust side already pins the rest.

**Gesture tally.** `perfInteractTick` now returns a `TickOutcome`
(`gesture` / `missing` / `idle`) instead of `string | null`, so a
skipped gesture is distinguishable from a deliberate idle slot and
still names itself. `startPerfInteraction` returns
`{ stop, tally }`; `App.tsx` reads the tally at
`endDiagCapture`, which hands it to `diag_capture_finish`, which stamps
it into the report as `interact`:

```json
"interact": { "script": "scrub", "ticks": 400, "performed": 250,
              "missing": 0, "idle": 150,
              "by_gesture": { "plot.zoom-in": 201, … },
              "missing_by_gesture": {} }
```

`performed: 0` is the disarmed signature. `baseline` and `check` print
a `WARNING` naming the missed gestures; they do not gate, because a
layout with no plot is a legitimate capture.

**Targets re-verified.** All three still exist in the frontend:
`button[aria-label="Follow Live"]` inside `.plot-panel-toolbar`
(`PlotToolbar.tsx:302`, `ChipButton` carries `aria-pressed`),
`.trace-rows` (`TraceView.tsx:907`, also `ByIdTable`/`SignalsPanel`),
and `.u-over` (uPlot's own overlay).

**3.46 — evidence for the owner's ruling.** Every render report in the
repository's history mined (206 distinct reports across 91 commits
touching `docs/performance-measurements/frontend/`; 179 carry
`rx_gap`). *The band-vs-worst-of-N ruling is the owner's — this is only
the evidence.*

| metric | n | min | p25 | median | p75 | p90 | p95 | max |
|---|---|---|---|---|---|---|---|---|
| `lag_ms_max` (ms) | 206 | 1.0 | 2.3 | 5.6 | 14.3 | 25.7 | 30.5 | 397.2 |
| `rx_gap_short_frac_worst` | 179 | 0.00017 | 0.00217 | 0.00333 | 0.00502 | 0.02006 | 0.04579 | 0.23615 |

Spread *within one binary* (cohorts of ≥2 runs sharing a commit hash),
which is the number the ruling turns on — none of this is a code change:

| metric | cohorts | median spread | worst cohorts |
|---|---|---|---|
| `lag_ms_max` | 49 | **4.3×** | `e0b83f9` 1.0–27.1 ms (27×, n=5); `ea9646a` 2.1–37.8 ms (18×, n=17) |
| `rx_gap_short_frac_worst` | 44 | **2.3×** | `8ec43685` 0.00017–0.19393 (1163×, n=4); `ea9646a` 0.00033–0.16075 (482×, n=17) |

Read: both metrics are heavy-tailed and the tail is **not**
build-dependent. 33 of 206 runs (16 %) exceed 20 ms of `lag_ms_max` and
4 exceed the 41 ms limit; 3 of 179 exceed the 0.15
`rx_gap_short_frac_worst` floor, and two of those three sit in cohorts
whose other runs read ~0.0002 — a breach on a byte-identical binary.
A worst-of-N rule over 3–4 runs therefore fails an unchanged build at a
rate the medians do not support, while a median/band rule would have
passed every cohort here. The `*_drift_per_min` family already moved to
a median for exactly this reason (ADR 0031, 2026-08-22).

**Verification capture.** One 60 s `scrub` run on the repaired harness,
release binary, `--rbs-run-on-start`, isolated `--app-data-dir` seeded
with the operator's window geometry. Report:
`docs/performance-measurements/frontend/2026-08-27-0dc6bae6-harness-repair.json`
(the hash names the commit that first carried the exact source tree
the measured binary was built from; filing the report into that same
commit necessarily moved the commit object itself).
Sanity first, per the standing rule: **`ids_measured` 174, rx 1607 f/s,
tx 1612 f/s** — the bus was loaded. Purpose was proving the harness
measures something real, not gating; the dongles were free (no cannet
was running) and nothing was killed that this session did not start.

| | this run | 51b4b352 run1 | run2 | run3 |
|---|---|---|---|---|
| `mem.host_mb` peak | 67.8 | 62.3 | 62.1 | 62.8 |
| `mem.tree_mb` peak | **737.8** | **5132.6** | **121.7** | **122.4** |
| `mem.webview_mb` peak | **609.9** | 955.8 | **0.0** | **0.0** |
| `mem.webview_renderer_mb` peak | 310.4 | 633.8 | **0.0** | **0.0** |
| `jsheap_mb` peak | 92.8 | 97.4 | 94.2 | 70.5 |

Those three columns are consecutive runs of one binary from the last
gate, and **not one of them measured memory**: run 1 adopted a foreign
process (5.1 GB attributed to a host holding 62 MB), runs 2 and 3 read
`webview_mb: 0.0` — the shared-browser-process case — and passed. The
repaired run is internally consistent for the first time (host 67.8 +
webview 609.9 ≈ tree 737.8) and did **not** trip the new fault, which
is the other half of the check: the detector does not fire on a healthy
family. Across all 195 stored reports carrying `mem.tree_mb`, 2 read
`webview_mb: 0.0` and 3 exceeded 1.5 GB of tree (8.2 GB the worst) —
rare overall, but concentrated in the recent cohorts the close-out gate
would have read.

The gesture tally landed populated, which is what exit criterion 5
asks for: 445 ticks, **266 performed, 0 missing**, 179 idle, all seven
gesture labels present — `plot.follow-live` × 26 among them, so the
chip was reachable at the reference geometry (2450 px). Render-tier
health on the run: `lag_ms_max` 1.6 ms, `longtask_ms_per_s` mean/p95
0.0/0.0, `jank_fraction` 0.0, `flush_ms` mean 4.3 / max 10.9,
`tx_late_ms` mean 5.3 / max 19.2.

**Reading worth the overseer's eye:** `mem.tree_mb` peaks at 737.8 MB
with a `slope_per_min` of +73.1 (renderer +45.3) over the 60 s window.
Per-process it is under the 400 MB line (renderer 310.4, host 67.8),
so this is not called a regression — and it is the *first* run whose
memory numbers can be believed at all, so there is no comparable series
to read it against. It is a single run over a session that restored
319 k frames, which is exactly where a warm-up ramp lives. Recorded so
the resumed per-phase captures have a starting point.

## Blockers / side effects

- **Owed to the owner, not blocked:** the 3.46 band-vs-worst-of-N ruling
  (evidence charted above; ADR 0031 is amended once it is made) and the
  3.36 clean-machine capture set (needs the machine to itself). Both are
  indexed in `plans/owner-review-queue.md`.
- **A residual attribution limit, documented not fixed.** The
  creation-time rule stops us adopting a *stranger*. It cannot stop the
  mirror case: if *we* own the shared `WebView2` browser process and a
  second cannet attaches, that instance's renderers are genuine
  descendants of our browser process and are billed to us. They start
  after us, so no time check separates them. Distinguishing them needs
  the renderers' `--user-data-dir`, which both instances share. The
  effect is inflation, which reads as a regression rather than as a
  pass — the safe direction — and it is one more reason 3.36 wants the
  machine to itself.
- **No NSIS installer was built** for this phase. The phase brief
  forbids it explicitly (`cargo build --release` for the binary, no
  `cargo tauri build`/NSIS), which overrides the implement-phase
  default. The measurement binary was built with
  `pnpm --dir apps/gui tauri build --no-bundle` — the release host with
  the frontend embedded, which is what README § Self-driving performance
  runs requires and what a plain `cargo build --release` cannot produce
  (without the `custom-protocol` feature the binary still points at the
  Vite dev server and captures nothing).
- `perfInteractTick`'s return type changed from `string | null` to a
  `TickOutcome` union. In-tree callers are `startPerfInteraction` and
  the test; nothing else consumes it.
