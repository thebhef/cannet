/// The one place JS decides a color.
///
/// Stylesheet colors come from the token block at the top of
/// `index.css`. Canvas code cannot: a 2d context takes a resolved color
/// string, not a `var()`, and neither do the inline styles that carry a
/// per-bus identity. This module is that resolved source — one theme
/// object per theme name, holding the semantic colors JS draws with plus
/// the two color wheels (signal, bus).
///
/// **Mirrored, not read back from the DOM.** The alternative — resolving
/// each token with `getComputedStyle(document.documentElement)` and
/// caching it — was rejected: it makes every color decision depend on a
/// loaded stylesheet and a live document (so the wheels could not be
/// contrast-tested in a plain unit test), it yields whatever the cascade
/// happens to hold at call time, and it cannot carry the wheels at all,
/// which have no CSS presence. The price of mirroring is drift, and
/// `theme.test.ts` closes it: for every entry in {@link TOKEN_MIRROR} it
/// parses the `:root` block of `index.css` and asserts the two spell the
/// same value.
///
/// Adding a theme is adding a {@link Theme} to {@link THEMES}, not a
/// change of shape here or at any consumer.

import { useSyncExternalStore } from "react";

/// Theme identities. Also the value of the host's `theme` setting and of
/// the `data-theme` attribute the stylesheet's token blocks key off — the
/// setting *is* the theme name, verbatim.
export type ThemeName = "dark" | "light" | "lighthk";

/// The semantic colors JS paints with. Names are roles, not shades —
/// two entries that share a value today but mean different things stay
/// separate, same rule as the CSS token block.
export interface ThemeColors {
  /// The app background. CSS owns the surface itself, and this is the
  /// color the wheels are contrast-tested against — but it *is* painted
  /// from here in one place: the diagonal hatching an extrapolated lane
  /// tile carries (ADR 0026) is drawn in it, so a striped tile reads as
  /// the app showing through the tile rather than as a second fill.
  background: string;
  /// Plot axis labels and tick text.
  axisText: string;
  /// Plot grid lines.
  axisGrid: string;
  /// Plot axis tick marks.
  axisTicks: string;
  /// Measurement cursor A (X and H).
  cursorA: string;
  /// Measurement cursor B (X and H).
  cursorB: string;
  /// The shared mouse crosshair drawn across every stacked plot area.
  crosshair: string;
  /// A timeline event with no color of its own (ADR 0035) — the plot's
  /// event line and the trace's note row.
  eventMarker: string;
  /// The derived truncation marker (ADR 0035), a muted amber.
  eventTruncation: string;
  /// Fill behind a canvas label chip (cursor labels, event labels, the
  /// Δ readouts) so the text reads over the series underneath.
  canvasChipFill: string;
  /// Enum-lane tile fill when no colormap claims the value — dark enough
  /// to let the stepped line show through.
  laneFillDefault: string;
  /// A bus id that isn't in the project's bus list.
  busUnknown: string;
  /// A transmit frame bound to no bus at all.
  busUnset: string;
  /// A project-graph wire that carries no single identifiable bus.
  graphNeutralEdge: string;
  /// Base the project graph's bus-node fill is mixed into, so the node
  /// reads as a dim wash of its bus color rather than the bus color.
  graphBusNodeBase: string;
}

/// A theme: its colors, plus the wheels that derive a color from an
/// index or a hash. Per-theme wheels are slot-matched — slot `n` is the
/// same hue identity in every theme — so a stored hash or list position
/// means the same thing whichever theme is active.
export interface Theme extends ThemeColors {
  name: ThemeName;
  /// The 16-color signal wheel (ADR 0026): every surface that colors a
  /// signal draws from it, so the palettes can't drift apart. Each entry
  /// holds WCAG-AA contrast (≥ 4.5:1) against this theme's background —
  /// signal colors render text. `palette.test.ts` enforces it.
  signalWheel: readonly string[];
  /// The bus wheel, cycled by a bus's position in the project bus list.
  /// Strokes and chips only, so the threshold is WCAG 1.4.11 non-text
  /// (≥ 3:1) against this theme's background.
  busWheel: readonly string[];
  /// How many stacked shadow passes a lane label gets where it overlaps
  /// an extrapolation-striped stretch (ADR 0026).
  ///
  /// The stripes are drawn in `background` and cut straight through the
  /// glyphs, so a label needs a halo to stay readable. *Which* color
  /// that halo is is measured per tile against the ink the label ended
  /// up in (`laneLabelInk`) — normally `background`, the striping color
  /// itself; this is only how hard it is laid down. Canvas shadow alpha
  /// does not go past what one pass paints, so strength is bought by
  /// repeating the pass rather than by a number.
  ///
  /// **0 wherever {@link laneLabelBoxOpacity} is 1**, which is what both
  /// shipping light themes carry. The box is already an opaque plate
  /// between the glyphs and the stripes, so no halo is spent over one:
  /// the passes would paint background over background and their blur
  /// would fringe past the box's edge. The two tokens are chosen
  /// together — a boxed theme asking for passes would be stating a
  /// number nothing can reach.
  ///
  /// A per-theme number rather than a branch on `name`, so adding a
  /// theme stays "add a `Theme` to `THEMES`" and no consumer grows a
  /// list of which themes count as light. A theme that does want the
  /// halo says how hard: dark takes 2, and a light theme drawn without a
  /// box would want about double — its stripes carry far more contrast
  /// against the tile fill, so a single pass is lost under them.
  laneLabelShadowPasses: number;
  /// How opaque the box behind a lane label is (ADR 0026), filled in
  /// {@link ThemeColors.canvasChipFill} — 0 for no box at all, 1 for a
  /// solid plate.
  ///
  /// A light theme's tinted tiles collapse into their own accent, so its
  /// labels are read off a plate instead of off the tile; a dark theme's
  /// don't, and it takes **0**, which paints nothing — a source-over
  /// composite at alpha 0 leaves the canvas exactly as it was, so the
  /// draw path is the same on every theme without a branch, and so is
  /// the ground `laneLabelInk` measures against.
  ///
  /// Same idiom as {@link laneLabelShadowPasses}: a number a theme
  /// carries, not a list of which themes count as light.
  laneLabelBoxOpacity: number;
}

const DARK: Theme = {
  name: "dark",
  background: "#0e1116",
  axisText: "#cbd5e1",
  axisGrid: "#222b35",
  axisTicks: "#3a4654",
  cursorA: "#ffd93d",
  cursorB: "#ff5577",
  // uPlot's default cursor grey, kept now that the line is drawn by the
  // panel's own overlay instead of uPlot's per-instance native cursor.
  crosshair: "#607d8b",
  eventMarker: "#4ecbff",
  eventTruncation: "#e0a030",
  canvasChipFill: "#0a0d0f",
  laneFillDefault: "rgba(10, 13, 15, 0.65)",
  busUnknown: "#94a3b8",
  busUnset: "#475569",
  graphNeutralEdge: "#94a3b8",
  graphBusNodeBase: "#11161f",
  laneLabelShadowPasses: 2,
  laneLabelBoxOpacity: 0,
  signalWheel: [
    "#c6f24e",
    "#4ecbff",
    "#ffaa3d",
    "#b48cff",
    "#ff7e5a",
    "#ffd93d",
    "#5ddb7c",
    "#e15dcf",
    "#8ce0d4",
    "#ff9bd2",
    "#a0bfff",
    "#d0ff7a",
    "#ff6b6b",
    "#7be3ff",
    "#ffcf85",
    "#c39bff",
  ],
  busWheel: [
    "#60a5fa", // blue
    "#fbbf24", // amber
    "#34d399", // teal
    "#f87171", // red
    "#a78bfa", // violet
    "#f472b6", // pink
    "#fb923c", // orange
    "#22d3ee", // cyan
  ],
};

/// The light theme. Slot-matched to {@link DARK}: each wheel entry keeps
/// its slot's hue (measurably — `palette.test.ts` bounds the per-slot
/// hue distance) and is retuned in saturation and lightness until it
/// clears its threshold against *this* theme's background. A signal or a
/// bus therefore keeps its hue identity across a theme change, and a
/// hash or a list position means the same thing in both wheels.
const LIGHT: Theme = {
  name: "light",
  background: "#f4f5f7",
  axisText: "#334155",
  axisGrid: "#e2e6ec",
  axisTicks: "#9aa5b4",
  cursorA: "#b45309",
  cursorB: "#be123c",
  // The neutral grey the crosshair reads as over any series, light
  // enough not to compete with the traces it crosses.
  crosshair: "#78909c",
  eventMarker: "#0369a1",
  eventTruncation: "#9a6410",
  // Effectively the canvas color, same as dark's: a chip is a backing
  // that hides the series behind the label, not a visible plate.
  canvasChipFill: "#ffffff",
  laneFillDefault: "rgba(226, 232, 240, 0.75)",
  busUnknown: "#5b6879",
  busUnset: "#98a3b3",
  graphNeutralEdge: "#5b6879",
  graphBusNodeBase: "#eef1f6",
  laneLabelShadowPasses: 0,
  laneLabelBoxOpacity: 1,
  signalWheel: [
    "#5a760f",
    "#0873a0",
    "#9d5c08",
    "#8042f5",
    "#c9340b",
    "#806907",
    "#227c38",
    "#ba2ca6",
    "#26786c",
    "#d00b78",
    "#1960f3",
    "#4f7706",
    "#da0b0b",
    "#087694",
    "#996008",
    "#873df5",
  ],
  busWheel: [
    "#3588ee", // blue
    "#ab7f0c", // amber
    "#299970", // teal
    "#ed5151", // red
    "#9171f1", // violet
    "#e84a9d", // pink
    "#d66910", // orange
    "#1694a7", // cyan
  ],
};

/// The pink theme (`lighthk`). Same construction as the stylesheet block
/// it goes with (see `index.css`): the light values re-hued onto the
/// theme's own axis, keeping their luminance. The wheels are slot-matched
/// like every other variant, but rotate a fifth of the way onto that axis
/// as well, so `palette.test.ts` reads them against a wider hue bound
/// than light's.
const LIGHTHK: Theme = {
  name: "lighthk",
  background: "#fddde7",
  axisText: "#781c38",
  axisGrid: "#fccad9",
  axisTicks: "#da8fa5",
  cursorA: "#b85000",
  cursorB: "#b22a53",
  crosshair: "#cf6e8b",
  eventMarker: "#bd0f7d",
  eventTruncation: "#9e6205",
  canvasChipFill: "#feeaf0",
  laneFillDefault: "rgba(252, 204, 218, 0.75)",
  busUnknown: "#be2d58",
  busUnset: "#d98ca3",
  graphNeutralEdge: "#be2d58",
  graphBusNodeBase: "#fdd8e3",
  laneLabelShadowPasses: 0,
  laneLabelBoxOpacity: 1,
  signalWheel: [
    "#6f690e",
    "#2356f3",
    "#af4609",
    "#9712f3",
    "#ca1c0b",
    "#965808",
    "#387420",
    "#b32a95",
    "#2f6c95",
    "#c70a6d",
    "#544af5",
    "#6b6a06",
    "#ce0b1b",
    "#1158f2",
    "#aa4a09",
    "#9c0ced",
  ],
  busWheel: [
    "#7075f3", // blue
    "#c96a0e", // amber
    "#2d8ea9", // teal
    "#ec4553", // red
    "#a95ef0", // violet
    "#e64194", // pink
    "#e94d11", // orange
    "#4481e7", // cyan
  ],
};

export const THEMES: Readonly<Record<ThemeName, Theme>> = {
  dark: DARK,
  light: LIGHT,
  lighthk: LIGHTHK,
};

/// The theme name every color decision resolves through. Module state
/// rather than React state: the canvas draws outside React, and a
/// stylesheet token is resolved by the cascade, so neither could read a
/// hook. {@link setActiveTheme} is the one writer.
let active: ThemeName = "dark";

/// The theme every JS color decision reads. Call it at paint time, not
/// at module scope: the theme setting flips what it returns.
export function theme(): Theme {
  return THEMES[active];
}

/// Which theme is active. For consumers that need the *name* — the
/// dockview theme object, a test — rather than a color.
export function activeTheme(): ThemeName {
  return active;
}

const listeners = new Set<() => void>();

/// Switch themes, live. Writes `data-theme` on the root element (which
/// is what re-resolves every CSS token — instant, no re-render), then
/// notifies the JS consumers, which is what makes the canvas follow:
/// uPlot draws imperatively, so a plot that isn't receiving samples
/// would otherwise keep the old chrome until something else nudged it.
export function setActiveTheme(name: ThemeName): void {
  if (name === active) return;
  active = name;
  // Guarded because the wheels and their contrast tests are meant to be
  // exercisable without a document (`palette.test.ts` runs in node).
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = name;
  }
  for (const fn of [...listeners]) fn();
}

/// Subscribe to theme changes; returns the unsubscribe function. Shaped
/// for `useSyncExternalStore` alongside {@link activeTheme}, which is
/// how a component that resolves a color while rendering re-renders on
/// a switch.
export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/// The active theme name, re-rendering the caller when it changes.
///
/// Every component that resolves a color *while rendering* — an inline
/// swatch, a per-bus tint, a canvas draw — needs this, because
/// {@link theme} is a plain function call and React has no way to know
/// its answer moved. Components behind a `memo` boundary need it
/// especially: their parent re-rendering doesn't reach them.
export function useThemeName(): ThemeName {
  return useSyncExternalStore(subscribeTheme, activeTheme, activeTheme);
}

/// Theme colors that are also written down as a CSS token, by token
/// name. `theme.test.ts` fails if a pair drifts apart.
export const TOKEN_MIRROR: Partial<Record<keyof ThemeColors, string>> = {
  background: "--surface-app",
  axisText: "--text-secondary",
  cursorA: "--cursor-gold",
  cursorB: "--cursor-pink",
  eventMarker: "--accent-marker",
  eventTruncation: "--warn-text-truncation",
  busUnknown: "--text-muted",
  busUnset: "--text-dim",
  graphNeutralEdge: "--text-muted",
};
