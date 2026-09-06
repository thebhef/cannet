# 0131 — Grow Live

> **Opened 2026-08-31** by owner instruction: *"'grow live' behavior:
> keep left edge at first sample in capture, and right edge at live
> edge … we run in that mode for some period of time and then begin
> follow live with whatever that duration is. This is a new mode."*

A third x-range behaviour beside manual and **Follow**. Follow slides:
it pins the right edge to the capture's growing edge and keeps the
visible width. **Grow live** anchors both ends: the left edge stays at
the capture's first sample, the right edge rides the live edge, so the
window widens as data arrives.

The two compose over a connection's life: grow live runs for some
period after connect, then hands off to Follow — with the width the
growth reached as Follow's window.

## Scope (to be groomed when scheduled)

- The new mode in the plot's x-range machinery, beside Follow, with
  the same break-out rule (a manual x pan/zoom turns it off).
- The post-connect sequence: grow live for the duration, then Follow
  at the grown width.

## Open questions

- The duration: fixed, configurable, or something else — and does it
  restart on reconnect and on clear?
- Is grow live also a standing, user-selectable mode (a toolbar state
  beside Follow), or only the automatic post-connect phase?
- Per panel or app-wide; persisted with the panel the way its
  siblings are?

## Exit criteria

Groomed when scheduled; at minimum: after connecting, the plot's
window visibly grows from the first sample, then follows at the grown
width; the transition and the break-out are pinned by tests; Follow
on its own behaves exactly as before.
