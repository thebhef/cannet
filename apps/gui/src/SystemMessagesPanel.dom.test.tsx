// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const { SystemLogContext } = await import("./systemLogContext");
type SystemMessage = import("./types").SystemMessage;

/// Render the panel over a fixed message list. The real provider is
/// `App.tsx`'s; the panel only reads from the context.
function withMessages(messages: SystemMessage[], props: IDockviewPanelProps) {
  return (
    <SystemLogContext.Provider
      value={{ messages, unread: 0, clear: () => {}, markRead: () => {} }}
    >
      <SystemMessagesPanel {...props} />
    </SystemLogContext.Provider>
  );
}

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

describe("SystemMessagesPanel horizontal scroll", () => {
  const msg = (seq: number, message: string): SystemMessage => ({
    seq,
    source: "sidecar",
    level: "info",
    message,
    ts_ms: 1_700_000_000_000 + seq,
  });

  // The stylesheet turns this count into the scrolled stack's width (one
  // character is `1ch` in the panel's monospace rows) so the scroll range
  // covers the whole filtered set, not just the rows the virtualizer has
  // mounted. That the two halves add up to an actual scrollbar is only
  // visible in Chromium — jsdom does no layout; see
  // `dockPanelScrolling.test.ts` for the measurement.
  it("publishes the longest message's length to the scrolled stack", async () => {
    await hydrateSettings();
    const long = "x".repeat(140);
    const { container } = render(
      withMessages([msg(0, "short"), msg(1, long)], panelProps().props),
    );

    const content = container.querySelector(
      ".system-messages-scroll-content",
    ) as HTMLElement;
    expect(content).not.toBeNull();
    expect(content.style.getPropertyValue("--system-messages-message-chars")).toBe("140");
  });

  it("measures the filtered set, not the whole buffer", async () => {
    // A long message the filter hides must not leave the view scrollable
    // past anything it can show.
    stored = { system_log_min_level: "warn" };
    await hydrateSettings();
    const { container } = render(
      withMessages([msg(0, "x".repeat(200))], panelProps().props),
    );

    const content = container.querySelector(
      ".system-messages-scroll-content",
    ) as HTMLElement;
    expect(content.style.getPropertyValue("--system-messages-message-chars")).toBe("0");
  });
});

describe("SystemMessagesPanel toolbar buttons", () => {
  // Copy All and Clear are adjacent chips with opposite blast radii —
  // one reads the clipboard, the other wipes the log — so a test that
  // only checks "a click did something" cannot tell one wired to the
  // other's handler.
  const msg = (seq: number): SystemMessage => ({
    seq,
    source: "sidecar",
    level: "info",
    message: `entry ${seq}`,
    ts_ms: 1_700_000_000_000 + seq,
  });

  it("Copy All copies without clearing; Clear clears without copying", async () => {
    await hydrateSettings();
    const clearSpy = vi.fn();
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <SystemLogContext.Provider
        value={{ messages: [msg(0), msg(1)], unread: 0, clear: clearSpy, markRead: () => {} }}
      >
        <SystemMessagesPanel {...panelProps().props} />
      </SystemLogContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy All" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("entry 0"));
    expect(clearSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});
