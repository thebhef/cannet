// @vitest-environment jsdom
//
// The theme setting reaches the document. Covers the half of the live
// switch that has no canvas in it: hydrating a stored theme before the
// first render, and following a later change of the setting — both by
// writing `data-theme` on the root element (which is what re-resolves
// every CSS token) and by notifying the JS color consumers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let stored: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_settings":
        return { ...stored };
      case "set_settings":
        stored = { ...(args?.settings as Record<string, unknown>) };
        return { ...stored };
      default:
        return null;
    }
  }),
}));

import { hydrateSettings, updateSettings } from "./hostSettings";
import { THEMES, activeTheme, setActiveTheme, subscribeTheme, theme } from "./theme";
import { startThemeSync } from "./themeSync";

let stop: (() => void) | null = null;

beforeEach(() => {
  stored = {};
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  stop?.();
  stop = null;
  setActiveTheme("dark");
});

describe("startThemeSync", () => {
  it("applies a stored theme at boot, before anything renders", async () => {
    stored = { theme: "light", normal_mode: true };
    await hydrateSettings();
    stop = startThemeSync();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(theme()).toBe(THEMES.light);
  });

  // Dark is what `:root` already declares, so leaving the attribute off
  // is the correct no-op — not a missed application.
  it("leaves the document alone when the stored theme is the default", async () => {
    await hydrateSettings();
    stop = startThemeSync();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(activeTheme()).toBe("dark");
  });

  it("follows a later change of the setting, both ways", async () => {
    stored = { normal_mode: true };
    await hydrateSettings();
    stop = startThemeSync();

    await updateSettings({ theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(theme()).toBe(THEMES.light);

    await updateSettings({ theme: "dark" });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(theme()).toBe(THEMES.dark);
  });

  // What the canvas consumers hang off: a plot that isn't receiving
  // samples redraws because it is told to, not because it re-rendered.
  it("notifies the JS color consumers on a change, once per change", async () => {
    await hydrateSettings();
    stop = startThemeSync();
    const notified = vi.fn();
    const unsubscribe = subscribeTheme(notified);
    try {
      await updateSettings({ theme: "light" });
      expect(notified).toHaveBeenCalledTimes(1);
      // Writing the same value again is not a change.
      await updateSettings({ theme: "light" });
      expect(notified).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("stops following once unsubscribed", async () => {
    await hydrateSettings();
    startThemeSync()();
    await updateSettings({ theme: "light" });
    expect(activeTheme()).toBe("dark");
  });
});

// The applied theme comes from the *pair*, so the flag is a live switch
// of its own — not something read once at boot.
describe("normal mode", () => {
  it("applies from the stored pair at boot", async () => {
    stored = { theme: "light", normal_mode: false };
    await hydrateSettings();
    stop = startThemeSync();
    expect(document.documentElement.dataset.theme).toBe("normal");
    expect(theme()).toBe(THEMES.normal);
  });

  it("swaps the light theme when it is flipped, and back", async () => {
    stored = { theme: "light" };
    await hydrateSettings();
    stop = startThemeSync();
    expect(activeTheme()).toBe("normal");

    const notified = vi.fn();
    const unsubscribe = subscribeTheme(notified);
    try {
      await updateSettings({ normal_mode: true });
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(theme()).toBe(THEMES.light);
      expect(notified).toHaveBeenCalledTimes(1);

      await updateSettings({ normal_mode: false });
      expect(document.documentElement.dataset.theme).toBe("normal");
      expect(theme()).toBe(THEMES.normal);
      expect(notified).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("leaves the dark theme alone", async () => {
    stored = { theme: "dark", normal_mode: true };
    await hydrateSettings();
    stop = startThemeSync();
    expect(activeTheme()).toBe("dark");

    await updateSettings({ theme: "light" });
    expect(activeTheme()).toBe("light");
    await updateSettings({ theme: "dark" });
    expect(activeTheme()).toBe("dark");
  });
});
