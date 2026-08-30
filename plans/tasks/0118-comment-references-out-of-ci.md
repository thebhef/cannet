# 0118 — The `comment-references` Check Leaves CI

> **Opened 2026-08-25** from queue item **1.35**, out of the 2026-08-24
> owner walk of [`owner-review-queue.md`](../owner-review-queue.md) § 1.
> Not product work — process.

**Ruled:** *"this is probably a necessary check but we can put it in our
subagent skill."* Then, on where exactly, and on CI:

> *"Put it in the subagent and overseer. this is a dumb check to put in
> CI IMO."*

**The check stays; its home changes.** It enforces `CLAUDE.md`
§ Documentation — source comments may cite an ADR but must not name a task
number or a `plans/` path.

## Work

| | |
|---|---|
| Remove | the `comment-references` job, [`ci.yml:23-47`](../../.github/workflows/ci.yml#L23-L47) |
| Add to | [`.claude/skills/implement-phase`](../../.claude/skills/implement-phase) — the agent runs the grep before it commits |
| Add to | [`.claude/skills/oversee-roadmap`](../../.claude/skills/oversee-roadmap) — the overseer runs it when reviewing a phase's diff |

The grep is unchanged, `--untracked` included — it is load-bearing off CI,
where a just-written file is not yet tracked:

```sh
git grep --untracked -Ein "task [0-9]|plans/" -- apps/ crates/
```

**Every phase's CI table becomes five jobs**, not six. Both skills say six
today and change with this.

> **2026-08-27:** stale. This count predates `rustdoc` joining CI as its
> own job. Reality at this phase's start is **seven** jobs
> (`comment-references`, `rustdoc`, `rust`, `mdf-export-oracle`,
> `frontend`, `python`, `sidecar-freeze`); removing `comment-references`
> leaves **six**, not five. The exit criteria and both skills are updated
> to say six.

## Recorded, not argued

The job's own comment says why it was put in CI: the violation *"recurred
dozens of times while every diff introducing it was under review, so it is
enforced here instead of relying on review alone."* Moving it back to
instruction-level enforcement returns to what failed then — now with two
enforcement points instead of one. **The owner has ruled; this is the risk
being accepted, recorded so a recurrence is recognised rather than
rediscovered.**

The pre-commit hook is not an option: it stashes unstaged changes and has
destroyed concurrent edits in this repo (queue 3.48).

## Exit criteria

1. **The CI job is gone** and `ci.yml` has six jobs.
2. **Both skills instruct the grep**, with the `--untracked` spelling and
   the reason.
3. **Both skills' CI tables say six jobs.**
4. **Queue row 1.35 struck** with the date.

## Status log

- 2026-08-27: Removed the `comment-references` job from
  `.github/workflows/ci.yml` (its `git grep --untracked` step and
  surrounding comment). `ci.yml` now defines six jobs: `rustdoc`,
  `rust`, `mdf-export-oracle`, `frontend`, `python`, `sidecar-freeze`
  (exit criterion 1).
- 2026-08-27: Corrected this task's own stale count — it predates
  `rustdoc` joining CI, so the pre-change total was seven, not six;
  the post-change total is six, not five. Noted inline above and
  folded into the exit criteria.
- 2026-08-27: `implement-phase/SKILL.md` § 3: dropped the
  `comment-references` row from the CI-job table (now six rows) and
  added the hand-run grep, `--untracked` spelling and all, as its own
  paragraph right after the table, with the reason (a just-written
  file isn't tracked yet) and what a hit means. § 7's "No task
  numbers…" bullet no longer credits CI for enforcement; it now
  points back at § 3. § 8's report-back bullet says "all six" plus
  the hand-run grep (exit criterion 2, 3).
- 2026-08-27: `oversee-roadmap/SKILL.md` § 3: "seven-row CI table" →
  "six-row … plus the hand-run `comment-references` grep". § 4
  (Review between phases) gained a "Comment references" bullet
  instructing the overseer to run the same grep over the phase's diff
  before accepting it, with the same command (exit criterion 2, 3).
- 2026-08-27: Checked `.pre-commit-config.yaml` — it never ran this
  check (the task's "not an option" reasoning, § Recorded, not
  argued, was about not *adding* it there, and it wasn't there to
  remove). Left untouched; consistent with the ruling.
- 2026-08-27: Struck queue row 1.35 via a new `118` row in
  `plans/owner-review-queue.md`'s Acceptance list, following the
  post-reframe precedent (queue item cited as no-longer-existing,
  closure pointed at this status log). Also corrected the row-110
  aside that anticipated this task — it previously said "task 118
  takes `comment-references` back out" (future tense); now says it
  happened and CI is six again (exit criterion 4).
