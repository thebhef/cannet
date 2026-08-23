# Task 97 — Enum Values Still Appear on Axis Labels

Opened by owner instruction 2026-08-20, from 0.9.0 usage feedback:

> enum values still appear on the axis labels sometimes. they
> shouldn't. It looks really bad when there are long names or hundreds
> of values, and isn't more needed with the overlay

## The site, and why "sometimes"

`PlotArea.tsx` builds the y-axis three ways. The middle branch fires
when `enumActiveAtConstruct` and emits **one split per enum raw value**,
formatted as the raw value followed by the quoted label:

```js
splits: () => enumRaws,
values: (_u, splits) => splits.map((v) => `${v} "${enumLabelFor(Math.round(v))}"`),
```

with a gutter reserved at `trackGutter(areaId, 80)`.

"Sometimes" is precise, not vague: the branch is gated on
`enumMode = !laneMode && isEnumValueTable(valueTable) && signals.length === 1`.
So it fires only for a **single-signal area, not in lane mode, whose
signal has an enum value table** — which is why the owner sees it
intermittently rather than always.

The failure mode follows directly from `splits: () => enumRaws`: the
tick count is the size of the value table. A signal with hundreds of
enum values gets hundreds of ticks; long names blow out the gutter.

## Why it should go

The owner's reason is that the **enum overlay** (delivered by task 86)
already shows the label at the point of interest, so duplicating every
label down the axis buys nothing and costs the gutter. This is a
removal, not a redesign.

## Scope

- Remove enum labels from the axis. What replaces them — plain numeric
  ticks, a small fixed number of ticks, or no y-axis ticks at all for
  an enum area — is the grooming question below.
- Reclaim the 80px gutter reservation when the labels are gone.
- Check the **enum-lanes** axis (`DerivedAxisKind = "enum-lanes"`,
  `plotAxisDerivation.ts`) separately — it is a different branch with
  its own labelling, and the owner's complaint may or may not cover it.

## Open questions — grooming

- ~~What does an enum area's y-axis show instead?~~ **Decided by the
  overseer 2026-08-20: ticks at the enum raw values, labelled with the
  raw number only, capped and thinned.** The raw values are the only
  meaningful positions on an enum axis, so keeping them preserves the
  reader's sense of scale; dropping the label text is the whole of the
  owner's complaint, and the overlay supplies the name at the point of
  interest. The gutter then shrinks to numeric width.

  **The cap is not optional.** `splits: () => enumRaws` has no bound at
  all today, so a several-hundred-value table emits a tick per value
  regardless of pixel height. Thin to what fits, the way the numeric
  branch already does.

- **Does this apply to the enum-lanes axis too?** Left open — it is a
  different branch (`DerivedAxisKind = "enum-lanes"`) with its own
  labelling, and the owner's report says "axis labels" without
  distinguishing. The implementing phase should **show the owner both**
  before changing the lanes axis, since lane labels may be the thing
  that makes lanes readable at all.

## Exit criteria (draft — firm at grooming)

- No enum label text is drawn on a y-axis.
- An enum signal with hundreds of values renders with a bounded number
  of ticks and a gutter sized to what is actually drawn; tested.
- The enum overlay still identifies values, unchanged.
