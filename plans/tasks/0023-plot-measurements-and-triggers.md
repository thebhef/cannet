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

**Log scale moved to task 50**, which is landing manual y-axis min/max
from a right-click menu on the axis. The split follows what each setting
is actually a property of: a log scale is a property of an *axis* (it
changes how a range maps to pixels, and every series on that axis shares
it), whereas offset and gain are transforms on a *series* and stay here.
Grouping log scale with min/max also matches how a user reaches for it —
all three are "control this axis myself."

# Some features and usability notes

- integrate between cursors
- measurements panel doesn't do anything right now; needs overhaul, probably should include a panel view to avoid overloading plot areas
- duty cycle
- amplitude
- period
- live value cursor should be common across plot areas
- per-unit plots currently only collect plots on an axis; they don't share the scale between signals
- still seeing double-plot points frequently; not sure whether issue with tx timing, rx, or plot

(Vertical area resize and per-unit enum packing moved to Task 32.)
