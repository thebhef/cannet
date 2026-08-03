// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// A stand-in host. `rows` is what `list_project_caches` serves; `calls`
// records what the list asked it to do, so a test can assert that Clear
// and Delete are genuinely different commands rather than two buttons
// onto one.
let rows: unknown[] = [];
const calls: { cmd: string; root?: string }[] = [];
let failWith: string | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "list_project_caches") return rows;
    calls.push({ cmd, root: args?.root as string | undefined });
    if (failWith !== null) throw new Error(failWith);
    return null;
  }),
}));

import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ProjectCachesList } from "./ProjectCachesList";
import type { ProjectCacheRow } from "./projectCaches";

function row(patch: Partial<ProjectCacheRow>): ProjectCacheRow {
  return {
    root: "/work/ev-zonal",
    cache: "/cache/abc",
    project_file: null,
    bytes: 3 * 1024 * 1024 * 1024,
    state: "known",
    auto_located: false,
    last_used_seconds: 1_700,
    ...patch,
  };
}

beforeEach(() => {
  rows = [];
  calls.length = 0;
  failWith = null;
});
afterEach(cleanup);

/// Render the list with an optional project context (only Save As needs
/// one), and wait for the first load — one Delete button per row, since
/// every row has one whatever state it is in.
async function renderList(onSaveProjectAs?: () => void) {
  if (onSaveProjectAs === undefined) {
    render(<ProjectCachesList />);
  } else {
    render(
      <ProjectContext.Provider
        value={{ projectPath: null, onSaveProjectAs } as unknown as ProjectContextValue}
      >
        <ProjectCachesList />
      </ProjectContext.Provider>,
    );
  }
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(rows.length),
  );
}

describe("the project cache list", () => {
  it("lists every project directory with its badge, path, and size", async () => {
    rows = [
      row({ root: "/work/ev-zonal", state: "active", bytes: 3 * 1024 * 1024 * 1024 }),
      row({ root: "/work/bodyctl", bytes: 512 * 1024 * 1024 }),
    ];
    await renderList();

    expect(screen.getByText("/work/ev-zonal")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("3.0 GB")).toBeInTheDocument();
    expect(screen.getByText(/2 projects · 3\.5 GB cached/)).toBeInTheDocument();
  });

  // The distinction ADR 0042 §5's table draws, at the UI: two buttons,
  // two commands, and the row survives a Clear.
  it("sends Clear and Delete to different commands and re-reads afterwards", async () => {
    rows = [row({ root: "/work/bodyctl" })];
    await renderList();

    fireEvent.click(screen.getByRole("button", { name: "Clear data cache" }));
    await waitFor(() => expect(calls).toEqual([{ cmd: "clear_project_cache", root: "/work/bodyctl" }]));
    expect(screen.getByText("/work/bodyctl")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ cmd: "delete_project_cache", root: "/work/bodyctl" });
  });

  it("empties every cache from the header without removing anything", async () => {
    rows = [row({ root: "/a" }), row({ root: "/b" })];
    await renderList();

    fireEvent.click(screen.getByRole("button", { name: "Clear all data caches" }));

    await waitFor(() => expect(calls).toEqual([{ cmd: "clear_all_project_caches" }]));
    expect(screen.getByText("/a")).toBeInTheDocument();
    expect(screen.getByText("/b")).toBeInTheDocument();
  });

  it("refuses Delete for the open project and points at Clear instead", async () => {
    rows = [row({ root: "/work/open", state: "active" })];
    await renderList();

    const del = screen.getByRole("button", { name: "Delete" });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute("title", expect.stringContaining("Clear it instead"));
    expect(screen.getByRole("button", { name: "Clear data cache" })).toBeEnabled();
  });

  it("offers nothing to clear on a row that holds nothing", async () => {
    rows = [row({ root: "/work/empty", bytes: 0 })];
    await renderList();
    expect(screen.getByRole("button", { name: "Clear data cache" })).toBeDisabled();
  });

  // The Save As offer: on the rows living in cache space, and takeable
  // only on the project that is open, because Save As moves the session.
  it("offers Save as… on an auto-located row, enabled only for the open project", async () => {
    const saveAs = vi.fn();
    rows = [
      row({ root: "/cache/projects/aaa", state: "active", auto_located: true }),
      row({ root: "/cache/projects/bbb", state: "auto-located", auto_located: true }),
      row({ root: "/work/named" }),
    ];
    await renderList(saveAs);

    const offers = screen.getAllByRole("button", { name: "Save as…" });
    expect(offers).toHaveLength(2);
    expect(offers[0]).toBeEnabled();
    expect(offers[1]).toBeDisabled();

    fireEvent.click(offers[0]);
    expect(saveAs).toHaveBeenCalled();
  });

  // A directory deleted outside the app: the row stays, says so, and can
  // still be cleared and deleted. Nothing about it stops the list
  // rendering.
  it("lists a project directory that is gone rather than failing", async () => {
    rows = [row({ root: "/gone/rig-04", state: "missing", bytes: 9 * 1024 * 1024 })];
    await renderList();

    expect(screen.getByText("project gone")).toBeInTheDocument();
    expect(screen.getByText("/gone/rig-04")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  // ADR 0042 §2: moving a `.cannet_prj` away from its `.cannet/`
  // un-pairs it, and the orphaned directory is what the registry
  // surfaces so its cache can be reclaimed.
  it("says when a listed directory no longer holds a project file", async () => {
    rows = [row({ root: "/work/unpaired", state: "orphaned" })];
    await renderList();
    expect(screen.getByText("no project file")).toBeInTheDocument();
  });

  it("reports a failed action without losing the list", async () => {
    rows = [row({ root: "/work/locked" })];
    await renderList();
    failWith = "permission denied";

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText(/permission denied/)).toBeInTheDocument(),
    );
    expect(screen.getByText("/work/locked")).toBeInTheDocument();
  });

  it("says so when nothing is recorded", async () => {
    rows = [];
    render(<ProjectCachesList />);
    await waitFor(() =>
      expect(screen.getByText("No project caches recorded.")).toBeInTheDocument(),
    );
  });
});
