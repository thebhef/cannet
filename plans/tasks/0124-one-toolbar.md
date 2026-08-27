# 0124 — One Toolbar

> **Opened 2026-08-26** by owner ruling on queue finding 3.21: *"feels
> like it's for the common 'toolbar' abstraction if we don't already
> have it. The app-level toolbar and the individual panel toolbars
> should be just about ready to converge. Maybe a new task for that
> later, definitely not immediate scope."*

Task 108 gave every bar the same chip language, so the app-level
toolbar and the ten panel toolbars now *look* converged while still
being hand-laid flex rows, each deciding wrap/overflow for itself. The
convergence they are "just about ready" for is structural: one shared
toolbar control that owns layout, wrap-vs-overflow, and fit.

## Scope (to be groomed when scheduled)

- Extract a shared toolbar component the app bar and the panel bars
  both render through, owning the row layout the bars currently
  hand-write.
- `useToolbarFit` (shipped in task 108 with `StatusBar` as its only
  consumer) either gains its consumers here or the convergence decides
  wrap is the rule and it goes — one answer, not per-bar answers. The
  top toolbar's wrap-vs-overflow question (queue 3.21) is settled by
  whichever this task picks.
- No visual change is the goal: the chip language already matches;
  this is the layout layer beneath it.
- **One filter control** (queue 3.24, ruled 2026-08-26): the RBS
  Signals and View Signals status-filter chips hand-write
  `<button className="status-chip chip-button">` for a per-status tall
  swatch the owner ruled unnecessary — *"I'm not sure they actually
  need to be a different control. The tall color swatch doesn't seem
  necessary."* And the swatch-bearing checkbox rows of
  `EventKindFilter` (the notes/diagnostics filters in the events,
  trace and plot panels) — *"those can all be the same control I
  think."* Converge all of them onto the shared chip control; the
  per-status colour survives as whatever indicator that one control
  offers, not as bespoke markup per bar.

## Not immediate scope

Owner-placed at the back of the current cluster: nothing blocks on it,
and it should not start before the queue's chrome findings are
dispositioned (they touch the same files).

## Exit criteria

Groomed when scheduled; at minimum: every toolbar renders through the
shared control, `useToolbarFit` has either real consumers or no
callers, and no bar's controls or visual output change (pinned by the
existing per-bar tests staying green unmodified).
