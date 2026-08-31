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

### 2026-08-27 — § 2, example files for everything the frontend demos (phase 2)

Branch `task-126-example-files` off `task-126-harness-truth` (724f3cc4).
No product code changed; everything here is fixtures, generators, tests,
docs and the LFS wiring.

**The gap list came from the verification checklist, not from a wish
list.** Every Acceptance row was walked against its exit criteria (read
from git history for the retired task files) and asked one question:
*what file does the owner need on screen to verify this?* Most rows
already had one — `examples/time-origins/` covers 86 / 87 / 90 / 91,
`ev-demo` covers 27 / 98 / 100, `ev-zonal` covers 96 / 97. Seventeen
needs across eleven rows had nothing.

| Need (rows) | Furnished |
|---|---|
| Unfinalized BLF (105, 122) | `capture-features/interrupted.blf` |
| …and one cut mid-object (105) | `capture-features/interrupted-tail.blf` |
| A **black** `#000000` event with an uncoloured control (122) | `capture-features/annotated.blf` |
| A `cannet-event/1` block with a key this build cannot read (122, 107) | `annotated.blf`, `annotated.mf4` |
| `EVENT_COMMENT` carrying `commentedEventType` (122, 102) | `annotated.blf` |
| Error and remote frames (102) | both captures |
| An event of a kind hidden by default (`busError`) (102) | both captures |
| A foreign MDF whose master **descends** (122) | `annotated.mf4` |
| An MDF native begin/end range pair (107) | `annotated.mf4` |
| A coded file-backed series (97, 107) | `annotated.mf4` |
| An event with no block at all — another tool's (102, 107) | `annotated.mf4` |
| An import channel with no bus to map onto (88) | both captures, channel 2 |
| A virtual bus, for the Adapter cell (114) | `capture-features.cannet_prj` |
| An unbound bus, for the named refusal (117) | its `Aux` bus |
| Transmit / RBS with no adapter attached (99) | that project + `capture-features.cannet_rbs` |
| Two databases colliding on one id (92, 88, 89) | `examples/colliding-dbcs/` |
| A pre-rule project: database assigned to nothing, plot series with `bus_id: null`, persisted `run: true` (88, 106, 99) | `examples/legacy-project/` |

**Named gaps, not furnished.**

- **A multi-million-frame capture** (104, 80) — deliberately absent. It
  is tens of megabytes, against a set whose whole value is that it stays
  a few hundred kilobytes and opens by hand. `gen_annotated_blf` gained
  an optional frame-count argument that writes one wherever it is
  pointed, documented in `examples/capture-features/README.md`, and both
  rows now say so rather than implying a file exists.
- **Vector and Kvaser hardware** (109 item 2, 101) — no file can stand in
  for unplugging an adapter mid-capture.

**Three fixture sets, ~112 KB of binaries.**

- `examples/capture-features/` — `annotated.blf` (2.4 KB),
  `annotated.mf4` (19 KB), the two interrupted captures (57 + 53 KB), a
  project
  and an RBS. Everything decodes against the existing
  `examples/cannet-demo.dbc`; there is no new database, because the
  checklist did not need one (`cannet-demo.dbc` already declares
  `CannetCounter` / `CannetCrc` and a mux, `ev-demo` and `ev-zonal`
  already carry the long-name extension).
- `examples/colliding-dbcs/` — two text DBCs that disagree about
  `0x100` in seven distinct ways, deliberately colliding on the id
  `cannet-demo.blf` already carries, so the pair needs no capture.
- `examples/legacy-project/` — one project plus its RBS, all text.

*The interrupted captures could only be made one way*: by never
finishing. The generator `mem::forget`s the writer, which costs exactly
what a kill costs — the flushed `LOG_CONTAINER`s survive, the scratch
buffer does not, and the header keeps the anchor latched at open. 9 000 frames sizes
it past the 128 KiB container buffer three times, so recovery has more
than one container to walk.

**Fixtures are pinned by tests, because nobody diffs a demo file.**
`crates/cannet-blf/tests/capture_features_fixture.rs` (5),
`crates/cannet-mdf/tests/capture_features_fixture.rs` (4),
`crates/cannet-dbc/tests/colliding_dbcs_fixture.rs` (3), plus three
project-parse tests and one RBS-resolution test in `cannet-gui`. Sixteen
in all. The colour pair is the one worth naming: `annotated.blf` carries
both `(fg 0x00FFFFFF, bg 0x000000)` and `(fg 0x000000, bg 0x00FFFFFF)`,
and the two assertions falsify each other — a reader that folded
`Some(0)` into `None` would leave only one pair in the file and fail one
of them.

**LFS is scoped to `examples/`, and that scope is a decision.**
`.gitattributes` tracks `examples/**/*.{blf,part,mf4}` — ten files, the
six that were already committed raw plus the four new ones.
`crates/cannet-mdf/tests/fixtures/*.mf4` stay in plain git: they are read
by `cargo test --workspace`, so behind LFS the default suite would fail
in a clone that had not fetched the objects. The databases, projects and
RBS files stay in plain git too — they are text, and a text diff is worth
more than a pointer. The Tauri icons must be real bytes at build time.

*One consequence, wired:* several Rust tests read `examples/` captures,
so `.github/workflows/ci.yml`'s `rust` job checkout gained `lfs: true`.
It is the only job that reads them; the other six are untouched.

**Fresh-clone check — exit criterion 6.** `GIT_LFS_SKIP_SMUDGE=1
git clone --local` of this branch into the scratchpad first, so the
before state is real: all ten captures came down as 129-130 byte pointer
files (`version https://git-lfs.github.com/spec/v1` / `oid sha256:…` /
`size 2442`). Then `git lfs pull` — exit 0, `git lfs ls-files` listing
all ten — and `md5sum` over the ten against the working tree: **all
identical**. Then the real check, that the demo set *works*:
`cargo test -p cannet-blf -p cannet-mdf -p cannet-dbc` in the clone,
green, including the three new fixture suites (5 + 4 + 3). Nothing was
pushed.

**Full local CI, seven jobs, all green** — table in the phase report.
No installer or perf capture was taken for the fixture work itself; see
Blockers.

### 2026-08-27 — § 3, the missing verdicts and the wrong-rule-pin audit (phase 3)

Branch `task-126-verdicts-audit` off `task-126-example-files`
(`a97d8014`). No product code changed: the diff is tests, this log, and
the checklist's acceptance annotations.

**Method for the verdicts.** Each retired task's criteria were read back
from git history (`git show aae43097^:plans/tasks/NNNN-*.md` —
`aae43097` retired them) and walked one at a time against a **named
artifact in today's tree**: a test name with its `file:line`, a source
`file:line`, or a committed doc. A claim in the retired task's own
status log was never accepted as evidence; every artifact was confirmed
present now. Where nothing could be named, the verdict says so.

**6 tasks, 27 criteria — 24 met, 3 partially met, 0 not met.**

| Task | Criteria | met | partial |
|---|---|---|---|
| 89 — signal mapping panel | 8 | 7 | 1 |
| 90 — cycle 86/27/87 follow-ups | 3 | 3 | 0 |
| 93 — source comments name tasks | 3 | 3 | 0 |
| 105 — unfinalized-BLF recovery | 5 | 5 | 0 |
| 110 — chain CI repair | 4 (ratified) | 4 | 0 |
| 27 — project / RBS disk watch | 4 | 2 | 2 |

Neither partial is a new finding: 89's has its fix owned by task 112,
27's has a named and unblocked path.

#### Task 89 — signal mapping panel

| # | Criterion | Verdict | Earned by |
|---|---|---|---|
| 1 | Lists every referenced signal, live; assign / unassign moves rows without a reopen | **met** | `view_signals.rs:1567` `assigning_a_database_moves_a_row_out_of_not_decoded` (both directions); `:1610` `a_database_reloaded_in_place_moves_the_row_without_a_refetch_gap`; panel refetch `ViewSignalsPanel.tsx:222`, `ViewSignalsPanel.dom.test.tsx:321` |
| 2 | Row status, serving DB, used-by and attention count host-side; nothing re-derived in JS; no state that grows with the project | **partially met** | Host half real — `view_signals.rs:351` `build_rows`, `:895` `attention_count`, `:216` `needs_attention`. Second clause fails on its own terms: `list_view_signals` takes no offset/limit and `ViewSignalsPanel.tsx:192` holds the whole row set (~1 074 rows on `ev-zonal`); JS re-derives per-status counts and the bus list (`:358`, `:368`) and filters client-side (`viewSignalsFilter.ts`). Paging is task 112's exit criterion 4; the JS re-derivation is an open backlog item |
| 3 | One signal is one row; a pick applies to every view; divergence unreachable | **met** | `view_signals.rs:1383` `one_signal_is_one_row_however_many_views_reference_it`; `:1401` `an_identity_only_reference_never_masks_a_drift_another_view_recorded`; gesture level `ViewSignalsPanel.dom.test.tsx:489`. Divergence is unreachable *structurally* (`ViewSignalRegistry` carries no per-view axis, `view_signals.rs:165`) and pinned positively; there is no negative test, which is the honest limit of this verdict |
| 4 | Launcher badge shows the attention count, updating on a DBC change including assignment | **met** | `viewSignalsAttention.dom.test.tsx:64` / `:91` / `:99` — the last with the panel never mounted, so the count is not a side effect of rendering it; assignment announces at `dbc_commands.rs:311`; chip render `StatusChip.dom.test.tsx:40`. The badge rides a status-bar chip rather than a toolbar launcher — the chip-language change, not a shortfall |
| 5 | The ambiguous case is selectable, persists only when set, dropped silently on DBC removal | **met** | `view_signals.rs:1228` `a_pick_settles_the_ambiguity_and_names_the_database_it_chose`; `project.rs:560` `a_project_with_no_database_pick_carries_no_such_field` and `:576`; `view_signals.rs:1806` `removing_the_picked_database_drops_the_pick_silently`. All three, as asked |
| 6 | A remap rewrites every persisted reference through one shared operation; ≥ 2 stores | **met** | `signalRemap.test.ts:432` "reaches every store from a single invocation" — five stores (plot, signals, colormap, transmit pool, `signal_colors`) against a criterion asking for two |
| 7 | The RBS variant shows one config's fields with the encoder's own statuses, clamping through the RBS panel's own code | **met** | `rbs/signals.rs:131` `build_rbs_signal_rows(state, element_id)` is scoped to one element; `:445` `statuses_reflect_the_encoders_own_report`, `:514` `a_message_the_run_flags_would_never_play_reads_muted_regardless_of_overrides`; the clamp is one function, `rbsValueClamp.ts:61`, reached from both panels through `rbsValueCell.tsx:73` |
| 8 | Prototypes retired or updated | **met** | `plans/prototypes/` holds only `gui-chip-redesign.html`; `view-signals-panel.html` and `rbs-signals-panel.html` were deleted in `97fa4ee0`, and no reference to either name survives in the tree |

#### Task 90 — follow-ups from the 86 / 27 / 87 cycle

Three live criteria; the fourth was retired into task 91 at the time and
is not walked here.

| # | Criterion | Verdict | Earned by |
|---|---|---|---|
| 1 | An import window over an out-of-order file keeps every in-window frame; `wall-clock-out-of-order.blf` is the regression test | **met** | `crates/cannet-blf/tests/ordering.rs:185` `a_windowed_import_over_the_out_of_order_fixture_keeps_every_frame_in_range` — 33 frames, naming the two (+120 ms, +300 ms) that arrive last and sort first. Unit pin `cannet-core/src/io.rs:347`; both import paths share the one wrapper (`capture.rs:260`, `:1634`) |
| 2 | `cargo test --workspace`, parallel, examples included, green | **met** | This phase's CI table below. The collision the criterion was written against is structurally gone — no duplicate example basename exists workspace-wide. One condition now attaches: the suite reads `examples/` captures, which are Git LFS pointers until `git lfs pull`, so CI's `rust` job carries `lfs: true` |
| 3 | A scratch whose manifest version does not match is rejected, or the constant's doc says what the code does | **met**, on the stronger arm | `cannet-spill/src/disk.rs:333` rejects before any field is read; policy doc at `:88`; test `:1014` `reopen_rejects_a_manifest_whose_version_does_not_match` |

#### Task 93 — source comments naming tasks

| # | Criterion | Verdict | Earned by |
|---|---|---|---|
| 1 | No comment, rustdoc or test name under `apps/` or `crates/` names a task number or a `plans/` path | **met** | The CI job's own command, run verbatim: `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` → no matches. The lint is `.github/workflows/ci.yml:23-47` |
| 2 | Every rewritten site still explains *why*; the sweep relocates rationale rather than losing it | **met** | Sampled across the four sweep commits (`c7008419`, `e1fa191d`, `a1539bf8`, `0fdb1e31`). Several sites gained material: `rbs/watch.rs:213` turned a bare pointer into the actual `STATUS_ENTRYPOINT_NOT_FOUND` diagnosis; `types.ts:1150` now says *why* RBS values are view-scoped; `cannet-mdf/Cargo.toml:13` carries the mdf4-rs read/write-split reasoning inline; `calc.rs:24` and `cannet-blf/Cargo.toml:10` relocate to ADRs 0027 and 0009. What was deleted outright was attribution carrying no reason. No site was found where rationale was lost |
| 3 | Test counts unchanged; no behavioural diff | **met** | Filtering every non-comment `+`/`-` line out of the four sweep diffs leaves 9 renamed `describe`/`it` strings and one assertion *message* (`0fdb1e31`; the asserted value unchanged). Test declarations net to zero — one `it(` renamed, none added or removed |

*Correction to task 93's own blocker list.* It recorded residual bare
`Phase N` comments at `apps/gui/src/index.css:3040/4027/4487/4625/4764`
and `crates/cannet-blf/Cargo.toml:21`. **Those are gone from today's
tree.** What remains is a set the blocker never named:
`apps/gui/src-tauri/Cargo.toml` lines 42, 62, 65, 70 and 88 — the only
`Phase [0-9]` matches under `apps/` and `crates/`. None names a task
number or a `plans/` path, so criterion 1 is unaffected and the lint
passes; the open question of whether the retired global-phase scheme
should go too still stands, but against that list, not the recorded one.

#### Task 105 — unfinalized-BLF recovery

| # | Criterion | Verdict | Earned by |
|---|---|---|---|
| 1 | An unfinalized capture opens with every frame before the truncated tail; fixture built by abandoning a writer mid-run | **met** | `crates/cannet-blf/tests/unfinalized.rs:97` `a_capture_whose_writer_never_finalized_yields_the_frames_it_flushed`, over `abandoned()` (`:58`, `mem::forget`s a live writer after 20 000 appends); torn tail at `:124` `a_trailing_fragment_ends_the_walk_instead_of_failing_it`. Committed-fixture coverage as of phase 2: `capture_features_fixture.rs:126` and `:149` |
| 2 | The file is byte-identical after being opened | **met** | `unfinalized.rs:174` `recovering_a_damaged_capture_leaves_its_bytes_untouched` — digest and length across three full passes, plus a `read_dir` sibling check so a `.recovered` copy would fail it too |
| 3 | One system-log line states how much was recovered and that the tail was incomplete | **met** | `capture.rs:533` `recovered_capture_warning`, emitted once at `:1484`; `tests.rs:4212` `a_recovered_capture_says_what_it_recovered` with its negative at `:4288` |
| 4 | The root cause stated with the confirming experiment's data, not the reported symptom | **met**, its record now in git history | The confirmed cause (a trailing fragment aborted the whole read; the reported zero `object_count` refuted) and the A/B data that promoted it were written into task 105's phase-1 status log, and that file was retired by `0fe50c89` — the documented disposal route, not a loss. Today's tree carries the *conclusion* durably (`cannet-blf/src/format/reader.rs:12-29`, the walk bounded by EOF rather than by the header's counts; `header.rs:262-275`, `file_size` and not `object_count` as the discriminator) without the measurement. Judging this partial would make every retired task's documentation criteria retroactively partial, which is not a defensible reading of a rule that says the detail stays in git history |
| 5 | The MDF path fixed or its exemption recorded with a reason | **met** | `crates/cannet-mdf/tests/frames.rs:133` `a_partial_trailing_record_costs_only_itself`, the exemption stated in its doc comment at `:126` — the same trailing-fragment rule, and why the BLF fix needs no porting |

#### Task 110 — chain CI repair

The task carried **no exit criteria**; its verification was the
`## Every job, green` table. That table is **ratified as criterion 1**,
joined by the three things the task did beyond running jobs, and walked
against today.

| # | Ratified criterion | Verdict | Earned by |
|---|---|---|---|
| 1 | Every CI job green, run by hand, each named with its command | **met** | The seven-job table at the end of this log |
| 2 | The clippy failure fixed at its source | **met** | `crates/cannet-dbc/src/tests.rs:615` carries clippy's own suggestion, `.is_some_and(super::calc::CalculatedFieldsConfig::is_empty)`; the `rust` job is green below |
| 3 | The toolbar regression fixed in all three places | **met** | The three scenario steps are `command(...)`, not `toolbar(...)`: `screenshot.rs:191`, `:196`, `:201` (the third as `Show project graph`, the id the icon-only chip dispatches). The `"toolbar"` coverage-loop entry is gone. `importIdle` is `!document.querySelector('.toolbar button[aria-busy="true"]')`, now at `shot-prelude.js:142` — moved out of the Rust string by this task's phase 1, which also gave it the guard test 110 recorded as missing (3.62, the one verdict 110 was still owed) |
| 4 | The MSI bundle target dropped from the config and from every doc naming it | **met** | `apps/gui/src-tauri/tauri.conf.json:27` lists `["app", "dmg", "deb", "rpm", "appimage", "nsis"]`; `grep -rn msi README.md .github/workflows/release.yml` returns nothing |

**The CI surface has moved under 110 since it ran, in both directions,
and a job count is only meaningful against the workflow file at the
time.** 110 measured **six** jobs at chain tip `c17c573b`; today's
`ci.yml` defines **seven**. `rustdoc` (`ci.yml:49`,
`RUSTDOCFLAGS=-D warnings cargo doc --workspace --no-deps`) **joined**,
added by `82bc0da2` after 75 broken doc links had accumulated where
nothing failed. And `comment-references` (`ci.yml:23`) has a **ruled
exit**: task 118 moves the check out of CI into the implement-phase and
oversee-roadmap skills, on the owner's *"this is a dumb check to put in
CI IMO"*. Six, seven and a future six are three different sets; this
log's table is the seven that exist now.

#### Task 27 — live disk watch for project and RBS files

| # | Criterion | Verdict | Earned by |
|---|---|---|---|
| 1 | Editing a loaded `.cannet_prj` or `.cannet_rbs` on disk updates the GUI without a manual reload | **met** | One `notify` callback dispatches all three watches (`dbc_watcher.rs:219`); project `project_watch.rs:100` → `:133` → `project-changed`, applied at `App.tsx:2213`; RBS `rbs/watch.rs:87` → `:138` → `load_into_element`, notice at `RbsPanel.tsx:379`. Registration follows open / close / save (`project.rs:350`, `:400`, `:441`). "Updates" is deliberately not always a silent swap — ADR 0053 § 1 makes an app-owned document notify when work is at risk, which is the criterion's intent |
| 2 | A transient broken parse leaves the working copy intact | **partially met** | `project_watch.rs:154` parses *before* recording or emitting and returns on `Err`; `rbs/watch.rs:167` likewise, before `outcome_for`. Both parsers have their own error-path tests, but **no test drives either guard** — it rests on a two-line, directly-readable early return inside an `AppHandle`-taking function. Same blocker as criterion 4 |
| 3 | A `VAL_` rename on disk updates the label in the RBS and plot views, driven by a failing test | **met** | Host `tests.rs:6354` `a_val_rename_reloaded_in_place_is_what_the_value_table_lookup_answers`; RBS `RbsPanel.dom.test.tsx:394` "a VAL_ renamed on disk reaches the picker without a manual reload"; plot `PlotPanel.dom.test.tsx:7446` "relabels a lane that mounted before its DBCs were installed". Governed by ADR 0053 §§ 2-4 |
| 4 | Tests cover the reload-and-swap pipeline for both file types | **partially met** | The **reload** half is covered, several parts by mutation-falsification; the **swap** half is not. Walked below |

**Criterion 4 — the verdict on whether inspection suffices.** This is
the one the acceptance record flagged as partial, so it gets the walk
rather than a word.

*Tested.* Every layer that holds a **decision**: event-kind
classification (`dbc_watcher.rs:425`–`:457`, four cases); watch
registration and refcounting (`dbc_watcher.rs:349`–`:401`,
`watched_file.rs:158`, `:169`); is-this-news-or-our-own-write
(`watched_file.rs:138`–`:150`); the RBS safety rule in all four
combinations of clean/dirty × stopped/transmitting (`rbs/watch.rs:239`,
`:244`, `:249`, `:258`, against `outcome_for`); the project safety rule
where it actually lives, frontend-side
(`App.projectWatch.dom.test.tsx:253`, `:260`, `:274`); and the frontend
reaction including Reload, Dismiss and notice-clearing on save and on
close (`App.projectWatch.dom.test.tsx:283`–`:323`,
`RbsPanel.diskWatch.dom.test.tsx:146`–`:194`).

*Not tested.* The OS event hop — never was, for any of the three
watches, and the reason is in the source (`dbc_watcher.rs:332`: FS
watchers are timing-dependent enough to be flaky in CI). And the
functions that **execute** the decision: `project_watch::announce_if_changed`,
`rbs::watch::consider`, and above all `rbs::commands::load_into_element`
(`rbs/commands.rs:46`) and `write_element` (`:431`).

*The recorded blocker is real, and verified.* `apps/gui/src-tauri/Cargo.toml`'s
`[dev-dependencies]` carries only `tempfile`; there is no
`tauri = { features = ["test"] }` anywhere, and no `tauri::test` /
`mock_app` / `mock_runtime` under `apps/` or `crates/`. The failure is
stated in the source itself (`rbs/watch.rs:213`): Tauri's mock runtime
fails to **load** the `cannet-gui` test binary on this platform
(`STATUS_ENTRYPOINT_NOT_FOUND`), *not merely to construct a handle* —
so enabling it takes the whole lib test binary down, which is why it was
reverted rather than left red. No test sits `#[ignore]`d on this.

*The verdict.* **Inspection suffices for the glue; it does not suffice
for `load_into_element` and `write_element` — and the Tauri blocker is
not what stands in the way of testing those.** `on_event`, the three
`project_watch` wrappers and `rbs_dismiss_disk_change` are a path match
and a `match` over an already-tested classifier; reading them is enough.
But `load_into_element` holds the run-flag carry across the swap — which
*is* the load contract's run/stopped preservation — the watch-record
carry, the `changed_on_disk` clear, the shared-file guard applied at the
swap (helper tested, application not), and the fallback that seeds a
default element so a bad file does not blank the panel. `write_element`
clears `dirty` **and** `changed_on_disk` together, which is the
structural claim that the RBS notice cannot go stale. That is state-carry
logic, not plumbing, and a reader confirming it by eye is doing the
test's job.

It is also **reachable today**, which is what makes this a verdict
rather than an owner question: the codebase's own pattern is to lift the
decision out of the `AppHandle`-taking function into a pure one and pin
that — `outcome_for`, `reaction_to` and `is_external` are all that shape
already. The run-flag / watch / `changed_on_disk` carry, and criterion
2's parse guard with it, can be lifted the same way with no Tauri
runtime involved. So both criteria are **partially met with a named,
unblocked path**, and the only judgement left is scope: closing it is
task 27's work, and folding it in here would expand a groomed phase
silently. The acceptance row says so, so the owner can rule when ticking
it.

#### The wrong-rule-pin audit (3.4)

**What was hunted.** Tests that assert a behaviour *because the code
does it*, not because anything decided it should. Task 98 is the case:
nothing in the suite caught a signal drawn two orders of magnitude off
its amplitude, and the two tests nearest the defect asserted the very
per-unit-common-scale rule that produced it. Task 122 flipped a second
one — a test claiming a black `#000000` marker was correctly written
back as absent, because the writer folded `Some(0)` into `None`.

The signature, as applied: a comment justifying an assertion by
describing the implementation; an expected value only obtainable by
running the code; a lossy or degenerate transform asserted as correct;
a test named after a function rather than a rule; and the decisive
question — **would this test still pass if the rule it claims to
protect were inverted?**

Swept with judgement, not exhaustively: the axis / scale / unit /
normalisation tier where the class lives, the format round-trip guards
in `cannet-blf` / `cannet-mdf` / `cannet-dbc`, and a phrase grep for
implementation-describing comments across `apps/`, `crates/` and
`servers/`.

**8 findings — 5 fixed, 3 accepted with reason.**

| # | Site | The pin | Disposition |
|---|---|---|---|
| 1 | `crates/cannet-mdf/tests/write.rs:235`, in `file_backed_signals_come_back_verbatim` | Asserted `got.unit == signal.unit.filter(\|u\| !u.is_empty())` — **the implementation's own transform re-applied to the input** (`write.rs:562` is the same expression). Inert as well as circular: no input had an empty unit, so it passed identically whether the fold was present, removed **or** inverted, while the test's name claimed "verbatim" | **fixed** — the round trip now asserts `got.unit == signal.unit` outright, and the empty-unit case it never covered became its own test stating the rule: `an_empty_unit_is_written_as_no_unit`, because MDF4 says "no unit" with a zero unit address and an empty string means the same thing. *Falsified:* removing `.filter(...)` from `write.rs:562` fails the new test on `an empty unit reads as absent` — and leaves `file_backed_signals_come_back_verbatim` green, which is the old pin's inertness demonstrated |
| 2 | `crates/cannet-mdf/tests/sample_order.rs:85` `a_pre_start_sample_late_in_record_order_leaves_no_descent` | Asserted that a sample stamped 5 ms before the header's start time correctly lands **at** the origin, justified as a format constraint: *"a sample before that origin has no representation on it"*. That describes `u64::saturating_sub` (`write.rs:833`), not MDF4 — the master channel is an `f64` and carries a negative offset perfectly well. A lossy clamp asserted as correct, with a false reason | **fixed, and the behaviour question escalated** — split in two. The named rule keeps its own test, now asserting only what it claims (the series ascends, no sample dropped or duplicated) and saying explicitly that it does not ratify where the sample lands. The clamp is pinned separately as `a_pre_start_sample_currently_lands_on_the_origin_unreported`, whose doc says it is what the writer does today and not a rule anyone decided. **The writer is unchanged**: making a negative offset representable touches the reader, the writer and the save report together, which is a behaviour ruling and not a test audit. See Blockers |
| 3 | `apps/gui/src/PlotPanel.dom.test.tsx:2527`, header of `describe("PlotArea y-normalisation")` | *"These **pin current behaviour** with literal expected values"* — standing over the plot's core data-path suite, which is the exact epigraph task 98's defect grew under. The tests beneath it have since been rewritten to state rules and cite ADR 0026, so the header contradicted its own contents and read as licence for the next author to add a genuine characterisation pin and call it house style | **fixed** — the header now names the two rules the suite protects (an axis draws one scale; a lane is a band the visible lanes share), says literals are kept so a helper change cannot move the expectation with the code, and requires every literal to be derived in its own comment from a rule rather than transcribed from a run |
| 4 | `apps/gui/src/plotData.test.ts:583` `"tolerates mismatched array lengths by walking the shorter one"` | Named after `Math.min(ts.length, vs.length)`. The comment claimed only "shouldn't crash", while the assertion pinned a specific degenerate output whose `tEnd: 1` nothing explained | **fixed** — renamed to the rule it actually protects: *"a timestamp with no value behind it ends the run instead of extending it"*, with `tEnd: 1` derived in-comment from the final-segment rule the function already documents. The assertion is unchanged; only its justification is now real |
| 5 | `apps/gui/src/plotAxisScale.test.ts:128` `"widens around the min when both manual bounds are inverted"` | Bare magic literals, no comment. The codebase gives two opposite answers to the same user error — `parseVisibleRangeInput` *rejects* an inverted range — and only one of them was argued | **accepted, reason written into the test** — the two fields of `YAxisScaleMenu` commit independently (`PlotArea.tsx:426`, Enter and blur), so typing a new min above the old max leaves the pair inverted for as long as it takes to reach the other box; rejecting would blank the axis mid-edit. Anchoring on the bound the user just pinned keeps a readable axis and resolves itself on the next keystroke. That is a decided rule, and now says so |
| 6 | `apps/gui/src/PlotArea.draw.test.ts:563` `"dark: draws exactly what it drew before"` | Named after the code's prior output | **accepted** — the comment already names the rule and its reason (the owner reads the dark theme fine, so every fixture tint must still ink in its own accent). A name that reads as a licence, over a body that is not one; renaming it is churn against a test that is correct |
| 7 | `apps/gui/src/PlotArea.draw.test.ts:547` `"light: keeps the accent the box rescues…"` | Hard-codes which three tints keep their accent and which two fall back, as a measured consequence of `LANE_LABEL_MIN_CONTRAST` | **accepted** — the threshold is derived properly by its sibling `laneLabelInk.test.ts:165`, which is the tier that owns the rule; this is the draw-tier check that the derivation is *reached*. It would need hand-editing on a threshold change, which is the cost of the tier split, not a wrong rule |
| 8 | `apps/gui/src/plotPanelConfig.test.ts:163` `describe("scalar param parsers")` | Named after functions; bounds are literals lifted from the source constants | **accepted** — persisted-layout sanitisation, where the constant *is* the rule and a test restating it in its own words would add nothing. Recorded so the "named after a function" signature is not read as unexamined |

**Swept and found clean — the negative result matters as much as the
findings.**

- **`plotData.ts`'s `axisAutoRange` / `constantRange` and their tests**
  (`plotData.test.ts:457-542`) — fully rehabilitated after task 98.
  Every test now names its rule and cites ADR 0026 (*"unions every
  series on the axis, whatever their units"*, *"unitless series share
  the axis scale like any other"*); the two original wrong-rule pins
  are gone, not renamed. The source rustdoc states the rule
  independently (`plotData.ts:445`: **"An axis draws one scale."**).
- **The rest of `plotAxisScale.test.ts`** — notably *"drops a
  non-positive point on a log axis rather than clamping it"*, which is
  the correct *refusal* of the lossy option and the opposite habit to
  finding 2.
- `plotAxisDerivation`, `plotEnumLanes`, `plotPoints`, `plotSignalLabel`,
  `plotVisibleRange` — rule-named throughout; the lane tests' magic
  numbers are each derived in-comment ("1/6, 1/2, 5/6 of the band").
- **`laneLabelInk.test.ts`** — exemplary: re-derives every expectation
  from `LANE_LABEL_MIN_CONTRAST` and asserts the contrast numbers
  *beside* the colour answers, so an inverted rule fails.
- **The BLF marker / event colour path** — task 122's fix is properly
  guarded (`tests.rs:3546` `a_black_event_colour_survives_a_blf_marker_and_an_mdf_event`
  carries an uncoloured control beside the black case), and **no sibling
  zero-fold survives anywhere in the Rust sources**: the only one left
  was finding 1's.
- **BLF format round-trips** — every one asserts equality with the
  input; the only "does not survive" assertions concern a deliberately
  unset measurement start, and that file names the rule.
- **No snapshot tests exist in project code at all** — zero
  `toMatchSnapshot` / `toMatchInlineSnapshot` / `insta::assert_*`
  outside `node_modules`, which closes off the "expected value is a
  snapshot" arm of the class entirely.
- A phrase grep for `characteris*`, `pins current`, `as implemented`,
  `what the code`, `golden`, `for now`, `happens to`, `mirrors the`,
  `currently`, `locks in what` across `apps/`, `crates/` and `servers/`
  returned exactly one substantive hit — finding 3. The rest are
  ordinary prose.

#### The manual-y-limits row (98's matrix gap)

The 98 matrix was 3 y-axis modes × 5 unit shapes plus a control, and
the manual-range matrix that grew beside it walks 3 modes × 3 value
shapes. **Every manual-range case puts one signal on the axis** — and
with one signal, "the manual range won" and "the series was normalised
against its own extent" are the same arithmetic and cannot be told
apart. So nothing pinned that an axis with explicit y limits governs
**every series on it**.

Closed by coverage, not by a doc row. Two cases in
`PlotPanel.dom.test.tsx`'s manual-range matrix —
`unified` and `per-unit` (`individual` gives each signal its own axis,
which the single-signal cases already cover) — put a 400..500 A signal
and a 0..10 A companion on one axis under a manual `0..1000`, chosen so
the manual range is neither signal's own extent and is not the 0..500
auto union either. Both rows must read 0.4/0.45/0.5 and 0/0.005/0.01,
and the ticks must say `0 A` / `1000 A`.

*Falsification, and what it shows about the gap.* The implementation
was mutated so the axis range governs only the axis's **first** series
while the rest fall back to their own latched extents — the pre-98
shape of one axis carrying two scales under one set of labels, now under
a manual range. Under that mutation:

| suite | result |
|---|---|
| the two new multi-series cases | **fail** — the companion reads 0.5 (its own 0..10) instead of 0.005 |
| the five existing single-signal manual-range cases | pass |
| task 98's own `a drawn series reads as its own data` (9 cases) | pass |

The last row is the interesting one: 98's suite pairs a -200..0 signal
with a -1.5..0 companion, so the axis union *equals* the big signal's
own range and the mutation is invisible to it. The gap was real and
neither suite could see it. `resolveAxisRange` puts manual bounds ahead
of everything automatic by construction (`plotAxisScale.ts:186`); what
was missing was anything asserting that the resolved range then reaches
every row. Both cases pass on the restored implementation.

#### Task 126's own exit criteria

| # | Criterion | Verdict |
|---|---|---|
| 1 | A capture beside a second cannet attributes memory correctly or fails loudly; pinned against faked process tables | **met** (phase 1) — `apps/gui/src-tauri/src/crash.rs:1095` `a_pid_reuse_orphan_is_not_adopted`, `:1113` `an_unreadable_creation_time_is_not_ours`, `:1141` `a_shared_browser_process_fails_loudly_instead_of_reading_zero`, with `:1163` `an_unresolved_host_is_not_an_attribution_fault` as the control that the detector does not fire on a healthy family |
| 2 | The `__shot` helpers are exercised by a test running without a full capture; breaking a helper's selector fails it | **met** (phase 1) — `apps/gui/src/shotPrelude.dom.test.tsx`, 12 tests, loading the byte-identical `crates/cannet-perf-measurement/src/shot-prelude.js` the harness `include_str!`s and driving it against the real components |
| 3 | One clean-machine capture set exists and task 107 phase 5's memory question is answered from it | **not met — owed to the owner.** It needs the machine to itself, which needs the owner; no agent can produce it. Indexed in the checklist's close-out chores |
| 4 | The 3.46 ruling is made on charted evidence and recorded in ADR 0031 before the close-out gate runs | **not met — owed to the owner.** The evidence half is done (phase 1: 206 stored reports, and the spread *within one unchanged binary* — 4.3× median / 27× worst for `lag_ms_max`, 2.3× / 1163× for `rx_gap_short_frac_worst`). The ruling is the owner's and ADR 0031 is amended once it is made. Indexed in the close-out chores |
| 5 | The render report carries a gesture tally; a capture whose script found none of its targets is visibly disarmed | **met** (phase 1) — `interact` in the report (`frontend.rs:118`), `performed: 0` the disarmed signature, `baseline` and `check` printing a `WARNING` naming missed gestures without gating. Landed populated on the verification capture: 445 ticks, 266 performed, 0 missing, all seven gesture labels present |
| 6 | Every demoable frontend surface has a small example file, in LFS; the inventory and README record the decision; `git lfs pull` on a fresh clone yields a working demo set | **met** (phase 2) — three fixture sets, ~112 KB, pinned by 16 tests; `.gitattributes` scoping LFS to `examples/**/*.{blf,part,mf4}` with the scope argued in the file itself; `plans/technology-inventory.md:776` (`adopted`) and README § Prerequisites. The fresh-clone check ran `GIT_LFS_SKIP_SMUDGE=1` first so the before state was real, then `git lfs pull`, then the suites in the clone. Two surfaces have **no furnished file by design** — 104 and 80 both want a multi-million-frame capture, against a set whose value is that it stays small — and both rows say so and name the generator flag instead of implying a file |
| 7 | The § 3 verdict table is complete — every named criterion has a verdict against a named test or artifact — the checklist's acceptance rows match the evidence, and the audit's findings are recorded, each fixed or accepted with its reason | **met** (this phase) — 27 criteria across six tasks, each against a named `file:line` or test; six acceptance rows annotated with their outcome; 8 audit findings, 5 fixed and 3 accepted with reasons written into the tests |
| 8 | Full local CI green — seven jobs, each named with its command | **met** — the table below |

**Two criteria are not met, and both are the owner's**, not deferrals:
3 needs the machine to itself and 4 needs a ruling. Neither is
reachable from an agent session, and the task cannot be called complete
without them.

#### Full local CI — seven jobs, all green

| Job | Command | Result |
|---|---|---|
| comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | pass — no matches |
| rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | pass |
| rust (test) | `cargo test --workspace` | pass — 52 suites, 0 failed |
| rust (clippy) | `cargo clippy --workspace --all-targets -- -D warnings` | pass |
| mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample -- <tmp>/sample.mf4`, then `uv run --with asammdf --with numpy python crates/cannet-mdf/tests/fixtures/validate_export.py <tmp>/sample.mf4` | pass — 30 frames, 15 312 bytes; oracle **OK** |
| frontend (test) | `pnpm --dir apps/gui test` | pass — 225 files, **3 069** tests (3 067 before; +2, the manual-y-limits pair) |
| frontend (build) | `pnpm --dir apps/gui build` | pass |
| python | `uv sync --extra dev --frozen`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy`, `uv run pytest` (in `servers/cannet-python-can`) | pass — 29 formatted, 9 typed, **200** passed |
| sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | pass — froze, licensed, smoke-tested listening on loopback |

Rust test count moved by +2 as well (`an_empty_unit_is_written_as_no_unit`
and `a_pre_start_sample_currently_lands_on_the_origin_unreported`), both
from the audit.

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

### From § 2 (phase 2)

- **Two acceptance rows have no furnished file, by design.** 104
  (determinate load progress) and 80 (a stopped capture's window scan)
  both need a multi-million-frame capture — tens of megabytes against a
  set whose value is that it stays small and opens by hand. Both rows in
  the verification checklist now say **no furnished file** and point at
  the generator flag that writes one locally
  (`gen_annotated_blf -- <dir> <frames>`), so nothing implies a file that
  is not there.
- **Two more need hardware, not files.** 109 item 2 wants a Vector
  adapter unplugged mid-capture; 101's Kvaser leg wants CANLIB. Already
  known; recorded here so the gap list is complete.
- **`cargo test --workspace` now depends on Git LFS.** Several suites
  read `examples/` captures, which are LFS pointers until `git lfs pull`
  runs. CI's `rust` job gained `lfs: true`; a contributor's clone is
  covered by README § Prerequisites. A clone that skips it fails the
  suite on a parse error that does not say why — the honest cost of the
  ruling, and the reason the scope stops at `examples/`.
- **`examples/capture-features/annotated.blf` carries a `busError`-kind
  event**, which `Save Capture` never writes. That is deliberate: a file
  is the only way to put a hidden-by-default kind on screen without a bus
  fault. Noted so nobody reads it as evidence that the writer emits them.
- **The `.gitattributes` close-out chore is only half addressed.** The
  file now exists, carrying LFS patterns. The `eol` entries that would
  stop `examples/ev-zonal/dbc/pack.dbc` and
  `apps/gui/src-tauri/Cargo.toml` showing modified with no content change
  were **not** added — that is a separate chore with its own normalising
  diff, and folding it in here would have buried a 140 KB whole-file
  rewrite inside a fixtures commit. The checklist row says so.
- **No perf capture and no NSIS installer for this phase.** Nothing under
  `apps/` or `crates/` changed behaviour: the diff is fixtures, fixture
  generators, tests, docs, `.gitattributes` and one CI checkout flag.
  There is no render path to measure and no product change to install.

### From § 3 (phase 3)

- **An MDF save can silently clamp a pre-origin sample, and says it
  did not.** `seconds_since` (`crates/cannet-mdf/src/write.rs:833`)
  computes the master-channel offset with a saturating `u64`
  subtraction, so a sample stamped before the header's start time lands
  *at* the start time and its own instant is gone. The clamp is an
  artefact of the arithmetic, not of the format: the master channel is
  written as an `f64` and carries a negative offset perfectly well. The
  BLF capture writer reports the identical clamp to the user
  (`capture.rs:609` `clamped_timestamp_warning`); the MDF save hardcodes
  `max_timestamp_drift_ns: 0, clamped_timestamps: None`
  (`capture.rs:1197`), so the save report claims a faithfulness the
  writer does not deliver.
  **Not fixed here, deliberately.** Making a negative offset
  representable touches the writer, the reader (`timestamps_ns` is
  `u64`) and the save report together, and the alternatives — represent
  it, move the origin, or keep the clamp and report it — are a
  behaviour ruling, not a test audit. The audit's job was the *pin*, and
  that is done: the test that asserted the clamp was correct is split,
  so the rule it legitimately protects stands alone and the clamp is
  pinned separately under a name that says it is what the code does
  rather than what anyone decided. Queued for the owner.
- **Two of task 27's four criteria are partial, and the recorded
  blocker is not the reason.** The Tauri mock runtime genuinely will not
  load the `cannet-gui` test binary on Windows — verified, and the
  source says so at `rbs/watch.rs:213` — but the untested logic
  (`load_into_element`'s run-flag carry and shared-file guard,
  `write_element`'s paired `dirty` / `changed_on_disk` clear,
  `announce_if_changed`'s parse guard) does not need an `AppHandle` to
  be tested. Lifting the decision into a pure function is the pattern
  `outcome_for`, `reaction_to` and `is_external` already follow.
  Recorded rather than done: it is task 27's work, and folding it in
  would expand a groomed phase silently. The acceptance row says so.
- **Task 98's own matrix cannot see a per-series normalisation fault.**
  Its nine cases pair a -200..0 signal with a -1.5..0 companion, so the
  axis union equals the big signal's own range and a mutation that
  normalises non-primary series against their own extents is invisible
  to every one of them. Discovered while falsifying the new
  manual-y-limits cases, which do catch it. Not a defect in what 98
  fixed — a limit of that suite's fixture, now covered.
