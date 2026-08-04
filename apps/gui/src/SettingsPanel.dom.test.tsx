// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// A stand-in for the host. `stored` plays `settings.json` (mutable, so a
// test can change it mid-flight the way a second writer — the shortcuts
// panel's keybinding editor — would), `set_settings` mirrors the host's
// ingress validation, and `schema` plays the descriptor table. The
// schema is deliberately *not* the real one: the panel is generated from
// whatever the host serves, so these tests describe the framework rather
// than today's settings. `minCap` is likewise not the production value,
// so a panel that hard-codes the limit fails here.
const minCap = 64 * 1024 * 1024;
let stored: Record<string, unknown> = {};
let overrides: string[] = [];
let writes: Record<string, unknown>[] = [];

const schema = {
  surfaces: [
    { id: "general", label: "General" },
    { id: "plot", label: "Plot" },
    { id: "storage", label: "Storage" },
  ],
  settings: [
    {
      key: "show_developer_settings",
      label: "Show developer settings",
      help: "Reveal machine-load and internal-cadence knobs in this view.",
      surfaces: ["general"],
      kind: "behaviour",
      control: { type: "bool" },
      scope: "user",
      default: false,
    },
    {
      key: "keybindings",
      label: "Keyboard shortcuts",
      help: "Your keybinding customisation.",
      surfaces: ["general"],
      kind: "behaviour",
      control: { type: "custom", renderer: "keybindings" },
      scope: "user-overridable",
      default: null,
    },
    {
      key: "scratch_cap_bytes",
      label: "Cache size cap",
      help: "Drop the oldest history once the on-disk cache exceeds this.",
      surfaces: ["storage"],
      kind: "behaviour",
      control: { type: "int", unit: "MB", scale: 1048576, min: minCap, unset: "unbounded" },
      scope: "user-overridable",
      default: null,
    },
    {
      key: "fetch_cadence_hz",
      label: "Plot fetch cadence",
      help: "How often an open plot asks the host for a resampled window.",
      surfaces: ["plot"],
      kind: "developer",
      control: { type: "int", unit: "Hz", scale: 1, min: null, unset: null },
      scope: "user-overridable",
      default: 15,
    },
  ],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_settings":
        return { ...stored };
      case "get_setting_descriptors":
        return schema;
      case "get_settings_overrides":
        return [...overrides];
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

import { hydrateSettings } from "./hostSettings";
import { SettingsPanel } from "./SettingsPanel";

beforeEach(async () => {
  stored = {
    scratch_cap_bytes: null,
    clear_scratch_on_exit: false,
    keybindings: null,
    show_developer_settings: false,
    fetch_cadence_hz: 15,
  };
  overrides = [];
  writes = [];
  // The panel is a view over the shared cache, which the app hydrates
  // before first render.
  await hydrateSettings();
});
afterEach(cleanup);

/// Render the panel and wait for its asynchronous mount work (the
/// descriptor fetch, the re-hydrate) to land.
async function renderLoaded() {
  render(<SettingsPanel {...({} as IDockviewPanelProps)} />);
  await screen.findByText("Cache size cap");
}

/// Type into the search box and wait past the debounce.
async function search(query: string) {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
}

describe("SettingsPanel", () => {
  it("generates a row per descriptor, showing the settings.json key", async () => {
    await renderLoaded();
    expect(screen.getByText("scratch_cap_bytes")).toBeInTheDocument();
    expect(
      screen.getByText(/Drop the oldest history once the on-disk cache exceeds this/),
    ).toBeInTheDocument();
    // Grouped by surface tag, with the surface labels the host served.
    expect(screen.getByRole("treeitem", { name: /Storage/ })).toBeInTheDocument();
  });

  it("takes the cap minimum from the descriptor rather than restating it", async () => {
    await renderLoaded();
    expect(screen.getByRole("spinbutton", { name: "Cache size cap" })).toHaveAttribute(
      "min",
      "64",
    );
  });

  // The host refuses a below-minimum cap, so a box that wrote through on
  // every keystroke could never be typed into: "500" would be refused at
  // "5". The value commits on blur, not per keystroke.
  it("commits a typed value on blur, not on every keystroke", async () => {
    await renderLoaded();
    const input = screen.getByRole("spinbutton", { name: "Cache size cap" });

    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.change(input, { target: { value: "500" } });
    expect(writes).toHaveLength(0);

    fireEvent.blur(input);
    await waitFor(() => expect(stored.scratch_cap_bytes).toBe(500 * 1024 * 1024));
    expect(writes).toHaveLength(1);
  });

  // Regression: the panel used to write the whole struct from its
  // mount-time snapshot, so a keybinding persisted while it was open was
  // silently reverted by the next edit. It must re-read and merge.
  it("keeps a keybinding written by another panel while it was open", async () => {
    await renderLoaded();
    const rebound = [{ chord: "Mod+k", commandId: "palette.show" }];
    stored = { ...stored, keybindings: rebound };

    fireEvent.click(screen.getByRole("checkbox", { name: "Show developer settings" }));

    await waitFor(() => expect(stored.show_developer_settings).toBe(true));
    expect(stored.keybindings).toEqual(rebound);
  });

  it("finds a setting by help text a user can describe but not name", async () => {
    stored = { ...stored, show_developer_settings: true };
    await hydrateSettings();
    await renderLoaded();

    await search("resampled");

    await waitFor(() =>
      expect(screen.queryByText("Cache size cap")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Plot fetch cadence")).toBeInTheDocument();
  });

  it("finds a setting by its tag", async () => {
    await renderLoaded();
    await search("storage");
    await waitFor(() =>
      expect(screen.queryByText("Keyboard shortcuts")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Cache size cap")).toBeInTheDocument();
  });

  it("offers a reset only once a value differs from its default", async () => {
    await renderLoaded();
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Show developer settings" }));

    const reset = await screen.findByRole("button", { name: "Reset to default" });
    fireEvent.click(reset);
    await waitFor(() => expect(stored.show_developer_settings).toBe(false));
  });

  it("marks a value the open project overrides as the project's", async () => {
    overrides = ["scratch_cap_bytes"];
    await renderLoaded();
    expect(await screen.findByText(/Set by this project/)).toBeInTheDocument();
  });
});

describe("developer settings", () => {
  it("are hidden by default, and nothing says so", async () => {
    await renderLoaded();

    expect(screen.queryByText("Plot fetch cadence")).not.toBeInTheDocument();
    // No developer group, and the footer counts only what is visible —
    // a denominator that included the hidden row would advertise it.
    expect(screen.queryByRole("treeitem", { name: /Developer/ })).toBeNull();
    expect(screen.getByText("3 of 3 settings")).toBeInTheDocument();
  });

  it("stay hidden from a search that would otherwise match them", async () => {
    await renderLoaded();
    await search("resampled");
    expect(await screen.findByText(/No settings match/)).toBeInTheDocument();
  });

  // Flipping the toggle must add one group, not grow the surface groups:
  // a user who reveals them to find one knob must not discover that Plot
  // has silently gained a fetch-cadence row.
  it("collect into their own group when revealed, not into their surface", async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole("checkbox", { name: "Show developer settings" }));

    const group = await screen.findByRole("treeitem", { name: /Developer/ });
    fireEvent.click(screen.getByRole("treeitem", { name: /Plot/ }));
    expect(screen.queryByText("Plot fetch cadence")).not.toBeInTheDocument();

    fireEvent.click(group);
    expect(screen.getByText("Plot fetch cadence")).toBeInTheDocument();
    // The row says which surface it would otherwise have been filed under.
    expect(screen.getByText("developer")).toBeInTheDocument();
  });
});
