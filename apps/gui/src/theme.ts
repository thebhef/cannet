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

/// Theme identities. One today.
export type ThemeName = "dark";

/// The semantic colors JS paints with. Names are roles, not shades —
/// two entries that share a value today but mean different things stay
/// separate, same rule as the CSS token block.
export interface ThemeColors {
  /// The app background. Not painted from here (CSS owns the surface);
  /// it is the surface the wheels are contrast-tested against.
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

export const THEMES: Readonly<Record<ThemeName, Theme>> = { dark: DARK };

/// The theme every JS color decision reads. Call it at paint time, not
/// at module scope: a theme setting flips what it returns.
export function theme(): Theme {
  return THEMES.dark;
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
