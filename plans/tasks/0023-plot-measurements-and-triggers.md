# Task 23 — Plot Measurements and Triggers

The plot-panel feature tail. The "show points" tri-state shipped in
**Task 15** and the `f` / `l` hotkeys shipped in **Task 16**.
What's left for this task: **Triggers** (edge / level / value-match
on a
chosen signal that freeze the view and emit an event marker —
oscilloscope trigger proper; the event-line rendering already
exists, the trigger engine doesn't). **Math channels** (derived
signals computed from other signals — also useful to the transmit
panel and a future scripting surface, so it may outgrow plotting).
**Manual per-series y** — now **offset / gain only**. **CSV / image
export** of the visible window or cursor span. **Drag a whole plot
area** (not just a signal) between plot panels.

**Log scale moved to task 50 and shipped there** (manual y-axis
min/max/log from a right-click menu on the axis; task 50 is retired —
detail in git history and ADR 0026). The split follows what each setting
is actually a property of: a log scale is a property of an *axis* (it
changes how a range maps to pixels, and every series on that axis shares
it), whereas offset and gain are transforms on a *series* and stay here.
Grouping log scale with min/max also matches how a user reaches for it —
all three are "control this axis myself."

# Some features and usability notes

- integrate between cursors
- measurements panel doesn't do anything right now; needs overhaul, probably should include a panel view to avoid overloading plot areas
- **Inherited from task 108's suppression of the measurement strip**
  (owner 2026-08-26, queue 3.22: *"make sure the measurement rework
  task mentions it"*): the strip is gated off by
  `MEASUREMENT_STRIP_DRAWS = false` with stored `measEnabled` left
  intact, so this rework inherits real user preferences. Two things it
  must pick up: `MeasurementMenu` is a deliberate orphan (delete or
  revive, not ignore), and the panel-tier test that guarded the
  strip-to-derivation seam (a derived-axis id mismatch) was removed —
  the derivation is covered at unit tier by `plotAxisDerivation.test.ts`
  but the seam is unguarded and this task writes that test again,
  failing first.
- duty cycle
- amplitude
- period
- live value cursor should be common across plot areas
- per-unit plots currently only collect plots on an axis; they don't share the scale between signals
- still seeing double-plot points frequently; not sure whether issue with tx timing, rx, or plot

(Vertical area resize and per-unit enum packing moved to Task 32.)
