// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
/// What `list_project_caches` serves — the settings view's one custom
/// renderer that reads the host directly rather than a settings key.
let caches: unknown[] = [];

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
      backing: "field",
      control: { type: "bool" },
      scope: "user",
      default: false,
    },
    {
      key: "scratch_cap_bytes",
      label: "Cache size cap",
      help: "Drop the oldest history once the on-disk cache exceeds this.",
      surfaces: ["storage"],
      kind: "behaviour",
      backing: "field",
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
      backing: "field",
      control: { type: "int", unit: "Hz", scale: 1, min: null, unset: null },
      scope: "user-overridable",
      default: 15,
    },
    // A row that is not a `settings.json` field at all — a surface the
    // panel hosts (ADR 0034's descriptor consequences). Synthetic, like
    // the rest: the panel renders whatever the host serves.
    {
      key: "a_view_row",
      label: "A hosted surface",
      help: "",
      surfaces: ["storage"],
      kind: "behaviour",
      backing: "view",
      control: { type: "custom", renderer: "test-view" },
      scope: null,
      default: null,
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
      case "list_project_caches":
        return caches;
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

// The project caches list listens for the host's re-root announcement;
// nothing in this file fires one, so the subscription just has to exist.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import type { IDockviewPanelProps } from "dockview";

import { SETTINGS_PANEL_ID } from "./dockLayout";
import { hydrateSettings } from "./hostSettings";
import { createPanelCommandRegistry, PanelCommandsContext } from "./panelCommands";
import { CUSTOM_SETTING_RENDERERS } from "./settingControls";
import { ProjectCachesList } from "./ProjectCachesList";
import type { ProjectCacheRow } from "./projectCaches";
import { SettingsPanel } from "./SettingsPanel";

beforeEach(async () => {
  CUSTOM_SETTING_RENDERERS["test-view"] = () => <p>the hosted surface</p>;
  stored = {
    scratch_cap_bytes: null,
    clear_scratch_on_exit: false,
    keybindings: null,
    show_developer_settings: false,
    fetch_cadence_hz: 15,
  };
  overrides = [];
  writes = [];
  caches = [];
  // The panel is a view over the shared cache, which the app hydrates
  // before first render.
  await hydrateSettings();
});
afterEach(() => {
  delete CUSTOM_SETTING_RENDERERS["test-view"];
  cleanup();
});

/// The slice of dockview's panel API the settings view touches: the
/// visibility signal it re-reads and restores its scroll position on.
/// `setVisible` drives the registered listener so a test can switch away
/// from the panel and back.
/// One row of `list_project_caches`, as the host serves it.
function cacheRow(bytes: number): ProjectCacheRow {
  return {
    root: "/work/rig",
    cache: "/cache/abc",
    project_file: "/work/rig/rig.cannet_prj",
    bytes,
    state: "active",
    auto_located: false,
    last_used_seconds: 1_700,
  };
}

function fakePanelApi() {
  const listeners = new Set<(e: { isVisible: boolean }) => void>();
  return {
    isVisible: true,
    onDidVisibilityChange(fn: (e: { isVisible: boolean }) => void) {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    setVisible(isVisible: boolean) {
      act(() => {
        for (const fn of listeners) fn({ isVisible });
      });
    },
    /// How the view consumes a reveal request (`params.reveal`) — it
    /// clears the parameter so the request cannot outlive the arrival
    /// it belongs to.
    updateParameters: vi.fn(),
  };
}

function panelProps(
  api: ReturnType<typeof fakePanelApi>,
  params: Record<string, unknown> = {},
) {
  return { api, params } as unknown as IDockviewPanelProps;
}

/// Render the panel and wait for its asynchronous mount work (the
/// descriptor fetch, the re-hydrate) to land.
async function renderLoaded() {
  const api = fakePanelApi();
  const { container } = render(<SettingsPanel {...panelProps(api)} />);
  await screen.findByText("Cache size cap");
  return { api, container };
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

  // A row that is not a `settings.json` field shows no key: the panel
  // teaches the file, and pointing at a key nothing stores would teach
  // the wrong thing (ADR 0034).
  it("shows no settings key for a row that is a hosted surface", async () => {
    await renderLoaded();
    expect(screen.getByText("A hosted surface")).toBeInTheDocument();
    expect(screen.getByText("the hosted surface")).toBeInTheDocument();
    expect(screen.queryByText("a_view_row")).not.toBeInTheDocument();
    // And it is still searchable and still offers nothing to reset.
    expect(
      screen.queryByRole("button", { name: "Reset to default" }),
    ).not.toBeInTheDocument();
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
      expect(screen.queryByText("Show developer settings")).not.toBeInTheDocument(),
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
  // has silently gained a fetch-cadence row. Plot holds nothing else in
  // this schema, so it is absent from the tree either way — revealing a
  // developer setting must not conjure its surface back into the tree.
  it("collect into their own group when revealed, not into their surface", async () => {
    await renderLoaded();
    expect(screen.queryByRole("treeitem", { name: /Plot/ })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Show developer settings" }));

    const group = await screen.findByRole("treeitem", { name: /Developer/ });
    expect(screen.queryByRole("treeitem", { name: /Plot/ })).toBeNull();

    fireEvent.click(group);
    expect(screen.getByText("Plot fetch cadence")).toBeInTheDocument();
    // The row says which surface it would otherwise have been filed under.
    expect(screen.getByText("developer")).toBeInTheDocument();
  });

  // A self-describing setting carries no help text. The paragraph must
  // not render at all — an empty one still takes its margin, which
  // reads as a missing description rather than a label that says
  // everything.
  it("render no description paragraph for a setting that needs none", async () => {
    await renderLoaded();
    const row = screen.getByText("A hosted surface").closest(".setting");
    expect(row).not.toBeNull();
    expect(row?.querySelector(".setting-desc")).toBeNull();
    // The row that does have help still shows it.
    const capped = screen.getByText("Cache size cap").closest(".setting");
    expect(capped?.querySelector(".setting-desc")).not.toBeNull();
  });

  // An empty group is noise, and worse than noise when it implies the
  // user has missed something.
  it("hide a surface group that has no settings to show", async () => {
    await renderLoaded();
    expect(screen.getByRole("treeitem", { name: /Storage/ })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /Plot/ })).toBeNull();
  });

  // Filtering a search within a group hides matches outside it, and the
  // panel then looks like it found nothing when it found plenty.
  it("clear the group selection when a search starts", async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole("treeitem", { name: /Storage/ }));
    expect(screen.getByRole("treeitem", { name: /Storage/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await search("developer");

    expect(screen.getByRole("treeitem", { name: /All settings/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Show developer settings")).toBeInTheDocument();
  });
});

describe("SettingsPanel command registration (panel.find)", () => {
  it("focuses and selects the search box", async () => {
    const commands = createPanelCommandRegistry();
    render(
      <PanelCommandsContext.Provider value={commands}>
        <SettingsPanel {...panelProps(fakePanelApi())} />
      </PanelCommandsContext.Provider>,
    );
    await screen.findByText("Cache size cap");

    const box = screen.getByRole("searchbox") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "cache" } });
    expect(document.activeElement).not.toBe(box);

    act(() => {
      commands.invoke(SETTINGS_PANEL_ID, "panel.find");
    });

    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(box.value.length);
  });
});

// The owner, 2026-09-21: "reopening the settings view refreshed it once;
// after switching to other plots and rebuilding some caches it was stale
// again", and "it does not retain its scroll position". The view owns no
// data — everything on it is a read of the host — and nothing polls
// (ADR 0002 DS-8), so coming back on screen is when it re-reads.
describe("the settings view on return", () => {
  it("re-reads the settings file and the project's overrides", async () => {
    const { api } = await renderLoaded();
    expect(screen.queryByText("Plot fetch cadence")).not.toBeInTheDocument();
    expect(screen.queryByText(/Set by this project/)).not.toBeInTheDocument();

    // Away: another writer edits `settings.json`, and the project that
    // was opened in the meantime overrides a key.
    api.setVisible(false);
    stored = { ...stored, show_developer_settings: true };
    overrides = ["scratch_cap_bytes"];

    api.setVisible(true);

    expect(await screen.findByText("Plot fetch cadence")).toBeInTheDocument();
    expect(screen.getByText(/Set by this project/)).toBeInTheDocument();
  });

  // The project caches list is reached only through the custom-renderer
  // table, so it hears about the return through the count the view
  // publishes. A cache that grew while another panel was on screen shows
  // its new size, measured on return rather than on a timer.
  it("re-measures the project caches it lists", async () => {
    CUSTOM_SETTING_RENDERERS["test-view"] = () => <ProjectCachesList />;
    caches = [cacheRow(512 * 1024 * 1024)];
    const { api } = await renderLoaded();
    expect(await screen.findByText("512 MB")).toBeInTheDocument();

    api.setVisible(false);
    caches = [cacheRow(3 * 1024 * 1024 * 1024)];
    api.setVisible(true);

    expect(await screen.findByText("3.0 GB")).toBeInTheDocument();
    expect(screen.queryByText("512 MB")).not.toBeInTheDocument();
  });

  it("keeps its scroll position", async () => {
    const { api, container } = await renderLoaded();
    const list = container.querySelector(".settings-list") as HTMLElement;
    // jsdom does no layout, so the list has no scroll range of its own.
    Object.defineProperty(list, "scrollTop", { value: 0, writable: true });

    list.scrollTop = 240;
    fireEvent.scroll(list);

    // Hidden: dockview's default renderer removes the panel's element
    // from the document (dockview-core 6.0.7,
    // `ContentContainer.renderPanel`, the `onlyWhenVisible` branch), and
    // a box with no layout keeps no scroll offset — it comes back at the
    // top. That reset is what jsdom cannot produce, so it is spelled out.
    api.setVisible(false);
    container.remove();
    list.scrollTop = 0;

    // Shown again: dockview re-attaches the element before it announces
    // the panel visible, so the offset can be put back straight away.
    document.body.appendChild(container);
    api.setVisible(true);

    expect(list.scrollTop).toBe(240);
  });
});

// Opening the view *at* a section (ADR 0041's Servers rows are the
// case it exists for): a `reveal` parameter names a setting key, the
// view scrolls its row into sight, and the request is consumed so a
// layout persisted while it was set does not re-scroll on every later
// open.
describe("a reveal request", () => {
  /// jsdom implements no `scrollIntoView`, so the call the view makes
  /// is what a test can see. Installed per test and taken back off.
  function spyScrollIntoView() {
    const calls: Element[] = [];
    const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
    const had = "scrollIntoView" in proto;
    const before = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      calls.push(this);
    };
    return {
      calls,
      restore() {
        if (had) proto.scrollIntoView = before;
        else delete proto.scrollIntoView;
      },
    };
  }

  it("scrolls the named row into view and clears the parameter", async () => {
    const spy = spyScrollIntoView();
    try {
      const api = fakePanelApi();
      render(<SettingsPanel {...panelProps(api, { reveal: "a_view_row" })} />);
      await screen.findByText("A hosted surface");
      await waitFor(() => expect(spy.calls.length).toBe(1));
      expect(spy.calls[0].id).toBe("setting-row-a_view_row");
      expect(api.updateParameters).toHaveBeenCalledWith({ reveal: undefined });
    } finally {
      spy.restore();
    }
  });

  it("clears a search that would have hidden the row it was asked for", async () => {
    const spy = spyScrollIntoView();
    try {
      const api = fakePanelApi();
      const { rerender } = render(<SettingsPanel {...panelProps(api)} />);
      await screen.findByText("Cache size cap");
      await search("cadence");
      await waitFor(() =>
        expect(screen.queryByText("A hosted surface")).not.toBeInTheDocument(),
      );
      rerender(<SettingsPanel {...panelProps(api, { reveal: "a_view_row" })} />);
      await screen.findByText("A hosted surface");
      expect(screen.getByRole("searchbox")).toHaveValue("");
      await waitFor(() => expect(spy.calls.length).toBe(1));
    } finally {
      spy.restore();
    }
  });

  it("scrolls nowhere when no reveal is asked for", async () => {
    const spy = spyScrollIntoView();
    try {
      await renderLoaded();
      expect(spy.calls).toEqual([]);
    } finally {
      spy.restore();
    }
  });
});
