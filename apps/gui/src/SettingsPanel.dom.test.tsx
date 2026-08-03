// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// A stand-in for `settings.json`: `get_settings` reads it, `set_settings`
// replaces it, so a test can mutate it mid-flight the way a second writer
// (the shortcuts panel's keybinding editor) would.
let stored: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_settings":
        return { ...stored };
      case "set_settings":
        stored = { ...(args?.settings as Record<string, unknown>) };
        return null;
      default:
        return null;
    }
  }),
}));

import type { IDockviewPanelProps } from "dockview";

import { SettingsPanel } from "./SettingsPanel";

beforeEach(() => {
  stored = { scratch_cap_bytes: null, clear_scratch_on_exit: false, keybindings: null };
});
afterEach(cleanup);

/// Render the panel and wait for it to finish loading (the fieldset is
/// disabled until then, so nothing is clickable before).
async function renderLoaded() {
  render(<SettingsPanel {...({} as IDockviewPanelProps)} />);
  await waitFor(() => expect(screen.getByRole("checkbox")).toBeEnabled());
}

describe("SettingsPanel", () => {
  it("renders the disk-spill cache group and no About section", async () => {
    render(<SettingsPanel {...({} as IDockviewPanelProps)} />);
    expect(await screen.findByText("Disk-spill Cache")).toBeInTheDocument();
    expect(screen.queryByText("About")).not.toBeInTheDocument();
  });

  // Regression: the panel used to write the whole struct from its
  // mount-time snapshot, so a keybinding persisted while it was open was
  // silently reverted by the next checkbox tick. It must re-read and merge,
  // as `useCommands`' `persistUserBindings` does.
  it("keeps a keybinding written by another panel while it was open", async () => {
    await renderLoaded();

    const rebound = [{ chord: "Mod+k", commandId: "palette.show" }];
    stored = { ...stored, keybindings: rebound };

    fireEvent.click(screen.getByRole("checkbox"));

    await waitFor(() => expect(stored.clear_scratch_on_exit).toBe(true));
    expect(stored.keybindings).toEqual(rebound);
  });
});
