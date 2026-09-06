/// The x window a plot panel is currently showing, published for the
/// one thing outside the panel that needs it: the export dialog's "Plot
/// window" range preset.
///
/// A panel's x window is panel-level view state (ADR 0024) and stays
/// there — this is a *read* of it, not a second owner. It is a module
/// value rather than React state on purpose: the window moves on every
/// animation frame while a capture follows the live edge, and routing
/// that through a context would re-render every consumer of the context
/// at the panel's slide rate. Nothing subscribes; the dialog reads it
/// once, when a preset is picked.
///
/// The bounds are seconds on the shared timescale — elapsed from the
/// session origin — which is exactly what the plot's x scale already is,
/// and what an export range bound is. No conversion either side.

/// The window the most recently updated plot panel is showing, or `null`
/// when no plot has reported one (none open, or none with a window yet).
let current: { from: number; to: number } | null = null;

/// Publish a panel's x window. Called by the panel-level window setter,
/// so the value is always the last window any plot actually applied.
export function publishPlotWindow(from: number, to: number): void {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
  current = { from, to };
}

/// The last published plot window, or `null`.
export function plotWindow(): { from: number; to: number } | null {
  return current;
}

/// Forget the published window — a plot panel closing, a session reset,
/// and the tests, which share one module instance across a file.
export function clearPlotWindow(): void {
  current = null;
}
