# 0116 — RBS Problems Across Every Configuration

> **Opened 2026-08-25** from queue item **1.13ab**, out of the 2026-08-24
> owner walk of [`owner-review-queue.md`](../owner-review-queue.md) § 1.
> **The largest thing that walk produced.**

**Said:** *"I see the RBS mapping launches the signals mapping view … it
should be for all of them, like I specified. We should be able to filter by
RBS file."*

The combined view the original ruling implies **does not exist** — task 103
declined to invent one, and the RBS chip navigates to an individual file
instead.

**The steps-to-reproduce leg is dropped, ruled 2026-08-25:** *"I'm not
looking at it, I don't even remember what was claimed."* There is nothing
to reproduce; the ask stands on its own.

## Work

One view over problems across **every open `.cannet_rbs`**, filterable by
file. The RBS chip opens that, not a single configuration.

Per [ADR 0044](../../docs/adr/0044-gridview-interaction-base.md) and
`CLAUDE.md`'s paged-view rule, it is a view over a host-side model: the
problem set is computed host-side and paged, not assembled in the
frontend from per-file fetches.

## Open

- **Does it replace the per-file view, or sit alongside it?** Recommend
  replace — a per-file view is the all-files view with its filter set, so
  keeping both means two renderers for one model.
- **What the filter is keyed on** — the file path, or a configuration id.
  Recommend the id if one exists, so a moved file keeps its filter.

## Depends on

[Task 113](0113-rbs-as-a-grid.md) settles what an RBS grid row *is*.
Landing this first would build rows 113 then changes.

## Exit criteria

1. **The RBS chip opens a view carrying problems from every open
   configuration**, verified in a running build.
2. **Filtering by file narrows it**, pinned by a test.
3. **The problem set is host-computed and paged**, not accumulated in
   frontend state.
4. **Queue row 1.13's a and b parts struck** with the date.
5. **Full CI green** — six jobs, each named with its command.
