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

Every finding here is a check that passed while measuring nothing — the
silent-disarm family.

- **3.35 — memory metrics are not isolated.** Windows never clears a
  dead parent's `ParentProcessId`, so `descendant_pids` (`crash.rs`)
  adopts unrelated orphans on pid reuse (a 4 GB foreign app was measured
  as ours), and when another cannet owns the shared WebView2 browser
  process our own renderer is *not* our descendant — `webview_mb` reads
  0.0 and the gate passes. Fix the attribution (ground-truth
  `Win32_Process` walk, job objects, or equivalent), and make an
  implausible zero **fail loudly** instead of passing.
- **3.62 — the `__shot` helpers have no guard test.** `importIdle()`
  silently returned true mid-import when the label it polled for was
  restyled away; fixed, but the helpers are JS embedded in a Rust
  string, exercised only by a real capture run, so the next markup
  change breaks them just as silently. Add a test that exercises the
  helpers without a full capture run.
- **3.36 — one clean memory capture set.** Task 107 phase 5's memory
  behaviour is unmeasured because every capture ran beside the owner's
  own cannet (which 3.35 makes unreadable). One capture set with the
  machine to itself, coordinated with the owner.
- **3.46 — the two unstable metrics get their ruling on evidence.**
  `lag_ms_max` spanned 2.8–37.6 ms against a 41 ms limit across eight
  captures of one unchanged binary; `rx_gap_short_frac_worst` breached
  on a byte-identical GUI. Chart the distributions across every stored
  run and put the band-vs-worst-of-N question to the owner **before**
  the close-out gate, with ADR 0031 amended per the ruling (limits still
  ratchet down only).
- **The interaction script's gestures are counted.** Every gesture
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
