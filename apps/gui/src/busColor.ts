// Shared bus-color logic. A bus carries a user-chosen `color`
// (set via the project panel) only once the user has picked one; until
// then — and for an old project that never had one — its color is
// derived from the bus's position in the list, over the active theme's
// bus wheel (`theme.ts`), so an uncustomized bus follows the theme with
// nothing stored.

import type { Bus } from "./types";
import { theme } from "./theme";

/// Palette color for the bus at list position `index`.
export function defaultBusColor(index: number): string {
  const wheel = theme().busWheel;
  return wheel[index % wheel.length];
}

/// The color to actually render a bus with: its explicit `color`
/// if set, else the palette color for its position in `buses`.
/// A neutral grey when the id isn't in the list.
export function effectiveBusColor(busId: string, buses: readonly Bus[]): string {
  const i = buses.findIndex((b) => b.id === busId);
  if (i < 0) return theme().busUnknown;
  return buses[i].color ?? defaultBusColor(i);
}
