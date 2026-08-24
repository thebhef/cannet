---
name: implement-phase
description: Implement one groomed phase of a roadmap task on its own branch, ending in a single squashed commit whose message reads as the PR description. Use when an overseer delegates a phase from plans/tasks/NNNN-*.md, or when you are asked to deliver one self-contained increment of a planned task.
---

<what-to-do>

You are implementing **one phase** of a roadmap task. The overseer
groomed the scope; deliver it in full, verify it, and hand back a
branch ready to review as a pull request.

Your prompt names the task file, the phase, your branch name, its
base branch, and where to work. **Where your prompt contradicts
this skill, your prompt wins** — these are defaults, not a cage.
Four rules are absolute and say so.

## 1. Read before you write

- Repo `CLAUDE.md` — the working agreement: TDD, surgical changes,
  docs in the same commit as the code.
- The task file `plans/tasks/NNNN-*.md`, **all of it**. Prior
  phases' status logs are where they left you warnings.
- The ADRs governing what you are touching.
- The modules themselves — match their idiom, don't import your own.

## 2. Branch and commit

- **Create your own branch from the base you were given**, and do
  all your work on it. The stack is linear, so merging the last
  branch takes everything.
- **It ends as exactly one commit.** Get there however you like —
  WIP commits, whatever helps — then squash in place before
  reporting.
- **Report the pre-squash HEAD hash.** It is orphaned but
  reflog-reachable, and it is the step-by-step history behind your
  squashed diff.
- **The commit message is the PR description.** Repo style:
  sentence-style imperative subject, no trailing period; blank line;
  prose near 72 columns on what changed and *why* — the decision,
  the constraint, what a reviewer should look at. Compose it from
  the branch as a whole, not by concatenating the steps that built
  it. A list of files is not a description.
- **Stage your own paths by name.** Unless your prompt says the tree
  is yours alone, `git add -A`, `git add .`, and `git stash` can
  swallow someone else's edits.
- **Never rewrite history below your branch point**, touch another
  branch's ref, or edit Graphite metadata. The overseer tracks your
  branch after you report.

## 3. Verify before you commit

**Your commit must satisfy every pre-commit hook and every CI job.**
`.pre-commit-config.yaml` and `.github/workflows/ci.yml` are the
canonical lists — read them, don't guess. `CLAUDE.md` has the
per-layer commands and the `uv`-only rule for the python sidecar.

Run **builds and test runs in the foreground** — you need to see
them fail. Backgrounding a process you test *against* (a server, the
sidecar) is fine.

**Let the hook run if you can**; it is the cheapest way to satisfy
the gate. Only a shared working tree stops it: the hook stashes
unstaged changes and will clobber a concurrent edit that isn't
yours. Then, and only then, use `--no-verify`.

**`--no-verify` is a workaround, not an exemption.** Two hook steps
have side effects that are easy to forget:

| Step | If you skip it |
|---|---|
| `cargo fmt --all` | the hook formats *and re-stages* — run it before staging, or you commit unformatted Rust |
| `check_local_paths.py`, `relativize_project_paths.py` | an absolute path from your machine reaches the commit |

**A local pass is not proof CI passes.** The hook scopes checks down
and says so in its own comments: Rust tests cover only the crates
you touched, not their dependents, and the sidecar freeze, the MDF
export oracle, and the source-comment check are left to CI entirely.
If you could break a dependent crate, run `cargo test --workspace`.

New behaviour lands with tests. Bugs are fixed by first writing the
failing test. No flaky tests, no "later".

## 4. The running app and the perf gate

Launch the GUI and run the ADR-0031 harness freely — and do, when
your phase touches the integrated application, a render path, or a
data path.

- Launch via `tauri dev` or the harness. A bare debug binary serves
  no frontend and just yields "localhost refused to connect".
- Kill the process tree afterwards: a leaked host holds the dongles,
  and the next run measures an idle bus.
- Reports go in `docs/performance-measurements/` as
  `YYYY-MM-DD-<commit>[-dirty].json`.
  `crates/cannet-perf-measurement/README.md` is the how-to.

**Collect; do not gate.** The signal is the series across builds,
not any one reading. Measure, log it, keep going — reading the
series is the overseer's job. Two readings are worth interrupting
for, and belong at the top of your report rather than in the log:

- a timing regression **over ~10 ms sustained across every run** of
  a build — not one run, all of them;
- **memory toward 400+ MB** at this load (ev-zonal, ~1608 f/s),
  judged on the process split rather than the tree total.

**Unless performance is the phase's subject** — then the reading is
your acceptance criterion. Measure before and after, keep working
until the metric moves, and report both numbers with what moved
them.

Regardless of why you are measuring:

- **Every metric matters.** Each came from an observed problem.
  Buying one by regressing another is a regression.
- **Never promote a baseline, never widen a limit** — **absolute**.
  Limits ratchet down only; raising one is an owner ruling recorded
  in ADR 0031.
- **Single runs are untrustworthy.** Several metrics are worst-of-N
  tails that move on an unchanged build. Run several, read the band.
- **Sanity-check the load first.** This harness has been silently
  disarmed and *passed* while measuring an idle bus. Check
  `ids_measured` and the rx/tx rates.

## 5. Investigations follow the scientific method

**Observation → hypothesis → experiment → data → conclusion**, in
the status log. Observations are raw data. Experiments must be able
to falsify. **No root cause and no fix without citing the experiment
whose data confirmed it.** If the data refutes the hypothesis, write
the new one down before changing anything else.

## 6. Write it down — briefly

Your reader already has the stack in their head. Respect that:

- **Lead with the finding.** No preamble, no recap of your prompt,
  no summary of what you are about to say.
- **Bullets and tables over paragraphs.** Comparing three things? A
  three-column table.
- **Numbers, paths, hashes, and commands are the content.**
  Adjectives are not.
- **A mermaid diagram when the shape *is* the point** — a state
  machine, a data path, a call chain. Never as decoration.
- **Use the project's words.** `docs/CONTEXT.md` is the glossary. A
  term you coined reads as jargon to everyone after you; if a
  concept genuinely has no name yet, say it plainly rather than
  minting one.

Where it goes:

| What | Where |
|---|---|
| what landed, test counts, the reasoning behind a judgment call | `## Status log` in the task file, dated, written as you go |
| a defect you left, a surprise, a consequence nobody has seen | `## Blockers / side effects` in the task file |
| anything the owner will want to rule on | **also** a line in `plans/owner-review-queue.md` |
| a follow-up or cleanup idea | nowhere — **never write to `plans/backlog.md`**, it is the overseer's |

**The owner review queue is yours to write to**, not overseer-only.
Two rules:

- **Index, not a second record.** The detail lives in the task file;
  the queue line says what the finding is and points at it.
- **File under an existing heading, and leave the rest alone** —
  usually *"Behaviour changes that need a yes or no"* or *"Open
  findings nobody has dispositioned"*. Recording rulings and
  striking items out is the overseer's job.

Filing an item is never a reason to stop.

**If a groomed decision proves unimplementable as written**,
implement the closest faithful reading in the spirit intended and
record the conflict. A best effort to finish — never a silent
redesign, never a silent stop.

**Docs move in the same commit as the code**: README, rustdoc on
changed public APIs, planning docs. A behavioural change without its
doc update is incomplete.

## 7. Absolute constraints

Each exists because it already went wrong once. Do not work around
one; if it blocks your phase, stop and report.

- **Only `cannet-server`, at its canonical `target/debug/` and
  `target/release/` paths, may reach the network.** The owner's
  firewall has exactly one rule, for those paths. Any other binary
  opening a listening socket on a real interface — a cargo test
  binary at `target/debug/deps/<crate>-<hash>`, an example, a copy
  in a temp directory — raises a prompt nobody is there to answer,
  and each hash-named one-off would need its own permanent rule. So
  run the server with `cargo run -p cannet-server` or from its built
  path, never renamed or relocated; bind anything else that listens
  to **explicit loopback**, never a wildcard; and **never advertise
  a real `_cannet._tcp` instance** — use the harnesses'
  non-advertising paths.

  A gated process is not refused, it *hangs*. **If a port-binding
  process hangs, rule this out first** — before a deadlock, a slow
  build, or your own code — then stop rather than retry. It says
  nothing about a hang in a process that binds no port.
- **No UI automation.** Synthetic input lands in whatever window has
  focus on the owner's machine. Verify by invoking commands
  directly, or hand the check to the overseer.
- **No task numbers or `plans/` paths in source comments.** Cite
  ADRs — the durable decision — never the roadmap, which churns. CI
  enforces this (`comment-references`), and it searches untracked
  files too.

## 8. Report back

One commit, green, then report — short, in this order:

- branch name and commit hash; pre-squash HEAD if you squashed
- the commit message you composed
- perf readings, anything over § 4's thresholds first
- test counts per layer, and the commands you ran
- status-log, blockers, and queue entries you added
- what you deviated on, and why

Do not push, open a PR, or merge. The overseer takes it from there.

</what-to-do>
