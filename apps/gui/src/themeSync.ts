// The one wire between the persisted `theme` setting and the frontend's
// theme state.
//
// `hostSettings` owns the value (it is a field of `settings.json` like
// any other); `theme.ts` owns what a theme *is* and how a switch
// propagates. Neither imports the other — this module joins them, so the
// color source stays testable without a host and the settings store
// stays ignorant of color.
//
// Started before first render so a user whose stored theme is `light`
// never sees a dark frame.

import type { Settings } from "./hostSettings";
import { hostSettings, subscribeSettings } from "./hostSettings";
import { setActiveTheme } from "./theme";

/// The theme a settings snapshot applies — `theme` verbatim.
function applied(s: Settings): void {
  setActiveTheme(s.theme);
}

/// Apply the currently-cached theme setting, then keep applying it on
/// every settings change. Returns the unsubscribe function.
export function startThemeSync(): () => void {
  applied(hostSettings());
  return subscribeSettings(applied);
}
