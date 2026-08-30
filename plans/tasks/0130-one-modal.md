# 0130 — One Modal

> **Opened 2026-08-30** by owner instruction, as the modal companion to
> task 124's toolbar convergence: bring the app's modal dialogs under a
> common base.

The GUI has six modal-ish components, and what they share is CSS and a
convention — not code. `.modal-backdrop` / `.modal` / `.modal-message`
/ `.modal-buttons` (`index.css`) are the one genuinely common layer;
the *behavior* ("Escape / backdrop click mean Cancel") is stated in
each component's doc comment and wired by hand in each:

- `CloseConfirmModal.tsx` — own `useEffect` document-level Escape
  listener; backdrop click cancels; `stopPropagation` on the body.
- `ClearColorsConfirmModal.tsx` — an identical copy of that pattern.
- `ServerTrustDialog.tsx` — same trio, plus `autoFocus` on a button;
  `.modal.server-trust` width modifier.
- `PaletteModal.tsx` — Escape handled on the input's `onKeyDown`
  instead of a document listener; `autoFocus` input.
- `CalcFieldEditor.tsx` — diverges: `role="dialog"` on the *backdrop*,
  `.modal-title`/`.modal-actions` instead of
  `.modal-message`/`.modal-buttons`.
- `BlfChannelMapModal.tsx` — `.modal-overlay` (a wider backdrop
  variant); the only one with a real focus trap (Tab cycling), and the
  only one that consumes Escape with `stopPropagation` so global
  bindings (fullscreen exit) don't also fire.

The drift that motivates convergence:

- **ARIA**: `aria-modal` on two of six; `role="dialog"` placed on
  different elements (body vs. backdrop).
- **Focus**: trapping exists only in `BlfChannelMapModal`; initial
  focus is ad-hoc (`autoFocus` here, `confirmRef` there, nothing
  elsewhere).
- **Escape**: document-level listeners in some (which do *not* stop
  propagation to global keybindings) vs. element-level handlers in
  others (which do). Task 128 carries the related Escape-ordering item
  for portalled dropdowns; whatever it settles, modals should speak it
  once, not six times.

## Scope (to be groomed when scheduled)

- Extract a shared modal base — a shell component and/or dismissal
  hook — that owns backdrop rendering, Escape and backdrop-click
  dismissal, propagation to global bindings, ARIA roles, and initial
  focus + focus trapping. All six components render through it.
- Per-modal variation (width modifiers, button sets, the channel-map
  grid) stays with the modal; the base owns only the common chrome and
  behavior.
- No visual change is the goal; the test-side `modal(buttonLabel)`
  driver in `shotPrelude` already assumes the `.modal-buttons`
  structure and should keep working unmodified.

## Not immediate scope

Owner-placed alongside task 124 at the back of the current cluster;
nothing blocks on it.

## Exit criteria

Groomed when scheduled; at minimum: every modal renders through the
shared base, Escape/backdrop semantics and ARIA are uniform (one
answer to the global-keybinding propagation question), focus trapping
is the rule rather than the exception, and no modal's controls or
visual output change (pinned by the existing per-modal tests staying
green unmodified).
