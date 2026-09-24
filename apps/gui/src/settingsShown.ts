// How many times the settings view has been shown, published to what it
// renders.
//
// The settings view holds no data of its own — it is a view over the
// host's `settings.json`, the open project's overrides, and the project
// registry, every one of which can move while the user is looking at
// another panel. Nothing polls for that: a cache size comes from a
// directory walk, which is far too expensive to put on a timer
// (ADR 0002 DS-8). So the moment the view re-reads is the moment it
// comes back on screen, and this is how its descendants hear about it.
//
// It exists because the project caches list is reached only through the
// custom-setting renderer table, which passes a renderer nothing about
// the panel hosting it. A counter rather than a flag, so every return is
// a distinct value and a re-read cannot be swallowed as "no change".

import { createContext } from "react";

/// The count, starting at 1 for the view's first render.
export const SettingsShownContext = createContext(1);
