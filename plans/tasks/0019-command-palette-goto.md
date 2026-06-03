# Task 19 — Command Palette + Goto Framework

The framework itself (registry, bindings, palette,
`Cmd/Ctrl+Shift+P`, `Cmd/Ctrl+P` go-to-view, fuzzy matcher) ships
in **Task 16**. What's left for this task is the
**specialised commands** that need richer UX than zero-arg
toolbar lifts — commands that prompt for an argument, drive a
view to a target, or compose a multi-step action: `goto.traceRow`
(absolute row index — the "Go to row…" backlog item),
`goto.timeInTrace` (absolute or relative time), `plot.setVisibleRange`,
`capture.save` (with a path picker), `palette.argumentForms` (the
shared input-prompt UI). Part of the task is the explicit
decision on what belongs in the palette (broad, project-wide,
keyboard-accessible) vs. what stays local-only (right-click menus,
panel toolbars) — the model has to be deliberate about that
boundary.
