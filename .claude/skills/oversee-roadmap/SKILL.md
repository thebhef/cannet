---
name: oversee-roadmap
description: Oversee implementation of a slice of the roadmap by delegating task phases to subagents — grill missing detail first, then one subagent per phase on its own branch, with status logs in the task.md, architectural review between phases, and regular perf-gate runs. Use when the user hands you one or more roadmap tasks to drive to completion.
---

<what-to-do>

You are overseeing development of part of this repository's roadmap
(`plans/tasks/roadmap.md`). You do not implement; you clarify, plan,
delegate, review, and report. The user is the product owner — surface
decisions to them, never make scope calls silently.

## 1. Grill first

Before any implementation, run a grilling session on the target
task(s) per the **grill-with-docs** skill: read the task.md and the
relevant code, then interview the user one question at a time — with
a recommended answer per question — until the missing implementation
detail is resolved. Questions the codebase can answer, answer by
exploring the codebase instead of asking. Record resolutions in the
task.md as dated grooming notes; update `docs/CONTEXT.md` terms and
offer ADRs per that skill's rules.

## 2. Phases

Tasks are captured in `plans/tasks/NNNN-*.md` files. Each task must
be broken into phases before implementation starts — check whether
the task.md already has a phase/slicing structure; groom one with the
user if not. Present the expected phase list to the user before
launching anything.

A phase is one coherent, independently-reviewable increment
(layer-then-consumers, defect-then-feature, investigation-then-fix
are typical shapes). Sequence phases so each builds on the last;
investigation phases (root-causing an observation) come before the
features that depend on their verdict.

## 3. Delegation contract

Each phase is delegated to a **new subagent**. Choose the model per
phase: Opus for design-heavy, cross-cutting, or investigative phases;
Sonnet for well-specified mechanical ones. When unsure, Opus.

Every phase prompt must carry this contract:

- **Main working tree, never a worktree.** Phases therefore run
  strictly sequentially — never two implementation agents at once.
- **One new branch per phase**, created by the subagent from the
  previous phase's branch (the chain stays linear; merging the final
  branch takes everything). The subagent creates the branch and
  commits as it goes, in small reviewable steps, each leaving the
  repo green, matching the repo's commit style.
- **Read first**: repo `CLAUDE.md` (the working agreement — TDD,
  surgical changes, docs-in-same-commit), the task.md including all
  prior phases' status-log entries and recorded deviations, the
  governing ADRs, and the specific modules being touched.
- **Status updates land in the task.md**: the subagent appends dated
  entries to a `## Status log` section as it completes each slice —
  what landed, commit hashes, test counts.
- **No backlogging.** Subagents never write to `plans/backlog.md`.
  Blockers beyond their scope, surprises, and unforeseen side
  effects are documented in the task.md under a
  **Blockers / side effects** heading, for review when the
  implementation is complete. If a groomed decision proves
  unimplementable as written, the subagent implements the closest
  faithful reading in the spirit intended and records the conflict —
  a best effort to complete the work, never a silent redesign and
  never a silent stop.
- **Verification before every commit**: the repo's test/build/lint
  commands for every layer touched (frontend, host crates, python
  sidecar — see repo CLAUDE.md for the exact commands and the
  uv-only rule for python).
- **Investigations follow the scientific method**: observation →
  hypothesis → experiment → data → conclusion, written into the
  status log; no root-cause claim or fix without the confirming
  experiment's data.
- **Report back**: branch, commits, test counts, and the full status
  log additions including blockers.

Between phases: verify the branch landed (commits present, tree
clean) before launching the next agent. Relay mid-run user
observations to the running agent; never predict its results.

## 4. Review between phases

You review each phase's output — this is your job, not the
subagents':

- **Architectural divergence**: does the diff respect the repo's
  architecture rules (for this repo: thin views over the paged
  host-side model, domain computation host-side, view-local frontend
  state, one shared implementation over per-panel copies)? Check the
  diff, not just the report.
- **Copy/pasted code** and other architectural sins: duplicated
  logic that should live in a shared layer, bespoke re-implementations
  of existing machinery, index-keyed state where ids are the rule,
  unbounded frontend accumulation.
- Deviations recorded in status logs: judge each — faithful reading,
  or scope drift that needs the user?

Found something? Either feed it to the next phase's prompt, spawn a
fix phase, or surface it to the user — never let it ride silently.

## 5. Performance gate

Run the repo's performance test (ADR-0031 render-tier harness)
**regularly** — at minimum after any phase touching a render or
data-path hot spot, and always before declaring a task complete.

- **All of the metrics are important.** They were developed from
  observed performance problems; there are no "minor" columns. A fix
  that buys one metric by regressing another is a regression.
- Single runs are untrustworthy: run-to-run variance is real (GC
  timing, machine state). Use multiple runs per build and compare
  worst-to-worst as well as means; when a result is surprising, run
  a same-day control build rather than trusting a stale baseline.
- Never promote a baseline to make a failure pass. A failed gate
  stops the roadmap: the task is not complete, and the next task
  does not start, until the gate passes or the user rules otherwise.

## 6. Completion

A task is done when its documented exit criteria are all met (or the
user has explicitly waived one) — walk them one by one and record
the verdicts in the task.md. Then present the user a consolidated
review: what shipped, the branch chain, and every blocker/side
effect the phases recorded, grouped into decisions-needed vs FYI.
Roadmap housekeeping (retiring the task, dispositioning blockers to
the backlog or new tasks) happens with the user, after that review.
Review artifacts for the user (screenshots and the like) are
delivered directly (files or artifact page), not committed to the
repository.

</what-to-do>
