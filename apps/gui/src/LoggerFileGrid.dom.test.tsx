// @vitest-environment jsdom
//
// The logger folder's file gridview: renders the host's tree (directories
// as branches), and its three import affordances — the per-row button,
// the context menu, and Space on the cursor row — all call the one
// `onImport` the panel wires to the app's real import flow. Nothing here
// re-derives start/end/duration/size — those are asserted as exactly
// what the host sent, formatted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import css from "./index.css?raw";
import { isMacPlatform, isWindowsPlatform } from "./keybindings";
import { LOG_FILE_COLUMN_DEFS } from "./logFileColumns";
import { revealLabel, type LogFileNode } from "./logFileGrid";

/// The reveal entry's label, computed the same way the component does
/// (`revealLabel`) so this test doesn't hardcode a platform-specific
/// string that would fail under a different `navigator.platform`.
const REVEAL_LABEL = revealLabel(isMacPlatform(), isWindowsPlatform());

/// Every rule in the stylesheet, as `[selector, declarations]` — jsdom
/// does no layout and never loads the app's stylesheet, so a rendering
/// test can't see the Import button's real footprint against its cell.
/// Reading the declared numbers back out of the text is the same idiom
/// `nameOverflow.test.ts` uses for the same reason.
function declarationsFor(selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
    if (sel.split(",").some((part) => part.trim() === selector)) out.push(m[2]);
  }
  return out.join("\n");
}
/// The first space-separated number in a declared value, in px (`rem` is
/// resolved against the app's unmodified 16px root — index.css sets no
/// `html { font-size }`). What a `border: <width> <style> <color>`
/// shorthand needs.
function firstNumPx(selector: string, property: string): number {
  const m = declarationsFor(selector).match(new RegExp(`${property}:\\s*([^;]+);`));
  if (!m) throw new Error(`${selector} has no ${property} in index.css`);
  const first = m[1].trim().split(/\s+/)[0];
  return parseFloat(first) * (first.endsWith("rem") ? 16 : 1);
}
/// The last space-separated number in a declared value, in px. What a
/// `padding: <vertical> <horizontal>` shorthand needs for its horizontal
/// component.
function lastNumPx(selector: string, property: string): number {
  const m = declarationsFor(selector).match(new RegExp(`${property}:\\s*([^;]+);`));
  if (!m) throw new Error(`${selector} has no ${property} in index.css`);
  const parts = m[1].trim().split(/\s+/);
  const last = parts[parts.length - 1];
  return parseFloat(last) * (last.endsWith("rem") ? 16 : 1);
}

const listing = vi.hoisted(() => ({ value: [] as LogFileNode[] }));
const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "list_logger_files") return listing.value;
    if (cmd === "reveal_in_file_manager") return { path: args?.path };
    return null;
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
type Handler = (e: { payload: unknown }) => void;
const handlers = vi.hoisted(() => ({ byEvent: new Map<string, Handler[]>() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    const list = handlers.byEvent.get(name) ?? [];
    list.push(handler);
    handlers.byEvent.set(name, list);
    return () => {};
  }),
}));

/// Fire a host event at every listener registered for it.
function emit(name: string, payload: unknown) {
  for (const h of handlers.byEvent.get(name) ?? []) h({ payload });
}

import { LoggerFileGrid } from "./LoggerFileGrid";

const FILE: LogFileNode = {
  kind: "file",
  id: "C:\\logs\\a.blf",
  name: "a.blf",
  sizeBytes: 1_048_576,
  startNs: 1_700_000_000_000_000_000,
  endNs: 1_700_000_010_000_000_000,
  messageCount: 42,
  modifiedMs: 1_700_000_010_000,
  scanPending: false,
  writing: false,
};

/// A file the host has listed but not yet read the header of: stat data
/// is there, the trace columns are not (ADR 0049).
const UNSCANNED: LogFileNode = {
  kind: "file",
  id: "C:\\logs\\fresh.blf",
  name: "fresh.blf",
  sizeBytes: 2_097_152,
  startNs: null,
  endNs: null,
  messageCount: 0,
  modifiedMs: 1_700_000_030_000,
  scanPending: true,
  writing: false,
};

const WRITING: LogFileNode = {
  kind: "file",
  id: "C:\\logs\\open.blf",
  name: "open.blf",
  sizeBytes: 512,
  startNs: null,
  endNs: null,
  messageCount: 3,
  modifiedMs: 1_700_000_020_000,
  scanPending: false,
  writing: true,
};

const SUB: LogFileNode = {
  kind: "dir",
  id: "C:\\logs\\sub",
  name: "sub",
  children: [FILE],
};

beforeEach(() => {
  vi.clearAllMocks();
  listing.value = [];
  handlers.byEvent.clear();
});
afterEach(cleanup);

describe("LoggerFileGrid", () => {
  it("renders nothing while the folder has not resolved", () => {
    const { container } = render(
      <LoggerFileGrid folder={null} writing={false} onImport={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(invoke).not.toHaveBeenCalledWith("list_logger_files", expect.anything());
  });

  it("lists a file with its columns formatted from what the host sent", async () => {
    listing.value = [FILE];
    render(<LoggerFileGrid folder="C:\logs" writing={false} onImport={vi.fn()} />);
    const row = await screen.findByText("a.blf");
    const cells = row.closest(".logger-file-row") as HTMLElement;
    expect(within(cells).getByText("1.0 MB")).toBeInTheDocument();
    expect(within(cells).getByText("42")).toBeInTheDocument();
    // 1_700_000_000 s epoch = 2023-11-14T22:13:20Z.
    expect(within(cells).getByText("2023-11-14T22:13:20Z")).toBeInTheDocument();
  });

  it("uses the shared gridview header, and dragging its handle resizes the tracks", async () => {
    listing.value = [FILE];
    render(<LoggerFileGrid folder="C:\logs" writing={false} onImport={vi.fn()} />);
    await screen.findByText("a.blf");
    const handle = document.querySelector<HTMLElement>(
      ".logger-file-grid .trace-header .col-lf-name .col-resize-handle",
    )!;
    expect(handle).not.toBeNull();
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 160, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 160, pointerId: 1 });
    // 180px default + 60px of drag; the name column is the flex track.
    const row = screen.getByText("a.blf").closest(".logger-file-row") as HTMLElement;
    expect(row.style.gridTemplateColumns.startsWith("minmax(240px")).toBe(true);
  });

  it("gives the action column a default width that clears the Import button's own footprint", () => {
    // The Import button (`.logger-file-import-btn`): its icon plus its
    // own side padding and border, twice over (left and right) —
    // Icon.tsx renders every glyph at a fixed 14px regardless of theme.
    const iconPx = 14;
    const buttonWidthPx =
      iconPx +
      2 * lastNumPx(".logger-file-import-btn", "padding") +
      2 * firstNumPx(".logger-file-import-btn", "border");
    // Every cell in the row — including the action cell the button sits
    // in — carries this on top.
    const cellPaddingRightPx = firstNumPx(".logger-file-row > span", "padding-right");
    const actionDef = LOG_FILE_COLUMN_DEFS.find((d) => d.key === "action")!;
    expect(actionDef.defaultWidth).toBeGreaterThanOrEqual(
      Math.ceil(buttonWidthPx + cellPaddingRightPx),
    );
  });

  it("the action column is resizable by its own header handle", async () => {
    listing.value = [FILE];
    const onColumnsChange = vi.fn();
    render(
      <LoggerFileGrid
        folder="C:\logs"
        writing={false}
        onImport={vi.fn()}
        onColumnsChange={onColumnsChange}
      />,
    );
    await screen.findByText("a.blf");
    const handle = document.querySelector<HTMLElement>(
      ".logger-file-grid .trace-header .col-lf-action .col-resize-handle",
    )!;
    expect(handle).not.toBeNull();
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 130, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 130, pointerId: 1 });
    expect(onColumnsChange).toHaveBeenCalled();
    const calls = onColumnsChange.mock.calls;
    const last = calls[calls.length - 1][0] as { key: string; width: number }[];
    // 40px default + 30px of drag.
    expect(last.find((c) => c.key === "action")?.width).toBe(70);
  });

  it("reports a changed layout for the panel to persist, and seeds from a saved one", async () => {
    listing.value = [FILE];
    const onColumnsChange = vi.fn();
    render(
      <LoggerFileGrid
        folder="C:\logs"
        writing={false}
        onImport={vi.fn()}
        initialColumns={[{ key: "size", width: 99, visible: true }]}
        onColumnsChange={onColumnsChange}
      />,
    );
    await screen.findByText("a.blf");
    // The saved width survived the parse (missing columns fill in).
    const row = screen.getByText("a.blf").closest(".logger-file-row") as HTMLElement;
    expect(row.style.gridTemplateColumns).toContain("99px");
    const handle = document.querySelector<HTMLElement>(
      ".trace-header .col-lf-size .col-resize-handle",
    )!;
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 121, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 121, pointerId: 1 });
    expect(onColumnsChange).toHaveBeenCalled();
    const calls = onColumnsChange.mock.calls;
    const last = calls[calls.length - 1][0] as { key: string; width: number }[];
    expect(last.find((c) => c.key === "size")?.width).toBe(120);
  });

  it("shows a directory as a collapsed branch and expands it on the caret", async () => {
    listing.value = [SUB];
    render(<LoggerFileGrid folder="C:\logs" writing={false} onImport={vi.fn()} />);
    await screen.findByText("sub\\");
    expect(screen.queryByText("a.blf")).toBeNull();
    fireEvent.click(document.querySelector(".logger-file-caret") as HTMLElement);
    await screen.findByText("a.blf");
  });

  it("marks a directory with the separator the host's folder uses", async () => {
    // The folder the panel passes down is one of the running OS's own
    // paths, and it is the only thing here that knows which OS that is —
    // so a mac gets `sub/`, not the `sub\` a Windows build shows.
    listing.value = [{ ...SUB, id: "/logs/sub" }];
    render(<LoggerFileGrid folder="/Users/dev/logs" writing={false} onImport={vi.fn()} />);
    await screen.findByText("sub/");
    expect(screen.queryByText("sub\\")).toBeNull();
  });

  it("the writing row carries the writing marker and no import button", async () => {
    listing.value = [WRITING];
    render(<LoggerFileGrid folder="C:\logs" writing={false} onImport={vi.fn()} />);
    const row = (await screen.findByText("open.blf")).closest(".logger-file-row") as HTMLElement;
    expect(row.className).toContain("writing");
    expect(within(row).queryByRole("button", { name: "Import" })).toBeNull();
  });

  it("the per-row Import button calls onImport with the file's path", async () => {
    listing.value = [FILE];
    const onImport = vi.fn();
    render(<LoggerFileGrid folder="C:\logs" writing={false} onImport={onImport} />);
    await screen.findByText("a.blf");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(onImport).toHaveBeenCalledWith(FILE.id);
  });

  it("Space on the cursor row imports it, and does nothing on a directory", async () => {
    listing.value = [SUB, FILE];
    const onImport = vi.fn();
    render(<LoggerFileGrid folder="C:\logs" writing={false} onImport={onImport} />);
    await screen.findByText("sub\\");
    const grid = screen.getByRole("tree", { name: "Files in folder" });
    // Cursor starts nowhere; Home lands it on the directory row first.
    fireEvent.keyDown(grid, { key: "Home" });
    fireEvent.keyDown(grid, { key: " " });
    expect(onImport).not.toHaveBeenCalled();
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: " " });
    expect(onImport).toHaveBeenCalledWith(FILE.id);
  });

  it("the context menu offers Import for a file and only reveal for a directory", async () => {
    listing.value = [SUB, FILE];
    const onImport = vi.fn();
    render(<LoggerFileGrid folder="C:\logs" writing={false} onImport={onImport} />);
    const fileText = await screen.findByText("a.blf");
    fireEvent.contextMenu(fileText.closest(".logger-file-row") as HTMLElement);
    const ctx = document.querySelector(".logger-file-ctx") as HTMLElement;
    expect(within(ctx).getByRole("button", { name: /Import/ })).toBeInTheDocument();
    expect(within(ctx).getByText(REVEAL_LABEL)).toBeInTheDocument();
    fireEvent.click(within(ctx).getByRole("button", { name: /Import/ }));
    expect(onImport).toHaveBeenCalledWith(FILE.id);

    const dirText = await screen.findByText("sub\\");
    fireEvent.contextMenu(dirText.closest(".logger-file-row") as HTMLElement);
    const dirCtx = document.querySelector(".logger-file-ctx") as HTMLElement;
    expect(within(dirCtx).queryByRole("button", { name: /Import/ })).toBeNull();
    expect(within(dirCtx).getByText(REVEAL_LABEL)).toBeInTheDocument();
  });

  it("Show in Explorer reveals the row's own path", async () => {
    listing.value = [FILE];
    render(<LoggerFileGrid folder="C:\logs" writing={false} onImport={vi.fn()} />);
    const row = (await screen.findByText("a.blf")).closest(".logger-file-row") as HTMLElement;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText(REVEAL_LABEL));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_in_file_manager", { path: FILE.id }),
    );
  });

  it("polls the listing only while writing", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <LoggerFileGrid folder="C:\logs" writing={false} onImport={vi.fn()} />,
      );
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("list_logger_files", { folder: "C:\\logs" }),
      );
      // Let the snapshot pair around listener registration settle first:
      // the mirror coalesces the post-listener refetch behind the mount
      // fetch, so it lands a round trip later than the mount render.
      await vi.advanceTimersByTimeAsync(10_000);
      const callsIdle = invoke.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(invoke.mock.calls.length).toBe(callsIdle);

      rerender(<LoggerFileGrid folder="C:\logs" writing={true} onImport={vi.fn()} />);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(invoke.mock.calls.length).toBeGreaterThan(callsIdle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the trace columns as pending while the host is still reading the header", async () => {
    // The listing answers with stat data and says the rest is not read
    // yet (ADR 0049). Zeros would read as measurements — "no frames" and
    // "not looked at" are different answers.
    listing.value = [UNSCANNED];
    render(<LoggerFileGrid folder="C:\logs" writing={false} onImport={vi.fn()} />);
    const row = (await screen.findByText("fresh.blf")).closest(
      ".logger-file-row",
    ) as HTMLElement;
    // Stat data is served at once.
    expect(within(row).getByText("2.0 MB")).toBeInTheDocument();
    // Start, end, duration and messages are pending, not zero.
    expect(within(row).queryByText("0")).not.toBeInTheDocument();
    expect(within(row).getAllByText("\u2026")).toHaveLength(4);
    expect(row.querySelectorAll(".logger-file-cell.pending")).toHaveLength(4);
  });

  it("re-asks for the listing when the host announces a finished scan", async () => {
    listing.value = [UNSCANNED];
    render(<LoggerFileGrid folder="C:\logs" writing={false} onImport={vi.fn()} />);
    await screen.findByText("fresh.blf");
    await waitFor(() =>
      expect(handlers.byEvent.get("logger-files-scanned")?.length).toBeGreaterThan(0),
    );

    // The scan lands host-side and announces itself; the grid asks again
    // and the columns fill in.
    listing.value = [{ ...UNSCANNED, scanPending: false, startNs: 1, endNs: 2, messageCount: 9 }];
    emit("logger-files-scanned", "C:\\logs\\fresh.blf");
    const row = await waitFor(() => {
      const el = screen.getByText("fresh.blf").closest(".logger-file-row") as HTMLElement;
      expect(within(el).getByText("9")).toBeInTheDocument();
      return el;
    });
    expect(row.querySelectorAll(".logger-file-cell.pending")).toHaveLength(0);
  });
});
