// @vitest-environment jsdom
//
// The "Toggle calendar time" command palette command: the first command
// that writes a setting. It flips `time_display` through the shared
// settings cache, so every view reading `useSetting("time_display")`
// switches together (ADR 0024 rule 2).

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

let stored: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { settings?: Record<string, unknown> }) => {
    if (cmd === "get_settings") return stored;
    if (cmd === "set_settings") {
      stored = { ...(args?.settings ?? {}) };
      return stored;
    }
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { COMMANDS } from "./commands";
import { hostSettings, hydrateSettings } from "./hostSettings";
import { useCommands } from "./useCommands";

function useHarness() {
  const nullRef = { current: null } as React.MutableRefObject<never | null>;
  return useCommands({
    dockApiRef: nullRef,
    focusHistoryRef: { current: { entries: [], index: -1 } },
    layoutHistoryRef: { current: { entries: [], index: -1 } },
    applyingLayoutRef: { current: false },
    registry: [],
    activePanel: null,
    projectPath: null,
    hasMaximizedView: false,
    notes: { notes: [], add: () => {}, update: () => {}, remove: () => {} },
    firstIndex: 0,
    firstIndexTsNs: null,
    sessionStartSeconds: 0,
    renameElement: () => {},
    appCommands: {},
    recentCaptures: [],
    openRecentCapture: () => {},
    recentProjects: [],
    openRecentProject: () => {},
  } as unknown as Parameters<typeof useCommands>[0]);
}

afterEach(() => {
  cleanup();
});

describe("view.toggleCalendarTime", () => {
  it("is a View command in the palette", () => {
    expect(COMMANDS.find((c) => c.id === "view.toggleCalendarTime")).toMatchObject({
      label: "Toggle calendar time",
      category: "View",
    });
  });

  it("flips time_display between elapsed and calendar", async () => {
    stored = {};
    await hydrateSettings();
    expect(hostSettings().time_display).toBe("elapsed");
    const { result } = renderHook(() => useHarness());

    act(() => result.current.runCommand("view.toggleCalendarTime"));
    await waitFor(() => expect(hostSettings().time_display).toBe("calendar"));
    expect(stored.time_display).toBe("calendar");

    act(() => result.current.runCommand("view.toggleCalendarTime"));
    await waitFor(() => expect(hostSettings().time_display).toBe("elapsed"));
    expect(stored.time_display).toBe("elapsed");
  });
});
