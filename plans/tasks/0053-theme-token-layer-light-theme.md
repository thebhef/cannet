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

- `index.css` carried ~590 literal color values (587 hex occurrences
  over 102 distinct hexes, plus 31 `rgb()`/`rgba()` layers) and one
  CSS custom property, a non-color one (`--trace-row-padding-x`);
  `:root` declares `color-scheme: dark` and paints `#0e1116`.
  Swept into 134 tokens in phase 53.A — see the status log.
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

## Status log

### 2026-08-06 — Phase 53.A, screenshot step (shape-of-the-work item 1)

**Method.** The ADR-0031 harness gains `screenshot` and
`screenshot-diff` (`crates/cannet-perf-measurement/src/screenshot.rs`).
`screenshot` launches the shipping GUI on a project, walks a fixed
9-step scenario driving the real chrome (toolbar buttons, dock tabs via
pointer events, the palette's real `Ctrl+Shift+P` chord), and writes one
PNG per step through CDP `Page.captureScreenshot`. `screenshot-diff`
compares two sets, printing differing pixels / percentage / max
per-channel delta per pair and writing a magenta-marked artifact.

The app is not modified: WebView2 opens its debugging port from the
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable the harness
sets on the child process.

**Determinism — how, and what it does not cover.** Four levers:
idle launch (`--project` only, so nothing connects and no frames
arrive); a viewport pinned by `Emulation.setDeviceMetricsOverride`
(1600×1000 @ dsf 1) so restored window geometry cannot move a pixel;
`Emulation.setEmulatedMedia` forcing `prefers-reduced-motion: reduce`;
and a harness-owned mask stylesheet over the regions that still move
while idle. The mask sets `visibility`, never a color, so it introduces
nothing into a color comparison — but the masked regions are
**outside the parity claim**: `.status` (the status bar's RAM/cache
readings), `.system-messages-count` and `.system-messages-badge` (the
health recorder logs a debug line every 20 s), `.system-messages-ts`
(wall-clock stamps), `.plot-perf` (the plot's decaying render badge). A
color change confined to those five selectors would pass unnoticed.

**Coverage.** All 14 dock components (`trace`, `plot`, `signals`,
`transmit`, `rbs`, `colormap`, `project`, `project-graph`,
`system-messages`, `dbc`, `settings`, `about`, `events`, `shortcuts`)
appear across the 9 captures, plus the always-on chrome (toolbar, dock
tab strip, status bar) and the command-palette modal. A unit test
asserts the scenario's coverage ledger against the component list, so
the claim is checked rather than asserted.

**Noise floor: 0 differing pixels across all 9 captures**, between two
independent app launches of the same build (`darkA` vs `darkB`,
1 600 000 px each). Two earlier launch pairs measured the same. So a
non-zero diff after the sweep is signal, not jitter.

**Dark baseline** — captured from the unchanged build at commit
`3e391e9` (`pnpm --dir apps/gui tauri build --no-bundle`, `ev-demo`
project), SHA-256:

| capture | sha256 |
| --- | --- |
| `01-saved-layout` | `d367684ceabfd2d1397f783c52502869abee1688156a0cb3f421d41dd698d005` |
| `02-dbc-system-messages` | `040f3602e3b0e2677425c5fa7a7987bc287637112a6f77694d2dd550ec26c27a` |
| `03-settings` | `a7f6a91e19e6bd71ffc023a899e88be8e679730715e56c77aafa89ac8c503c86` |
| `04-transmit` | `e6c78f5291650ea4045320e0d9ab69e4008cab5cfc0284c45f1798b27928fb4a` |
| `05-colormap` | `97b6d4b63273dfe958a82b20ed722281e62ba231ccf74ebeb033cd79ae180ef1` |
| `06-project-graph` | `e97873a8ff8423fe44f7f1aa35157211f2ee688b507e8858789bd1820bbdcb28` |
| `07-about` | `d52e483219d93d811ec1a8906abe13a931a55395f8bc66a5a9cd39981081f981` |
| `08-shortcuts` | `49fb73e4a8ea7eac4e73f1c6f13f5f42166a93ed32f813d4df497802663c615e` |
| `09-palette` | `78113bf3cdeb470a2461d7f99764b5347f42bd914d94532bf66439e908926047` |

**Blockers / side effects.**

- *The capture is Windows-only.* CDP needs a Chromium-backed webview;
  macOS (WKWebView) and Linux (WebKitGTK) have none. The parity check is
  therefore a developer/CI tool on Windows, not a per-platform gate —
  the same platform asymmetry ADR 0031 rejected `tauri-driver` over,
  but here it costs the coverage of a check rather than of the
  measurement the ADR is about.
- *Two silent-failure traps, both found by evidence and both now
  fatal.* (1) The debugging port answers before the page navigates, so
  an "is the splash gone" readiness test passed against the blank
  pre-navigation document and everything injected into it was wiped by
  the load; readiness now also requires the toolbar and
  `document.readyState === "complete"`. (2) Dockview switches tabs on
  `pointerdown`, not `click`, so three tab-activation steps did nothing
  and photographed the previous picture — visible only because captures
  01–03 hashed identically. The helper now dispatches pointer events and
  throws when a title isn't open, and the run additionally fails if any
  two captures are byte-identical.
- *A sub-visible fade.* Dockview's own tab-strip transition is not
  gated by `prefers-reduced-motion` (it isn't our stylesheet) and the
  shutter caught it mid-fade on the add-a-panel step — 1140 px at
  max Δchannel 3. Waited out with a longer pre-shutter settle rather
  than masked; the floor is 0 with it.
- *New dependencies:* `tungstenite`, `ureq`, `png`, `base64` in
  `cannet-perf-measurement` only, all TLS-free. Recorded in
  `plans/technology-inventory.md`.

### 2026-08-06 — Phase 53.A, token layer (shape-of-the-work item 2)

**Result: `index.css` holds no color literal outside the token block.**
618 literals replaced by 622 `var()` reads over **134 tokens** in six
groups:

| group | tokens | what it names |
| --- | ---: | --- |
| Surfaces | 31 | app / panel / row / control backgrounds, hovers, dividers |
| Text | 17 | the five-step ramp plus the semantic tints (log source, ECU, signal value, …) |
| Borders | 15 | four weights, row and list separators, the focus ring and field-focus border |
| State | 40 | danger / warning / ok, the developer and scope chips, the modified marker, plot cursors |
| Graph nodes | 15 | per-kind fill + outline for the project graph |
| Translucent | 17 | shadows, the modal backdrop, white washes, selection tints, the scrollbar thumb |

Names are roles, not shades. Six hexes carried two jobs and split into
two tokens each — `#1e293b` (raised surface / soft border), `#334155`
(control hover / strong border), `#2c3444` (divider / default border),
`#1f2630`, `#11161e`, `#475569` — and two more split by *selector*,
where the same hex is chrome in one place and a graph-node identity in
another (`#38bdf8` focus ring vs signals-node outline, `#475569` dim
border vs gateway-node outline). No two distinct values were merged.
The one exception is a notation merge: three shadow declarations spelled
the same color both as `rgba(0, 0, 0, 0.4)` and `rgb(0 0 0 / 0.4)` and
now share one token — same computed color, different spelling.

Landed as five green commits, one per token group (surfaces → text →
borders → state+nodes → translucent), each with
`pnpm --dir apps/gui test` (125 files, 1449 tests) and
`pnpm --dir apps/gui build` passing.

**Parity evidence — two independent proofs.**

1. *Static.* Expanding every `var()` in the swept file back to its token
   value reproduces the pre-sweep file byte for byte, except the three
   notation-merged shadow declarations above. So no resolved value
   changed.
2. *Pixel.* Release builds (`tauri build --no-bundle`) of the pre-sweep
   and post-sweep stylesheets, captured back to back on the same
   machine, `ev-demo`, 1600×1000:

   | capture | differing px / 1 600 000 | max Δchannel |
   | --- | ---: | ---: |
   | 01-saved-layout | 0 | 0 |
   | 02-dbc-system-messages | 0 | 0 |
   | 03-settings | 0 | 0 |
   | 04-transmit | 0 | 0 |
   | 05-colormap | 0 | 0 |
   | 06-project-graph | 0 | 0 |
   | 07-about | 0 | 0 |
   | 08-shortcuts | 0 | 0 |
   | 09-palette | 51 061 (3.19 %) | **1** |

   Eight of nine byte-identical. The ninth is the bistable palette
   artifact below — not a color change.

**Blockers / side effects.**

- *The palette capture is bistable at ±1/255.* Across twelve capture
  runs the `09-palette` image took one of exactly two forms, differing
  only in the bottom dock band (x 16–1599, y 763–999 — the row holding
  a plot canvas) and never by more than 1 per channel: alpha-compositing
  rounding where the modal backdrop blends over that band. All six
  pre-sweep runs produced form A; the post-sweep build produced form B
  in four runs and **form A — byte-identical to the pre-sweep capture —
  in two**. A token build that reproduces the pre-sweep bytes exactly is
  the evidence that the colors are equal and the difference is a raster
  path; the static expansion proof says the same thing independently.
  Recorded in the crate README so a future ≤ Δ1 palette diff is read as
  the artifact rather than a regression. A real color change reads far
  larger — the text differences found during this phase measured Δ 140–210.
- *Two more mask entries earned their place, both found by diffing.*
  The About panel's version readout is `git describe` output, so it
  differs between any two builds (Δ 142 over ~500 px). The system-log
  rows race: the sidecar's startup lines and the project-open line
  interleave differently run to run, so the message *and* source columns
  move (Δ 210 over ~1600 px). Both are masked now; the log rows, their
  level chips and the panel chrome stay in frame. The version string and
  the log text are outside the parity claim.
- *Task-doc correction.* This file said `index.css` had "zero CSS custom
  properties"; it had one non-color property (`--trace-row-padding-x`).
  Fixed above, with the measured literal counts.
