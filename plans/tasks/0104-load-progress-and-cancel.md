# Task 104 — Real Load Progress, and Cancel That Can Be Found

Opened by owner instruction 2026-08-20, while reviewing the status-bar
prototype:

> number of frames/progress on BLF and cache reload would be nice; we
> walk both on load so we actually already paid the tax for reporting a
> real progress.
>
> I wanna add a cancel button on the blf load; that doesn't seem like it
> should be a heavy enough lift that we need to do much grooming on it,
> but I would accept another task on our current stack.

**These are one task, not two.** Grooming found the same missing
mechanism under both: a cooperative checkpoint inside the census walk.

## What is actually true today

Loading a file has **two phases**, and the app treats them as one
indeterminate wait — a single sliding `.trace-scan-bar` chip.

### Phase 1 — census (`scan_blf_channels` → `cannet_blf::scan_blf`)

Walks the whole file to discover its channels, frame count, timestamp
bounds and markers. **Not cancellable, for a stated reason**
(`App.tsx`, `handleImportTrace`):

> the census phase stays plain-disabled, unchanged, since there's no
> cooperative checkpoint to cancel it at (a single opaque file walk,
> not a per-frame loop).

The launcher is `disabled: true` during it.

### Phase 2 — import (the pump)

**Already cancellable.** `state.kind === "loading"` routes a click on
the launcher to `invoke("cancel_import")`. The button is `busy` but not
disabled, and clicking it cancels.

## The two findings that shape the work

**1. Cancel is half-built and unfindable.** The import half exists and
works; it is spelled as "click the button that looks like it is doing
something and is greyed-ish". A user cannot discover that, which is
functionally the same as not having it. The task is therefore *give
cancel a real affordance*, not *build cancel*.

**2. Progress and census-cancel are the same change.** Both need
`scan_blf` to stop being a single opaque call and yield periodically —
a checkpoint that can report "bytes read so far" is a checkpoint that
can observe a cancel flag. Doing one and not the other would be
building the mechanism twice.

## What determinate progress can honestly be

The owner's point holds, with one refinement worth stating because it
changes the implementation:

| phase | denominator | known when? |
|---|---|---|
| census | **file size in bytes** | before the walk starts |
| import | **`scan.frame_count`** | after the census, exactly |
| cache rebuild | series and their sample counts | before the rebuild starts |

The census's total is *not* known in frames — discovering the frame
count is what the census is for — so it reports against bytes. The
import reports against frames, and `BlfScanResult::frame_count` already
carries the number. That is the tax already paid.

## Scope

- A **cooperative checkpoint in the census walk**: periodic progress
  (bytes read / total) and a cancel check. Cheap enough not to slow the
  walk measurably — measure it, since the census is on the critical
  path of every import.
- **Determinate progress** for census, import and cache rebuild,
  replacing the indeterminate chip in each case. The indeterminate chip
  stays for anything whose length genuinely is unknown.
- **A real Cancel affordance** for both phases, not a second meaning
  overloaded onto the launcher. The status-bar prototype
  (`plans/prototypes/toolbar-status-bar.html`) shows it as an explicit
  button beside the progress bar.
- The MDF counterpart (`scan_mdf_channels`, the "same one-pass-over"
  sibling of `scan_blf_channels`) gets the same treatment, or is
  recorded with the reason it cannot.
- Cancelling must leave **no partial capture** behind — confirm what
  `cancel_import` already guarantees rather than assuming, and pin it
  with a test.

## Open questions — grooming

- **How often should the checkpoint fire?** Too frequent costs walk
  throughput on the critical path; too rare makes cancel feel dead.
  Pick from a measurement of the walk's own rate, not a guess.
- **Does cancelling a census differ from cancelling an import?** A
  cancelled census has produced nothing and can simply stop. A
  cancelled import has frames in the store already — today's
  `cancel_import` has an answer; this task should state it rather than
  inherit it silently.
- **Is per-series or per-sample right for the cache rebuild?** "7 / 31
  series" is honest but lumpy when one series is far larger than the
  rest.

## Exit criteria (draft — firm at grooming)

- Census, import and cache rebuild each show determinate progress
  against a stated denominator.
- Both load phases can be cancelled from a control that looks like a
  cancel control; tested.
- The census checkpoint's cost is measured, not asserted.
- Cancelling leaves no partial capture; tested.
