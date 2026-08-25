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

1. **The CI job is gone** and `ci.yml` has five jobs.
2. **Both skills instruct the grep**, with the `--untracked` spelling and
   the reason.
3. **Both skills' CI tables say five jobs.**
4. **Queue row 1.35 struck** with the date.
