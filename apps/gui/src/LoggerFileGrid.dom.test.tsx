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

import type { LogFileNode } from "./logFileGrid";

const listing = vi.hoisted(() => ({ value: [] as LogFileNode[] }));
const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "list_logger_files") return listing.value;
    if (cmd === "reveal_in_file_manager") return { path: args?.path };
    return null;
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

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
    expect(within(ctx).getByText("Show in Explorer")).toBeInTheDocument();
    fireEvent.click(within(ctx).getByRole("button", { name: /Import/ }));
    expect(onImport).toHaveBeenCalledWith(FILE.id);

    const dirText = await screen.findByText("sub\\");
    fireEvent.contextMenu(dirText.closest(".logger-file-row") as HTMLElement);
    const dirCtx = document.querySelector(".logger-file-ctx") as HTMLElement;
    expect(within(dirCtx).queryByRole("button", { name: /Import/ })).toBeNull();
    expect(within(dirCtx).getByText("Show in Explorer")).toBeInTheDocument();
  });

  it("Show in Explorer reveals the row's own path", async () => {
    listing.value = [FILE];
    render(<LoggerFileGrid folder="C:\logs" writing={false} onImport={vi.fn()} />);
    const row = (await screen.findByText("a.blf")).closest(".logger-file-row") as HTMLElement;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText("Show in Explorer"));
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
});
