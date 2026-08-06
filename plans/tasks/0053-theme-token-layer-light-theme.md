# Task 53 — Theme Token Layer, then Light Theme

**Status: implementation complete, pending human review (2026-08-06).**
All four phases (53.A–53.D) are landed and every exit criterion is met;
the evidence for each is in the status log below.

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

  Gathered into one per-theme source (`theme.ts`) in phase 53.B — see
  the status log.

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
5. **"Normal mode" (developer setting, default off).** *Done
   2026-08-06 — `2754e69`, `be04272`, `481d50d`; inverted the same
   day — `710df3e`.* A third token set exists: a candy-pink one
   (think Hello-Kitty pastels: pale pink surfaces, deeper pink/red
   accents) with its own slot-matched pink-tinted wheels, built on
   the same machinery as the light set and held to the same contrast
   tests against the pink background. **The pairing is inverted: with
   the setting off — the default — `theme: light` renders the pink
   set, and enabling "Normal mode" is what gives you the intended
   light theme.** The intended light theme ships regardless; it is
   one checkbox away rather than the default reading of `light`.
   `dark` is unaffected by the setting either way, and the app
   default is still `theme: dark`, so nothing changes for anyone
   until they pick the light theme. User-facing docs and commit
   messages call it only "normal mode" / "normal mode enable" — the
   description is deliberately deadpan ("when enabled, the light
   theme renders normally"); this file is the one place the intent is
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
- ~~"Normal mode" ships as a developer setting, default off; the
  `light` setting renders the pink token set and wheels with it off
  and the light ones with it on, switched live, both under the same
  contrast tests. Docs/commits refer to it only as "normal mode".~~
  Done 2026-08-06 — `2754e69`, `be04272`, `481d50d`, inverted by
  `710df3e`; see phases 53.D and 53.E in the status log.

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

### 2026-08-06 — Phase 53.B, JS color sources (shape-of-the-work item 3)

**Mechanism: a TS mirror, guarded by a drift test — not
`getComputedStyle`.** Canvas code takes a resolved color string, so the
JS half of the app can't read a `var()`. The two candidates were reading
the resolved custom properties off `:root` at theme-change time and
caching them, or writing the values down in TS. Mirroring won on three
counts: reading from the DOM makes every color decision depend on a live
document and a loaded stylesheet (the wheels could then not be
contrast-tested in a plain unit test — and the AA guarantee is the point
of having them in one place), it returns whatever the cascade happens to
hold at call time rather than what the theme says, and it cannot carry
the wheels at all, which have no CSS presence. Its one cost is drift, and
`theme.test.ts` closes it: for every entry in `TOKEN_MIRROR` it parses
the `:root` token block out of `index.css` and asserts the two spell the
same value. Nine of the fifteen semantic colors are mirrored that way;
the other six (grid lines, tick marks, crosshair, canvas chip fill,
default lane fill, graph bus-node mix base) are canvas-only and have no
CSS counterpart to drift from.

`theme.ts` holds a `Theme` per name in `THEMES` — fifteen semantic colors
plus the two wheels — and `theme()` returns the active one. Consumers
call it at paint time, so a light theme is a `Theme` added to that record
and a change of what `theme()` returns; no consumer changes shape.

**Consumers migrated: 45 color literals across 7 modules.**

| module | literals | what they were |
| --- | ---: | --- |
| `PlotArea.tsx` | 14 | axis stroke / grid / ticks, cursors A+B, crosshair, event marker, three chip fills, two Δ-chip label colors, the default enum-lane fill, the bus-swatch grey |
| `palette.ts` | 16 | the signal wheel |
| `busColor.ts` | 9 | the bus wheel + the unknown-bus grey |
| `TraceView.tsx` | 2 | per-kind event colors (note, truncation) |
| `ProjectGraphPanel.tsx` | 2 | neutral wire, bus-node mix base |
| `PlotPanel.tsx` | 1 | the truncation marker's cursor color |
| `TransmitFrameRow.tsx` | 1 | the unbound-frame grey |

`plotPanelConfig.ts` changed without holding a literal: `TRACE_COLORS`
(an alias of the signal wheel, indexed by hand at three call sites) gave
way to `wheelColor`, which does the same wrap.

uPlot resolves an axis `stroke` / `grid.stroke` / `ticks.stroke` function
per draw (`fnOrSelf`) — the y-axis already relied on that for its
primary-signal tint — so the shared axis config takes functions and
follows a theme change on redraw rather than needing a rebuild.

**Deliberately not migrated: the colormap seeds.** `colorMap.ts`'s
`ENUM_PALETTE` (8) and `ColorMapPanel`'s `DEFAULT_RULE_COLOR` are the
values a *new colormap rule is created with* — they become project data
the moment they're used, and "clear project colors" explicitly leaves
colormap rules alone as authored data. Theming them would make a theme
change alter what future rules get written as. `SignalsPanel`'s
`"#ffffff"` is the `value` fallback of a hidden color input whose
`nameColor` is never null when the row exists — unreachable, and never
rendered as a color.

**`onAddBus` stops seeding.** A new bus now carries no `color` at all.
Every render path already derived one from the bus's list position when
the field was absent (`effectiveBusColor`, the project panel's swatch,
the plot panel's bus-color lookup) — that fallback is now the only path
for an uncustomized bus, so a default follows the theme with nothing
stored. Picking a color in the project panel still writes it, and a
stored color renders verbatim. The host is untouched: `Bus::color` was
already `Option<String>` with `skip_serializing_if`, so the saved project
simply has no `color` key for an uncustomized bus.

Tested at both levels: `App.busColor.dom.test.tsx` drives the real
toolbar — open the project panel, add a bus, read the swatch (it shows
the wheel entry for slot 0), save and inspect the project handed to the
host (no `color`), pick a color, save again (the color is there) — and it
failed on the old code exactly at the "no color" assertion. `busColor.ts`
had no unit tests at all; `busColor.test.ts` now covers derive-by-index,
stored-verbatim, and the unknown-id grey.

**Parity: zero visual change.** Release build
(`pnpm --dir apps/gui tauri build --no-bundle`), same scenario, same
machine, `ev-demo`, 1600×1000, diffed against 53.A's post-sweep captures:

| capture | differing px / 1 600 000 | max Δchannel |
| --- | ---: | ---: |
| 01-saved-layout … 08-shortcuts | 0 | 0 |
| 09-palette | 51 061 (3.19 %) | **1** |

The ninth is the bistable palette artifact 53.A documented, and this run
pins it down: the new build's `09-palette` is **byte-identical to the
*pre-sweep* capture** (form A), while the post-sweep set it was compared
against had come out form B. Diffing the two 53.A sets against each other
reproduces the same 51 061 px at Δ1. So every capture in this run matches
a 53.A capture byte for byte.

**Blockers / side effects.**

- *The screenshots don't exercise the seeding change.* `ev-demo`'s buses
  were saved with colors (they were seeded when the project was made), so
  they render verbatim and the pixels can't move. The equality that
  matters — derived color == the color seeding used to write for the same
  index — is the same `defaultBusColor(i)` call in both cases, and is
  covered by test rather than by pixels.
- *Bus wheel contrast is now enforced too.* The wheels moved into the
  theme, so the per-slot threshold tests moved with them and read against
  the theme's own background: signal ≥ 4.5:1 (unchanged), bus ≥ 3:1 (new
  — the dark bus wheel measures 6.8–11.3:1, so it passes with room). Both
  loop over `THEMES`, so a second theme is tested by existing.

### 2026-08-06 — Phase 53.C, the `theme` setting and the light theme (shape-of-the-work item 4)

**The setting is one row.** `theme` (`dark | light`, default `dark`) is a
user-scoped field validated against `settings::THEMES`, published by a
`Control::Enum` descriptor whose options are that same list, and rendered
by the settings view's existing generated control — no per-setting UI.
The host's anti-drift tests cover it by existing
(`every_published_option_set_is_the_one_validate_accepts` refuses
`not-an-option` and resolves it to the default). User scope, not
project-overridable: a project does not decide what its reader's screen
looks like.

**The light token set is a value exercise, as designed.** 53.A's sweep
left no color literal outside the `:root` block, so
`:root[data-theme="light"]` re-values all 134 roles and flips
`color-scheme`; the splash overlay, scrollbars and selection tints came
along for free because they were already tokens. Grep after the fact:
**zero hex / `rgb()` / named colors anywhere below the two token
blocks.**

Not an inversion pass — each group was re-derived from what the role
does:

| group | how light differs |
| --- | --- |
| Surfaces | the ramp turns over: `--surface-app` is `#f4f5f7` and a *raised* surface is white above it, where dark had grey above black |
| Text | the ramp turns over with it — the emphatic end is darkest (`--text-label #0f172a`), the de-emphasis end lightest (`--text-dim #98a3b3`, 2.34:1, matching dark's 2.56:1 weakness) |
| Borders | dark's borders are lighter than their surface, light's are darker; the eleven weights keep their order |
| State | deep tints under bright text become pale washes under dark text; `--danger-text-bright` is the *darkest* red, not the lightest |
| Graph nodes | pale per-kind fills, outlines deepened to read on them |
| Translucent | re-mixed, not reused: a white wash lightens a dark surface and does nothing to a light one, so `--wash-light` and both `--border-wash`es become dark washes |

Two drift guards in `theme.test.ts`, both of which caught something on
their first run. (1) *The blocks declare the same roles in the same
order* — an omitted token silently inherits the dark value, which no
grep would show. (2) *Every role is re-valued unless it is on an
explicit theme-independent list* (five roles: text on a solid accent,
the accent fill itself, the danger badge, the search-focus ring — all
sit on a solid of their own, so the surface under them does not change).
That second test found three graph-node colors carried over unchanged
(`--node-transmit-border`, `--node-bus-bar`, `--node-bus-border`).

**Wheels: same hues, retuned.** Each light slot keeps its dark slot's
hue and drops lightness (at ~0.9x the original saturation) until it
clears its threshold against the light background, maximising lightness
subject to that. Worst slot per wheel per theme, against that theme's
own `--surface-app`:

| wheel | threshold | dark worst | light worst |
| --- | --- | --- | --- |
| signal (16) | 4.5:1 | **6.01** (slot 7 `#e15dcf`) | **4.77** (slot 12 `#da0b0b`) |
| bus (8) | 3:1 | **6.84** (slot 3 `#f87171`) | **3.26** (slot 0 `#3588ee`) |

Light signal slots span 4.77–4.88, bus slots 3.26–3.33 — tight, because
the tuner takes the lightest passing color. Worst per-slot hue drift
**0.35°** (signal) and **0.14°** (bus); `palette.test.ts` bounds it at
8°. That check is not decoration: both wheels could pass their contrast
tests while being unrelated palettes, and then a signal's hash would
mean a different hue in each theme. AA on a light background does cost
hue *separation* at the warm end — slots 2, 5 and 14 (orange, gold,
peach) all land in the browns, which is inherent to 4.5:1 rather than a
tuning choice.

Testing the wheels against `--surface-app` is the conservative reading:
`--surface-canvas` is `#ffffff` in light, and a higher-luminance
background gives *more* contrast, so a slot that passes on the app
surface passes on the canvas.

**Live switching, and the one thing the token layer could not reach.**
`themeSync.ts` is the single wire from the persisted setting to
`theme.ts`, started before first render (so a stored `light` never shows
a dark frame) and following every later change. CSS needs nothing but
the `data-theme` flip. Three things do:

- *uPlot.* Its axis strokes were already per-draw functions (53.B), so
  one forced redraw per instance suffices — but a plot receiving no
  samples keeps its last chrome, which is exactly the stale canvas the
  exit criteria forbid. A `useThemeName()` + redraw effect in `PlotArea`.
- *Components that resolve a color while rendering.* `useThemeName`
  (a `useSyncExternalStore` over the theme) in the plot area and its
  swatches, the graph's wires and bus nodes, the project panel's bus
  swatches, the signal panel's hashed name colors, transmit rows, event
  rows. React cannot know a plain function call's answer moved, and four
  of these sit behind a `memo` a parent re-render would not cross.
- *Dockview.* It paints its tab strip and group borders from its own
  theme object, outside our token layer entirely — the one piece of
  chrome a `data-theme` flip cannot reach. `themeAbyss` swaps to
  `themeLight`.

Verified at both ends. `themeSync.dom.test.ts` covers the setting path
(boot application, both switch directions, the dark default correctly
leaving the attribute off, one notification per change, unsubscribe).
`PlotPanel.dom.test.tsx` covers the canvas path on a live panel: flip
the setting, and the `data-theme` attribute, the redraw count and the
axis stroke's resolved color all have to move. That test fails on the
code with the redraw effect removed (`expected 4 to be greater than 4`),
which is the falsification that makes it worth having.

**"Clear project colors."** Palette command, confirm dialog first (same
shape and escape routes as the unsaved-changes prompt), then: delete
every bus's `color` key and empty `signal_colors`. The keys are
*deleted*, not rewritten with a derived value — storing what the theme
already derives is how the colors stopped following the theme in the
first place. Color-map rules are untouched: a rule says what a *value*
means, which is authored data. `App.clearColors.dom.test.tsx` drives the
real palette chord against a real opened project and checks all three
(cleared, spared, and neither Cancel nor Escape doing anything).

**Dark parity: the two captures that moved are the two features, and
nothing else.** Release build, same scenario, same machine, `ev-demo`,
1600x1000, diffed against a 53.B (`5734a08`) reference binary built and
captured in the same session:

| capture | differing px / 1 600 000 | max Δchannel |
| --- | ---: | ---: |
| 01, 02, 04, 05, 06, 07, 08 | **0** | 0 |
| 03-settings | 1 237 (0.077 %) | 215 |
| 09-palette | 51 098 (3.19 %) | 115 |

Both are accounted for by region:

- *03-settings* — every differing pixel is inside `x 18–359, y 797–991`,
  the settings tree's own column, where the new **Theme** row renders.
- *09-palette* — split in two. Rows 763–999 hold **51 061 px at max
  Δ1**: the bistable compositing artifact 53.A documented, to the pixel
  (53.A measured 51 061 as well). Everything above it is **37 px in a
  9x7 box at `x 1051–1059, y 287–293`** — the palette list's scrollbar
  thumb, one row shorter because the command registry gained an entry.
  The palette's visible rows are unchanged (the new command sits below
  the fold), and `08-shortcuts`, which lists every command, is
  byte-identical.

So the theme setting's *default* moves no pixel; what moved is the row
and the command this phase adds.

**Light captures** are committed for review at
[`docs/review/0053-light-theme/`](../../../docs/review/0053-light-theme/)
(nine PNGs plus a README saying what to look at in each). They also
stand as evidence for the boot path: they were produced by writing
`"theme": "light"` into the user `settings.json` and launching, so
`startThemeSync` applying a stored theme before first render is what
made them light.

**Blockers / side effects.**

- *The harness cannot drive a settings change, so the live flip is not
  in the pixel evidence.* Its scenario is a fixed list of steps compiled
  into the crate, with no step that edits `settings.json` or reaches the
  settings control; adding one is a change to the harness, not to this
  task. The two capture runs prove the boot path (dark by default, light
  from the stored value) and the DOM tests prove the flip; what nothing
  photographs is the transition itself.
- *Cross-session capture drift is real; within-session determinism is
  what the check rests on.* Four of the nine dark captures hashed
  differently from 53.A's recorded SHA-256 table, but two of those four
  (`02`, `07`) diff to **0 pixels** against a 53.B binary captured
  today — so those hashes moved with the environment (this machine's
  `projects.json` and system-log ordering have changed since 53.A), not
  with the build. The lesson for the next phase: **diff against a
  reference build captured in the same session**, and treat the recorded
  hashes as a within-session identity check only. Two back-to-back dark
  runs of this build were byte-identical on all nine.
- *The splash logo is outside the token layer.* `assets/logo.svg` is an
  `<img>` with baked fills, and CSS cannot reach into it. Its letters are
  already a dark slate blue (the file's own comment calls them the
  light-theme defaults), so it reads better on the light background than
  on the dark one — no action needed, but it is not theme-derived.
- *A pre-existing flaky test.* `PlotPanel.dom.test.tsx`'s
  "re-renders no plot area when only panel-local state changes" asserts a
  render counter and fails intermittently under full-suite parallel load
  (seen twice, once on a commit that touched only `settings.rs`); it
  passes on every isolated run and on a re-run of the full suite. Not
  caused by this phase and not touched by it.

### 2026-08-06 — Phase 53.D, normal mode (shape-of-the-work item 5)

**Resolution: a pair, not a third value of one setting.** `normal_mode`
is a user-scoped boolean (default `false`, developer-tagged so the
settings view hides it until `show_developer_settings` is on); `theme`
still stores exactly `dark | light`. The applied theme comes from both:
`resolveTheme(setting, normalMode)` returns `normal` for `light` + on
and the setting itself otherwise, and `themeSync` — which used to pass
`s.theme` straight to `setActiveTheme` — now passes the resolved value.
So `normal` is a `ThemeName` (a `data-theme` value, a key of `THEMES`)
but not a `ThemeSetting`, and the two types are now distinct in
`hostSettings.ts`. Everything downstream is unchanged: the attribute
flip, the `subscribeTheme` notification, the plot redraw and the
dockview object swap all key off the applied name, and the swap now
reads "dark takes the abyss object, every light-background theme takes
the light one" rather than naming `light`.

Three commits: the setting (`2754e69`), the values (`be04272`), the
wiring (`481d50d`).

**The token set is the light set re-hued at constant luminance.** All
134 roles again, in the same order (the drift guards now run over every
block that overrides `:root`, not over light alone). Each neutral role —
surface ramp, text ramp, borders, washes — rotates onto one axis and
each accent (the blue/indigo family that means marked / focused /
selected / active) onto a deeper second one, and the lightness is
re-solved so the token keeps its light counterpart's WCAG relative
luminance. Every contrast relationship the light set was tuned for
therefore carries over by construction rather than by re-checking 134
values. Two deliberate exceptions:

- *The pale end gives up 14 %.* A `#ffffff` surface cannot take a tint
  at constant luminance — in HSL, luminance 1.0 is white at every
  saturation — so anything above 0.62 luminance is solved for 0.86 of
  it. That costs contrast on the surfaces: against `--surface-app`,
  `--text-dim` (the de-emphasis end, the weakest pair in every theme)
  reads **2.03:1** here against light's 2.34:1 and dark's 2.50:1. The
  emphatic end is unaffected in practice — `--text-body` is **11.68:1**,
  light's 13.46:1, dark's 14.00:1.
- *Semantic hues stay put.* Danger, warning, ok, the developer and
  scope chips, `--cursor-gold`, `--text-ecu`, `--text-signal-value`,
  and the graph's fifteen per-kind node identities keep their own hue
  at their own luminance. A status dot that isn't green, or a warning
  wash whose text contrast moved, is a role failure — the point of the
  set is that it is a usable theme.

**Wheels, and a wider hue bound.** Same tuner as light's: take dark's
slot, keep 0.9 of its saturation, take the lightest color that still
clears the threshold against *this* theme's `--surface-app` (`#fddde7`).
The one addition is a rotation — each slot moves a fifth of the way onto
the theme's axis before tuning — because otherwise the wheels would be
the light wheels on a different background rather than part of this
theme.

| wheel | threshold | worst slot | span | worst hue drift |
| --- | --- | --- | --- | ---: |
| signal (16) | 4.5:1 | **4.50** (slot 0 `#6f690e`) | 4.50–4.54 | **32.7°** (slot 8) |
| bus (8) | 3:1 | **3.00** (slot 2 `#2d8ea9`) | 3.00–3.02 | **35.0°** (slot 2) |

`palette.test.ts`'s slot-matching bound is therefore **per theme**:
light keeps 8°, normal takes **36°**. The check still earns its place —
36° is a rotation, 180° is an unrelated palette, and the whole point of
slot-matching is that a hash means the same identity in every theme.
Testing against `--surface-app` stays the conservative reading, as in
53.C: `--surface-canvas` is lighter (`#feeaf0`), so a slot that passes
on the app surface passes on the canvas.

**Parity: zero differing pixels, in dark *and* in plain light.** Two
release builds made and captured in the same session, as 53.C's lesson
says to — a reference at 53.C's tip (`810a134`) and this branch's tip —
against `ev-demo`, 1600×1000:

| run | differing px / 1 600 000 | max Δchannel |
| --- | ---: | ---: |
| dark, all nine captures | **0** | 0 |
| `theme: light`, all nine captures | **0** | 0 |

Including `09-palette`, which came out the same bistable form in both
runs, and `03-settings`: the new row is developer-tagged, so it is not
rendered at the default `show_developer_settings: false` and the
settings tree is byte-identical. Nothing this phase adds is visible
until it is switched on.

**Normal-mode captures** are committed for review at
[`docs/review/0053-normal-mode/`](../../../docs/review/0053-normal-mode/)
(nine PNGs plus a README saying what to look at). They were produced by
writing `"theme": "light", "normal_mode": true` into the user
`settings.json` and launching, so they are also the boot-path evidence
for the resolved pair — the same thing 53.C's light captures did for the
theme alone.

**Tests.** Host 482 passing (the descriptor row's kind, control, label
and default are asserted; the pre-existing anti-drift tests cover the
key, the scope and the default by existing). Frontend 1484 over 130
files, up 11 on 53.C: the stylesheet drift guards and the wheel checks
now iterate a third theme, plus `resolveTheme`'s truth table, three
`themeSync.dom.test.ts` cases (boot from the stored pair, the flag
flipped both ways with one notification each, `dark` unmoved by the
flag), and a `PlotPanel.dom.test.tsx` case that flips the flag on a live
panel and requires the attribute, the redraw count and the axis stroke's
resolved color all to move — the same falsifiable shape as 53.C's theme
test.

**Blockers / side effects.**

- *No new hue-distinctness problem, but the inherited one is visible.*
  Maximising lightness subject to a threshold packs every slot against
  the limit (4.50–4.54 for signal), so slots that were already close in
  dark — 0/11 (yellow-greens), 1/13 (cyans), 2/14 (oranges) — land
  closer still. Light has the same property (4.77–4.88, warm end in the
  browns); it is a consequence of AA on a light background, not of the
  rotation.
- *`--accent-selected-bg` and the other four theme-independent roles
  stay as dark declares them.* They sit on a solid of their own, which
  is why the drift test pins them — but it does mean a solid blue
  selection fill on a pink surface. Changing that is a change to the
  theme-independent list and to light as well, so it is not this
  phase's to make.
- *The 53.C flaky test flaked once more.* `PlotPanel.dom.test.tsx`'s
  "re-renders no plot area when only panel-local state changes" failed
  one full-suite run in this phase and passed the three either side of
  it, including the pre-commit hook's. Same test, same intermittency,
  still not touched.
