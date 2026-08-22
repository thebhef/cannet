---
name: oversee-roadmap
description: Oversee implementation of a slice of the roadmap by delegating task phases to subagents — grill missing detail first, then one subagent per phase on its own branch, with status logs in the task.md, architectural review between phases, and regular perf-gate runs. Use when the user hands you one or more roadmap tasks to drive to completion.
---

<what-to-do>

You oversee part of this repository's roadmap
(`plans/tasks/roadmap.md`). You do not implement: you clarify, plan,
delegate, review, and report. The user is the product owner —
surface decisions to them, never make scope calls silently.

## Reporting to the owner

They are reading between other work. Every report you write:

- **Lead with the finding**, then the evidence. No preamble, no
  recap of the request.
- **Bullets, tables and figures over paragraphs.** A table of five
  branches beats five sentences about them.
- **Numbers, paths, hashes and commands carry the content.**
  Adjectives do not.
- **A mermaid diagram when the shape is the point** — a branch
  chain, a state machine, a data path. Never as decoration.
- **Use the project's words.** `docs/CONTEXT.md` is the glossary. A
  term you coined is jargon to the owner and costs them a question;
  if a concept genuinely has no name yet, say it plainly, or propose
  the term explicitly as a glossary addition.

The `implement-phase` skill holds phase agents to the same standard.

## 1. Grill first

Before any implementation, run **grill-with-docs** on the target
task(s): read the task file and the relevant code, then interview
the user one question at a time, each with your recommended answer,
until the missing implementation detail is resolved. Whatever the
codebase can answer, answer from the codebase instead of asking.
Record resolutions in the task file as dated grooming notes; update
`docs/CONTEXT.md` terms and offer ADRs per that skill's rules.

## 2. Phases

Every task in `plans/tasks/NNNN-*.md` is broken into phases before
implementation starts. If the task file has no slicing structure,
groom one with the user. **Present the phase list before launching
anything.**

A phase is one coherent, independently-reviewable increment —
layer-then-consumers, defect-then-feature, investigation-then-fix
are the usual shapes. Sequence them so each builds on the last, and
put an investigation ahead of whatever depends on its verdict.

**Budget wall clock at grooming.** Name any experiment measured in
hours, with an estimate, while grooming — never let the owner
discover it mid-phase from a status log. Then look for the cheaper
equivalent:

| Regime | Cheap substitute |
|---|---|
| store or cache behaviour at scale | measure in-process at direct-API scale — minutes, not hours |
| wide windows, long captures | generate a BLF spanning hours of timestamps and import it; import + Fit Data reproduces the regime in minutes |
| the live edge on top of a long capture | seed from the generated file, then attach the virtual-bus rig for a short live tail |

Only **real-time currency** — how far an edge lags wall clock —
genuinely needs elapsed time. Spend hours-long live runs on that
alone, scheduled, as confirmation.

## 3. Delegation

One **new subagent** per phase. Opus for design-heavy,
cross-cutting or investigative phases; Sonnet for well-specified
mechanical ones; Opus when unsure.

**The subagent's expectations live in the `implement-phase` skill.**
Tell the agent to invoke it, and do not restate it. Your prompt adds
only what is specific to this phase:

- the task file, and which phase
- the branch name to create, its base branch, and where to work —
  the shared main tree, or a worktree of its own
- the groomed scope, and the exit criteria it aims at
- the governing ADRs and the modules in play
- what the previous phase's review turned up that this one must
  respect
- your framing: what is already decided, what to be careful about

**Agents sharing the main working tree run strictly sequentially** —
two at once will clobber each other. A worktree buys overlap at two
costs: phases still stack linearly, so a later phase built on an
unfinished earlier one needs a rebase; and each worktree needs its
own build, which is not free here.

When an agent reports back, before launching the next:

1. **Verify the branch landed as contracted** — one commit on its
   base, tree clean, and a commit message that reads as a PR
   description rather than a changelog. Still a chain of commits?
   Have the agent squash first. **Keep the pre-squash HEAD hash** —
   orphaned but reflog-reachable, and the step-by-step history
   behind the squashed diff.
2. **Track it in Graphite** if `gt` is available:
   `gt track <branch> -p <previous phase's branch>`, then confirm
   the stack is still linear and needs no restack. If `gt` is
   absent, skip it and say so.
3. **Review the diff** (§ 4).

Relay mid-run user observations to the running agent. Never predict
its results.

## 4. Review between phases

Reviewing each phase's output is your job, not the subagents'. Read
the **diff**, not just the report.

- **Architectural divergence** — in this repo: thin views over the
  paged host-side model, domain computation host-side, view-local
  frontend state, one shared implementation over per-panel copies.
- **Copied code and its relatives** — duplicated logic that belongs
  in a shared layer, bespoke re-implementations of existing
  machinery, index-keyed state where ids are the rule, unbounded
  frontend accumulation.
- **Deviations in the status log** — faithful reading, or scope
  drift that needs the owner?

Found something? Feed it to the next phase's prompt, spawn a fix
phase, or surface it. Never let it ride silently.

## 5. Performance gate

**Collect as you go; judge at the end.** A release build plus four
60 s captures is under twenty minutes, and the signal is the
*series*, not any one reading. Take data after a phase touching a
render or data-path hot spot and at cycle boundaries; keep every
report in `docs/performance-measurements/` as
`YYYY-MM-DD-<commit>[-dirty].json`.

**The phase agent usually takes the reading.** `implement-phase`
tells it to whenever its work touches the integrated application, a
render path, or a data path, and to report without judging. Reading
the series stays yours.

**Development stops only for a major, anticipated regression.** The
owner's thresholds (2026-08-22):

| Signal | Threshold |
|---|---|
| timing | more than ~10 ms sustained across **all** runs of a build — not one run |
| memory | creeping toward **400+ MB** at this load (ev-zonal, ~1608 f/s); judge the process split, not the tree total |

Anything short of that is recorded, and development continues. A
single alarming run is data, not a stop signal.

**At the end of a chain, produce the report and decide whether to go
back.** Chart every metric across every build measured — its limit,
its baseline, the per-build spread, and what did and did not move
it. That report, not a per-phase pass/fail, is what tells the owner
whether to revisit anything.

Invariants:

- **Every metric matters.** Each came from an observed problem;
  there are no minor columns. Buying one by regressing another is a
  regression.
- **Never promote a baseline, never widen a limit.** Limits ratchet
  down only; raising one is an owner ruling recorded in ADR 0031.
- **Single runs are untrustworthy.** Worst-of-N and single-sample
  tails move on an unchanged build — an eight-run control on one
  binary spanned nearly the whole distance to `lag_ms_max`'s limit.
  Read the band.
- **Surprising reading? Build a same-day control.** The older commit
  measured on today's machine is the honest comparison; a stored
  baseline may come from a different machine state, or from a
  project that has since changed.

Two failure modes this repo has actually hit:

- **A baseline can outlive the project it describes.** Growing the
  example projects (ev-zonal is the harness's) invalidates a
  line-for-line comparison. Gate a pre-growth control alongside the
  current tree and report the pair.
- **The harness's load can be silently disarmed.** It once drew bus
  traffic from a persisted project field; removing that field left
  it measuring an idle bus — and *passing*. Check `ids_measured` and
  the rx/tx rates before reading anything else into a report.

## 6. The owner review queue

Phases turn up things nobody asked for. **None of it is a reason to
stop.** Development stops for exactly two things: a blocker that
makes the *current* work impossible, and a major anticipated perf
regression (§ 5).

Everything else goes in **`plans/owner-review-queue.md`**, one file
the owner can walk when they have time. Without it, findings either
interrupt them one at a time or vanish into a blockers section and a
long conversation.

**Phase agents write to it too.** You **curate**: fold in what your
review turns up, merge duplicates, record rulings, strike items out.
Read the file after each phase — an entry an agent filed is one you
have not seen.

It is an **index, not a second record**: the detail stays in the
task file's `## Blockers / side effects` or status log, and the
queue points at it. Its headings:

1. **Behaviour changes needing a yes or no** — shipped, each
   reversing or extending something previously decided. Say what
   undoing it would take.
2. **Rulings the owner has made**, so they survive the conversation
   — including any correction to the premise a ruling rested on.
3. **Open findings nobody has dispositioned** — a table is enough.
4. **Finished tasks awaiting acceptance.**
5. **Housekeeping owed at close-out.**

Two rules keep it useful:

- **Strike items out with the ruling and its date** rather than
  deleting them, so the record shows what was decided.
- **A queue growing faster than it drains means stop taking new work
  and hold a review.** Say so when it happens.

**Surface an item once**, in the report for the phase that found it.
Then let the queue carry it.

### When a task really is blocked

An owner decision that genuinely blocks a task stops **the task, not
the roadmap.** Move to the next task not waiting on the same
decision, and record what the blocked one waits for.

Check the dependency honestly first: queued tasks often share a
ruling, and starting one that turns on the same unanswered question
just produces a second blocked task and a diff to redo. When a whole
run of upcoming tasks depends on one decision, stop and ask rather
than working around it.

## 7. Completion

A task is done when every documented exit criterion is met, or the
owner has explicitly waived one. Walk them one by one and record the
verdicts in the task file. Then present a consolidated review:

- what shipped, and the branch chain
- every blocker and side effect the phases recorded, split into
  **decisions needed** and **FYI**

Roadmap housekeeping — retiring the task, dispositioning blockers to
the backlog or new tasks — happens with the owner after that review.
Review artifacts such as screenshots are delivered directly, as
files or an artifact page, never committed to the repository.

</what-to-do>
