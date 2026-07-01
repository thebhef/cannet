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
**Manual per-series y** (offset / gain / log scale, overriding the
auto-norm that ships today). **CSV / image export** of the visible
window or cursor span. **Drag a whole plot area** (not just a
signal) between plot panels.

# Some features and usability notes

- integrate between cursors
- measurements panel doesn't do anything right now; needs overhaul, probably should include a panel view to avoid overloading plot areas
- duty cycle
- amplitude
- period
- live value cursor should be common across plot areas
- dragging size of plot areas/individual traces vertically
- per-unit plots currently only collect plots on an axis; they don't share the scale between signals
- still seeing double-plot points frequently; not sure whether issue with tx timing, rx, or plot
