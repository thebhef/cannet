# Task 53 — Theme Token Layer, then Light Theme

A user asked for a light theme (captured in
[task 52](0052-usage-feedback-round.md), item 3). The app is
dark-only by construction, and the prerequisite is structural:
introduce a theme token layer first, after which a `theme` setting is
one row. Doing it in the other order produces an app that is half
light. Promoted from the backlog's "Light mode, and UI density,
triaged separately" entry (2026-08-05); the UI-density half stays in
the backlog — it fails for unrelated reasons (px scroll geometry) and
is not part of this task.

## Why a token layer first

- `index.css` carries ~530 literal hex colors and **zero** CSS custom
  properties; `:root` declares `color-scheme: dark` and paints
  `#0e1116`.
- Color is also decided in JS, outside the stylesheet's reach:
  - `palette.ts` — the signal color wheel, WCAG-AA-tested against the
    one dark background (`palette.test.ts` requires ≥ 4.5:1).
  - `busColor.ts` — bus color assignment.
  - `PlotArea.tsx` — uPlot canvas styling (axes, grid, fonts) drawn
    outside CSS entirely.

## Shape of the work

1. **Harness screenshot step.** The ADR-0031 Chromium harness gains
   CDP `Page.captureScreenshot`; capture the dark baseline before
   any color moves.
2. **Token layer.** Replace literal colors in `index.css` with CSS
   custom properties on `:root`; group into a semantic set (surface,
   text, border, accent, state colors) rather than one variable per
   hex value. Screenshot diff against the baseline proves parity.
3. **JS color sources follow the theme.** `palette.ts`, `busColor.ts`,
   and the uPlot canvas styling read tokens (or select a per-theme
   variant); `onAddBus` stops seeding `color` (persist only on
   customize). The signal palette's AA guarantee is per-background:
   the light theme needs its own AA-validated wheel, not the dark
   wheel on a light background.
4. **`theme` setting.** One settings row (`dark` / `light`), persisted
   like other host settings; flips `data-theme` / `color-scheme`
   live with a full plot redraw. Brings the slot-matched light
   wheels + threshold tests and the "clear project colors" palette
   command.
5. **"Normal mode" (developer setting, default off).** When enabled,
   the `light` theme renders a candy-pink token set (think
   Hello-Kitty pastels: pale pink surfaces, deeper pink/red accents)
   with its own slot-matched pink-tinted wheels, in place of the
   intended light set. The intended light theme ships regardless and
   is what `light` means with the setting off. Same machinery (a
   third token set + wheel pair), same contrast tests against the
   pink background. User-facing docs and commit messages call it
   only "normal mode" / "normal mode enable" — the description is
   deliberately deadpan; this file is the one place the intent is
   spelled out.

## Decisions

- **Stored user colors render verbatim under any theme**
  (2026-08-05). Three color populations exist: theme-owned (CSS
  surfaces, plot axis chrome), derived-at-render
  (`stableSignalColor` hash wheel, legacy-bus palette fallback),
  and stored user data (bus `color` — seeded on add, so nearly all
  buses; `signal_colors` overrides; colormaps). Only the first two
  follow the theme. A theme change never mutates project data, and
  no render-time contrast clamp is applied — a stored color is the
  user's choice and may sit low-contrast on the other background.
- **Colors persist only when customized** (2026-08-05). `onAddBus`
  stops seeding `color`; an uncustomized bus derives its color from
  the active theme's bus wheel at render time, so defaults
  theme-follow with nothing stored. Only an explicit user pick
  writes to the project. Shared projects whose colors were
  customized under one theme are negotiated between their users,
  not by the app.
- **"Clear project colors" is a palette command, not a button**
  (2026-08-05), behind a confirm dialog (it discards deliberate
  per-signal choices with no partial undo). Scope: deletes bus
  `color` fields and `signal_colors` overrides — everything falls
  back to theme-derived defaults; colormap value→color rules
  untouched — semantic authored data, not cosmetic identity.
- **Uncustomized bus colors derive by list position** (2026-08-05),
  cycled over the themed bus wheel (today's `defaultBusColor`
  fallback, now the only path). Distinct up to 8 buses; a list
  edit may shift later buses' defaults — acceptable, most users
  won't customize. The signal wheel may grow beyond 16 slots while
  the light variant is built (more slots, fewer hash collisions).
- **Per-theme wheels are slot-matched** (2026-08-05). The light
  `SIGNAL_WHEEL` and `BUS_COLORS` variants keep the dark wheels'
  hues slot-for-slot, retuned in lightness/saturation until
  contrast holds on the light background — a signal or bus keeps
  its hue identity across themes, and a hash/index means the same
  thing in both wheels. Tests enforce contrast per slot against
  each theme's background.

- **Theme switch is live, no restart** (2026-08-05): the setting
  flips a `data-theme` attribute on `:root` (CSS tokens re-resolve
  instantly); JS color consumers re-read on the settings change
  event, and every uPlot instance is redrawn so the switch is
  seamless — no stale canvas chrome. Redraw-on-switch is part of
  the exit criteria, not best-effort.
- **Manual `dark | light` setting for v1** (2026-08-05); default
  `dark`. A `system` value (following `prefers-color-scheme`) is
  additive later — deferred to avoid per-OS WebView media-query
  quirks in a task whose risk is already the literal-color sweep.
- **Dark parity is screenshot-diffed** (2026-08-05): the ADR-0031
  Chromium harness gains a screenshot step (CDP
  `Page.captureScreenshot`); the token-layer phase proves zero
  visual change in dark by before/after pixel diff across the
  harness scenarios. The capability stays — it also carries the
  light-theme review and future visual checks.
- **Contrast thresholds match usage** (2026-08-05): signal wheels
  ≥ 4.5:1 per slot against each theme's background (signal colors
  render text — WCAG AA); bus wheels ≥ 3:1 (strokes/chips only —
  WCAG 1.4.11 non-text). Both enforced by test.

## Exit criteria

- `index.css` colors are tokens; zero visual change in dark, proven
  by the harness screenshot diff (the new capability lands with
  this task and stays).
- A `theme: light` setting renders every panel — including the uPlot
  canvas and signal/bus colors — from the light token set; no
  hard-coded dark remnants. Switching is live: tokens re-resolve
  and every plot redraws, no stale canvas chrome.
- Slot-matched per-theme wheels hold their thresholds by test:
  signal ≥ 4.5:1, bus ≥ 3:1, against each theme's background.
- `onAddBus` no longer seeds `color`; only customized colors
  persist; the "clear project colors" palette command ships behind
  a confirm dialog with the documented scope.
- "Normal mode" ships as a developer setting, default off; enabling
  it swaps the `light` token set and wheels for the pink set, live,
  under the same contrast tests. Docs/commits refer to it only as
  "normal mode".
