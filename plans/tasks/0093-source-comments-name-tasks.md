# Task 93 — Source Comments Name Task Numbers

Opened 2026-08-20 by the overseer, from a review finding on task 89
phase 6. Not an owner observation — a working-agreement violation the
overseen chain introduced and every phase review missed.

## The rule being broken

`CLAUDE.md` § Documentation:

> **Source code references ADRs only — never plan docs.** Comments and
> rustdoc may cite an ADR (the durable decision) but must not point at
> anything under `plans/` (the roadmap, task files, backlog,
> technology-inventory) or name a task number. The roadmap and tasks
> track state and churn, so a code reference to them rots; ADRs record
> what _is_.

## Measured

`git grep -Ei "task [0-9]+"` over `apps/gui/src`,
`apps/gui/src-tauri/src` and `crates`:

| tree | matches |
|---|---|
| `main` | 17 |
| chain head before task 89 phase 6 | 50 |
| chain head after task 89 phase 6 | 71 |

So the chain under this engagement added **54**, roughly tripling a
violation that already existed. Phase 6 alone added 21.

## Why it matters, concretely

The references rot in two directions. `plans/tasks/0090-*.md` records
item 3 being retired into task 91 and item 1 landing in a different
phase than planned; task 88 was reopened after its exit-criteria walk
with two further phases. A comment reading "task 88 phase 4 ruled a
reload out of scope" is already false in the tree — phase 7 reversed
it. The reader has no way to know that without reading `plans/`, which
is exactly the coupling the rule forbids.

## Scope

- Rewrite every `task N` / `phase N` / `plans/…` reference in source
  comments and rustdoc so it states **the reason inline** or cites the
  governing ADR. The reason is almost always already in the sentence —
  most sites read "(task 89 phase 6): ‹the actual explanation›" and
  simply lose the parenthetical.
- A site whose only content is the task reference — it explains nothing
  without `plans/` — needs the rationale written out, not deleted.
- Include the 17 pre-existing sites on `main`. The rule is repo-wide
  and this is one mechanical sweep; splitting it leaves a violation
  behind that the next reader will copy.
- Test files count: `RbsSignalsPanel.dom.test.tsx` has a test *name*
  carrying "task 89 phase 6", which surfaces in test output.
- **No behavioural change.** Comments and test names only. If a comment
  cannot be rewritten without asserting something the code does not do,
  that is a finding for `## Blockers / side effects`, not a licence to
  change code.

## Open question — grooming

- ~~Should a lint enforce it?~~ **Decided by the overseer 2026-08-20:
  yes, in CI.** The evidence is the measurement above — the rule was
  reintroduced 54 times while every diff was being reviewed, so review
  demonstrably does not enforce it. A `grep` over `apps/` and `crates/`
  failing on `task [0-9]` or `plans/` is a few lines and turns a
  recurring cleanup into a one-time one. It goes in **CI rather than
  the pre-commit hook**: the hook stashes unstaged changes and restores
  them minutes later, which has already destroyed concurrent edits in
  this engagement, so adding work to it is the wrong direction.
  Flagged for the owner to overturn if the tooling is unwanted.

## Exit criteria (draft — firm at grooming)

- No source comment, rustdoc, or test name under `apps/` or `crates/`
  names a task number or references a path under `plans/`.
- Every rewritten site still explains *why* the code is as it is — the
  sweep loses no rationale, it relocates it.
- Test counts unchanged; no behavioural diff.

## Status log

### 2026-08-21 — (branch `task-93-source-comment-refs`)

Branched from `task-91-frame-index-unsorted` at `2046393d`. Five
commits:

| commit | subject |
| --- | --- |
| `c7008419` | Source comments in the GUI host crate stop naming task/phase numbers |
| `e1fa191d` | Frontend source comments and test names stop naming task/phase numbers |
| `a1539bf8` | Other crates' source comments stop naming task numbers or plans/ paths |
| `8359720b` | Add a CI job enforcing no task/plans/ references in source comments |
| `0fdb1e31` | Bare "phase N" references tied to the same swept stories lose them too |

**Counts.** `git grep -Eic "task [0-9]+" -- apps/gui/src
apps/gui/src-tauri/src crates`: **71 matches / 41 files → 0**.
`git grep -Ec "plans/" -- apps/gui/src apps/gui/src-tauri/src crates`:
**4 matches / 4 files → 0**. The CI lint's own pattern
(`task [0-9]|plans/`, case-insensitive, over the whole `apps/` and
`crates/` trees rather than just the measured subdirectories) is also
at **0**.

**How many sites needed rationale written out, versus a parenthetical
deleted.** The large majority (around 65 of the 71 `task N` sites)
already carried the reason in the same sentence — "(task 89 phase 6):
‹the actual explanation›" — and lost only the parenthetical. A
handful needed more:

- `App.dbcChanged.dom.test.tsx`'s header cited "task 86 phase 3" as
  the reason the plot's decimated source missed the disk-watcher path.
  Read against task 86's own status log (recovered from git history —
  the task file was removed from `plans/tasks/` once it shipped) to
  find the actual gap: the plot's resample loop learned to follow the
  frontend-gesture epoch bump in that phase, but nothing translated the
  watcher's `dbc-changed` event into that same bump, which is what this
  seam closes. Rewritten to state that directly.
- `ViewSignalsPanel.tsx`'s sort-execution comment cited "task 89's own
  resolution on the point" for staying host-side. The task file's own
  resolution turned out to be a re-statement of a rule already in
  `CLAUDE.md` (the host sorts, the frontend renders) and in
  `gridviewColumns.tsx`'s own header comment — both already cited
  alongside it — so the task reference was redundant once traced back
  to its source, not load-bearing.
- Four sites in `crates/` cited `plans/technology-inventory.md` for a
  dependency's adoption record. Two (the `flate2` and `crc` crate
  comments) had a real governing ADR the inventory entry itself points
  at (ADR 0009, ADR 0027) and now cite those directly. The other two
  (mdf4-rs's read/write split, the EFF wordlist) have no governing
  ADR — the inventory entry's reasoning was folded inline for the
  mdf4-rs comment, and the wordlist comment turned out to be
  redundant with its own module doc two lines above, which already
  states the reason.
- Four bare "phase N" sites (no "task" word, so outside both grep
  patterns) named the same task-89-phase work already swept elsewhere
  in the same files; left inconsistent, they would have been the
  pattern the next reader copied from. Two of them (`PlotPanel.dom.test.tsx`'s
  un-hide-affordance comments) point at behaviour ADR 0026 documents
  in full, so those cite the ADR; the other two just lost the
  parenthetical.

**No comment's claim turned out to be false.** Read against the task
files and their status logs while writing the rationale out, none of
the rewritten sites asserted something the current code no longer
does — unlike the task file's own worked example (a reload-scope
ruling reversed by a later phase), nothing here needed a correction,
only a citation change.

**Verification.** `cargo test -p cannet-gui`: 837 passed / 6 ignored
(baseline), unchanged. `cargo test --workspace`: green, no failures.
`cargo clippy -p cannet-gui --all-targets` and `cargo clippy
--workspace --all-targets`: clean (one pre-existing `redundant_closure`
warning in `crates/cannet-dbc/src/tests.rs`, confirmed present on the
unmodified parent commit via `git stash`, not touched by this sweep).
`cargo fmt --all --check`: clean. `apps/gui`: `npx tsc --noEmit`
clean; `npx vitest run`: **185 files / 2421 tests**, matching the
stated baseline exactly, test count unchanged.

**The CI lint.** Added as its own job (`comment-references`) in
`.github/workflows/ci.yml`, matching the existing jobs' shape (plain
checkout + shell `run:`, no new tool). Verified to pass on the
finished tree, and verified to fail by adding a temporary violation
of each pattern (`task 999`, `plans/backlog.md`) under `apps/` and
`crates/`, observing `git grep` report it, then removing it — recorded
in the commit message rather than left to be taken on faith.

**Scoping decision, not a gap:** a handful of bare "Phase N" labels
(capital P, no "task" word, no `plans/` reference) remain —
`index.css`'s CSS-section headers (`Phase 7`, `Phase 10 Track 2`,
`Phase 12`, twice) and `crates/cannet-blf/Cargo.toml`'s "Phase 10
Track 1 Step 0" detail beside its ADR 0009 citation. These predate the
current per-task numbering (an earlier global-phase scheme) and
neither name a task number nor point at `plans/`, so they satisfy both
the literal `CLAUDE.md` rule quoted above and the CI lint's own
pattern. Left alone rather than invented a meaning for; flagged below
for an owner call on whether they should go too.

## Blockers / side effects

- **A handful of bare "Phase N" labels remain, deliberately** (see the
  scoping decision above): `apps/gui/src/index.css` lines 3040, 4027,
  4487, 4625, 4764, and `crates/cannet-blf/Cargo.toml` line 21. None
  names a task number or a `plans/` path, so the CI lint added by this
  task does not catch them and the measured baseline in this task's
  own "Measured" section did not count them either. They read as an
  older, pre-task phase-numbering scheme rather than a pointer into
  the current `plans/tasks/` tree. Left as-is; an owner call on
  whether the sweep should have reached them too is welcome, but
  making one up here risked asserting a meaning the comment's author
  never stated.
