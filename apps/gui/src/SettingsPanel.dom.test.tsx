// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// A stand-in for the host: `stored` plays `settings.json` (mutable, so a
// test can change it mid-flight the way a second writer — the shortcuts
// panel's keybinding editor — would), and `set_settings` mirrors the host's
// ingress validation, refusing a below-minimum cap and answering with what
// it actually stored. `minCap` is deliberately *not* the production value,
// so a panel that hard-codes the limit fails these tests.
const minCap = 64 * 1024 * 1024;
let stored: Record<string, unknown> = {};
/// Every `set_settings` payload, in order — so a test can assert *how many*
/// writes an interaction made, not just where it landed.
let writes: Record<string, unknown>[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_settings":
        return { ...stored };
      case "get_settings_bounds":
        return { minScratchCapBytes: minCap };
      case "set_settings": {
        const next = { ...(args?.settings as Record<string, unknown>) };
        writes.push({ ...next });
        const cap = next.scratch_cap_bytes;
        if (typeof cap === "number" && cap < minCap) next.scratch_cap_bytes = null;
        stored = next;
        return { ...stored };
      }
      default:
        return null;
    }
  }),
}));

import type { IDockviewPanelProps } from "dockview";

import { SettingsPanel } from "./SettingsPanel";

beforeEach(() => {
  stored = { scratch_cap_bytes: null, clear_scratch_on_exit: false, keybindings: null };
  writes = [];
});
afterEach(cleanup);

/// Render the panel and wait for it to finish loading (the fieldset is
/// disabled until then, so nothing is clickable before).
async function renderLoaded() {
  render(<SettingsPanel {...({} as IDockviewPanelProps)} />);
  await waitFor(() => expect(screen.getByRole("checkbox")).toBeEnabled());
  return screen.getByRole("spinbutton");
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

  it("takes the cap minimum from the host rather than restating it", async () => {
    const input = await renderLoaded();
    await waitFor(() => expect(input).toHaveAttribute("min", "64"));
    expect(await screen.findByText(/Minimum 64 MB/)).toBeInTheDocument();
  });

  // The host refuses a below-minimum cap, so a box that wrote through on
  // every keystroke could never be typed into: "500" would be refused at
  // "5". The value commits on blur (and Enter), not per keystroke.
  it("commits the typed cap on blur, not on every keystroke", async () => {
    const input = await renderLoaded();

    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.change(input, { target: { value: "500" } });
    // Let any per-keystroke write land before counting.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(writes).toHaveLength(0);
    expect(input).toHaveValue(500);

    fireEvent.blur(input);
    await waitFor(() => expect(stored.scratch_cap_bytes).toBe(500 * 1024 * 1024));
    expect(writes).toHaveLength(1);
    await waitFor(() => expect(input).toHaveValue(500));
  });

  // The host is the judge: a refused value must not linger in the box as if
  // it had been accepted.
  it("shows what the host stored when the cap is refused", async () => {
    const input = await renderLoaded();

    fireEvent.change(input, { target: { value: "15" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input).toHaveValue(null));
    expect(stored.scratch_cap_bytes).toBeNull();
  });
});
