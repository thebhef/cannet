// Shared bus-colour logic. A bus carries a user-chosen `color`
// (set via the project panel); when it's absent — an old project,
// or a bus the user never recoloured — the graph falls back to a
// palette colour derived from the bus's position in the list.

import type { Bus } from "./types";

/// Default palette, cycled by a bus's index in the project bus list.
/// `onAddBus` seeds a new bus's `color` from this; the graph uses it
/// as the fallback for any bus still missing an explicit colour.
export const BUS_COLORS: readonly string[] = [
  "#60a5fa", // blue
  "#fbbf24", // amber
  "#34d399", // teal
  "#f87171", // red
  "#a78bfa", // violet
  "#f472b6", // pink
  "#fb923c", // orange
  "#22d3ee", // cyan
];

/// Palette colour for the bus at list position `index`.
export function defaultBusColor(index: number): string {
  return BUS_COLORS[index % BUS_COLORS.length];
}

/// The colour to actually render a bus with: its explicit `color`
/// if set, else the palette colour for its position in `buses`.
/// `#94a3b8` (neutral grey) when the id isn't in the list.
export function effectiveBusColor(busId: string, buses: readonly Bus[]): string {
  const i = buses.findIndex((b) => b.id === busId);
  if (i < 0) return "#94a3b8";
  return buses[i].color ?? defaultBusColor(i);
}
