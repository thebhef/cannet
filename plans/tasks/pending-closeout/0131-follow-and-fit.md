# 0131 — Follow + Fit

> **Opened 2026-08-31** by owner instruction: *"'grow live' behavior:
> keep left edge at first sample in capture, and right edge at live
> edge."* Groomed and implemented 2026-11-14; awaiting the owner's
> acceptance.

A third x-range behaviour beside manual and **Follow**. Follow slides:
it pins the right edge to the capture's growing edge and keeps the
visible width. **Follow + Fit** anchors both ends: the left edge stays
at the trace window's first sample, the right edge rides the live edge,
so the window widens as data arrives. It is what turning Follow on and
then pressing "fit data" on every frame would give, drawn smoothly.

## Design (owner rulings, 2026-11-14)

- **A standing mode, not a timed phase.** No duration, no setting, no
  automatic hand-off. Plain Follow already grows from the start until
  the capture reaches `follow_window_ms`; that is unchanged.
- **Name:** "Follow + Fit" — "grow" on its own does not say what it
  does.
- **One choice of three.** Manual, Follow, Follow + Fit. The toolbar
  has a chip for each follow mode; pressing one leaves the other.
- **Keys** (plot focused): `g` enters Follow + Fit (enable-only, like
  `l`); `l` enters plain Follow; `f` fits once. From Follow + Fit, `f`
  and `l` both drop to plain Follow at the width the window had grown
  to.
- **Y is fitted too.** Entering the mode drops a pinned Fit Y, as a
  "fit data" press does, so each axis follows the capture's extent —
  the same result as fitting and then turning Follow on. Typed y
  bounds stay, as they do under Fit Data (ADR 0026).
- **Break-out:** a manual x pan/zoom leaves it, the same rule as
  Follow. A zoom that keeps Follow on keeps Follow, at the zoomed
  width.
- **Clear / reconnect:** the left edge re-pins to the new window start
  (ADR 0024 — a Clear re-anchors, it does not re-zero).
- **Per panel**, persisted on the element as `followFit` beside
  `followLive`.

## Exit criteria

- With Follow + Fit on and a trace running, the window's left edge
  stays on the first sample and the right edge follows the live edge —
  pinned by `followWindow.test.ts`.
- The chip, the `g` binding, and the `f` / `l` hand-offs are pinned by
  `PlotToolbar.dom.test.tsx`, `commands.test.ts` and
  `PlotPanel.dom.test.tsx`.
- Follow on its own behaves exactly as before (its existing tests
  unchanged and green).
- README § plot, `docs/CONTEXT.md` and ADR 0018 name the mode and its
  command.

## Status

All criteria met 2026-11-14. Not exercised against a live bus by the
implementer — owner to confirm the feel on hardware.
