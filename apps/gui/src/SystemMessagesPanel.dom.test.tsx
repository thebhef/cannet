// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview";

// A stand-in for the host's `settings.json`. `stored` is mutable so a
// test can play a hand-edit, and `set_settings` echoes back what it
// stored, as the real command does.
let stored: Record<string, unknown> = {};
let writes: Record<string, unknown>[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_settings":
        return { ...stored };
      case "set_settings": {
        const next = { ...(args?.settings as Record<string, unknown>) };
        writes.push({ ...next });
        stored = next;
        return { ...stored };
      }
      default:
        return null;
    }
  }),
}));

const { SystemMessagesPanel } = await import("./SystemMessagesPanel");
const { hydrateSettings } = await import("./hostSettings");
const { pickCombobox, comboboxValue } = await import("./comboboxTestKit");

/// The panel takes dockview props; only `api.updateParameters` and the
/// activity hooks are exercised here.
function panelProps(params: Record<string, unknown> = {}): {
  props: IDockviewPanelProps;
  updateParameters: ReturnType<typeof vi.fn>;
} {
  const updateParameters = vi.fn();
  return {
    props: {
      api: {
        updateParameters,
        onDidActiveChange: () => ({ dispose: () => {} }),
      },
      params,
    } as unknown as IDockviewPanelProps,
    updateParameters,
  };
}

/// The "Min level" combobox — the second one in the toolbar, after the
/// source filter.
function levelBox(): HTMLElement {
  return screen.getAllByRole("combobox")[1];
}

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  stored = {};
  writes = [];
});
afterEach(cleanup);

describe("SystemMessagesPanel minimum level", () => {
  it("takes its level from settings, not from panel params", async () => {
    // The whole point of the move: a level is a preference, so a fresh
    // panel with an empty params blob still opens at the stored level.
    stored = { system_log_min_level: "error" };
    await hydrateSettings();

    render(<SystemMessagesPanel {...panelProps().props} />);

    await waitFor(() => expect(comboboxValue(levelBox())).toBe("error"));
  });

  it("persists a chosen level to settings.json", async () => {
    await hydrateSettings();
    const { props, updateParameters } = panelProps();
    render(<SystemMessagesPanel {...props} />);

    await pickCombobox(levelBox(), "warn");

    await waitFor(() => expect(stored.system_log_min_level).toBe("warn"));
    // ...and not into the panel's dockview params, which is where it
    // used to go and why it reset with every new panel.
    for (const call of updateParameters.mock.calls) {
      expect(call[0]).not.toHaveProperty("minLevel");
    }
  });

  it("survives the panel closing and reopening", async () => {
    await hydrateSettings();
    render(<SystemMessagesPanel {...panelProps().props} />);
    await pickCombobox(levelBox(), "debug");
    await waitFor(() => expect(stored.system_log_min_level).toBe("debug"));

    cleanup();
    await hydrateSettings();
    render(<SystemMessagesPanel {...panelProps().props} />);

    await waitFor(() => expect(comboboxValue(levelBox())).toBe("debug"));
  });

  it("keeps the source filter in panel params", async () => {
    await hydrateSettings();
    const { props, updateParameters } = panelProps({ filterSource: "sidecar" });
    render(<SystemMessagesPanel {...props} />);

    await waitFor(() =>
      expect(updateParameters).toHaveBeenCalledWith({ filterSource: "sidecar" }),
    );
    expect(writes).toEqual([]);
  });
});
