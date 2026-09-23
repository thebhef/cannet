// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

// `listen` is how the list hears the host re-root the session
// (`project-dir-changed`, ADR 0042 §1). The mock keeps the handlers so a
// test can announce one.
const mockListeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    const set = mockListeners.get(event) ?? new Set();
    set.add(handler);
    mockListeners.set(event, set);
    return () => set.delete(handler);
  }),
}));
/// Deliver a host event to whatever the list subscribed.
function emitHostEvent(event: string, payload: unknown = null) {
  for (const h of mockListeners.get(event) ?? []) h({ payload });
}

import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ProjectCachesList } from "./ProjectCachesList";
import type { ProjectCacheRow } from "./projectCaches";
import { SettingsShownContext } from "./settingsShown";

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
  mockListeners.clear();
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

    // Delete is the shared two-stage trash control: the first click only
    // arms it.
    const del = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(del);
    expect(calls).toHaveLength(1);
    fireEvent.click(del);
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

    const del = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(del);
    fireEvent.click(del);

    await waitFor(() =>
      expect(screen.getByText(/permission denied/)).toBeInTheDocument(),
    );
    expect(screen.getByText("/work/locked")).toBeInTheDocument();
  });

  // Observation 1 of the owner's 2026-09-21 report: the row said nothing
  // about which project a cache-space directory belonged to. The project
  // file has no `name` field, so the row's name is the file stem
  // (`projectName`, the same one the window title and export templates
  // use), and the directory path — which is what actually named the row
  // before — becomes a secondary line and stays in the tooltip.
  it("leads a row with its project's name and keeps the path as a secondary line and tooltip", async () => {
    rows = [row({ root: "/work/rig", project_file: "/work/rig/rig.cannet_prj" })];
    await renderList();

    expect(screen.getByText("rig")).toBeInTheDocument();
    const path = screen.getByText("/work/rig");
    expect(path.closest(".project-cache-info")).toHaveAttribute("title", "/work/rig");
  });

  it("reads unsaved for the entry with no project file", async () => {
    rows = [row({ root: "/cache/projects/scratch", project_file: null })];
    await renderList();
    expect(screen.getByText("unsaved")).toBeInTheDocument();
  });

  // Owner ruling 2026-09-21: just the name and why — no further
  // affordance on an auto-located row beyond the existing Save as….
  // Owner review 2026-09-22 (a): the tooltip belongs on the location
  // chip, not the state badge — see the chip tests below for why, and
  // for the active-and-auto-located row this test used to leave out.
  it("explains in the location chip's tooltip why the directory is in cache space", async () => {
    rows = [row({ root: "/cache/projects/bbb", state: "auto-located", auto_located: true })];
    await renderList();

    const chip = screen.getByText("auto-located");
    expect(chip).toHaveAttribute("title", expect.stringContaining(".cannet/"));
    expect(chip).toHaveAttribute("title", expect.stringContaining("Save as…"));
  });

  // Owner review, 2026-09-22 (a): the auto-located tooltip goes on every
  // auto-located row, the active one included — before this, the tooltip
  // was keyed on `row.state === "auto-located"`, which an active row
  // never carries (its state is "active" whatever its location), so
  // observation 3's row (opened straight from a loose project file) wore
  // no tooltip at all.
  it("puts the auto-located tooltip on the active row too, when it is auto-located", async () => {
    rows = [row({ root: "/cache/projects/aaa", state: "active", auto_located: true })];
    await renderList();

    const chip = screen.getByText("auto-located");
    expect(chip).toHaveAttribute("title", expect.stringContaining(".cannet/"));
    expect(chip).toHaveAttribute("title", expect.stringContaining("Save as…"));
  });

  // Owner review, 2026-09-22 (b): every row wears a location chip beside
  // its state badge, so a Save As reads `active · project dir` and the
  // owner's "it's picked it up" feedback has somewhere to land beyond the
  // Save as… tooltip.
  it("wears a project dir chip when the location is not auto-located, with no tooltip", async () => {
    rows = [row({ root: "/work/rig", auto_located: false })];
    await renderList();

    const chip = screen.getByText("project dir");
    expect(chip).not.toHaveAttribute("title");
  });

  // The state badge no longer repeats what the chip now says: a
  // not-currently-active auto-located row used to read
  // "auto-located · auto-located".
  it("doesn't repeat the location on the state badge", async () => {
    rows = [row({ root: "/cache/projects/bbb", state: "auto-located", auto_located: true })];
    await renderList();

    expect(screen.getAllByText("auto-located")).toHaveLength(1);
    expect(screen.getByText("known")).toBeInTheDocument();
  });

  // Owner review, 2026-09-22 (c): the header's Clear all no longer wears
  // the red-on-gray danger styling; it reads as a normal button.
  it("doesn't style Clear all data caches as dangerous", async () => {
    rows = [row({ root: "/a" })];
    await renderList();

    expect(screen.getByRole("button", { name: "Clear all data caches" })).not.toHaveClass(
      "danger",
    );
  });

  // Owner ruling 2026-09-21: Delete is the shared two-stage trash
  // control, since removing a cache directory has no way back.
  it("arms Delete on the first click and only acts on the second", async () => {
    rows = [row({ root: "/work/armed" })];
    await renderList();

    const del = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(del);
    expect(calls).toHaveLength(0);
    expect(screen.getByRole("button", { name: "click again to confirm" })).toBeInTheDocument();

    fireEvent.click(del);
    await waitFor(() => expect(calls).toEqual([{ cmd: "delete_project_cache", root: "/work/armed" }]));
  });

  it("says so when nothing is recorded", async () => {
    rows = [];
    render(<ProjectCachesList />);
    await waitFor(() =>
      expect(screen.getByText("No project caches recorded.")).toBeInTheDocument(),
    );
  });
});

// Observation 4 of the owner's 2026-09-21 report: a Save As over the
// folder the project was opened from produced no change in the settings
// view. The list reloaded on the open project's *file* path, and that
// Save As leaves the path string exactly as it was — while the session
// moves out of its auto-located directory (ADR 0042 §2) and into the
// user's folder. The host announces the move; this is the list following
// it.
describe("the project cache list following the session's root", () => {
  it("reloads on a re-root that leaves the project file path unchanged", async () => {
    rows = [
      row({
        root: "/cache/projects/aaa",
        project_file: "/work/rig/rig.cannet_prj",
        state: "active",
        auto_located: true,
        bytes: 2 * 1024 * 1024 * 1024,
      }),
    ];
    await renderList();
    expect(screen.getByText("/cache/projects/aaa")).toBeInTheDocument();

    // Save As onto that same `.cannet_prj`: the folder now holds a
    // `.cannet/`, so it is a project directory of its own, and the
    // directory left behind keeps its reclaimable bytes.
    rows = [
      row({
        root: "/work/rig",
        project_file: "/work/rig/rig.cannet_prj",
        state: "active",
        bytes: 2 * 1024 * 1024 * 1024,
      }),
      row({
        root: "/cache/projects/aaa",
        state: "auto-located",
        auto_located: true,
        bytes: 700 * 1024 * 1024,
      }),
    ];
    act(() => emitHostEvent("project-dir-changed", { root: "/work/rig", auto_located: false }));

    expect(await screen.findByText("/work/rig")).toBeInTheDocument();
    expect(screen.getByText("/cache/projects/aaa")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("auto-located")).toBeInTheDocument();
    expect(screen.getByText("700 MB")).toBeInTheDocument();
  });

  // Sizes are asked for, never polled (ADR 0002 DS-8), so returning to
  // the settings view is one of the moments they are asked for. The view
  // publishes how many times it has been shown; this list is reached only
  // through the custom-renderer table, so that count is how it hears.
  it("re-measures when the settings view comes back into view", async () => {
    rows = [row({ root: "/work/rig", bytes: 1024 * 1024 })];
    const { rerender } = render(
      <SettingsShownContext.Provider value={1}>
        <ProjectCachesList />
      </SettingsShownContext.Provider>,
    );
    expect(await screen.findByText("1.0 MB")).toBeInTheDocument();

    // A rebuild while another panel was on screen grew the cache.
    rows = [row({ root: "/work/rig", bytes: 64 * 1024 * 1024 })];
    rerender(
      <SettingsShownContext.Provider value={2}>
        <ProjectCachesList />
      </SettingsShownContext.Provider>,
    );

    expect(await screen.findByText("64.0 MB")).toBeInTheDocument();
  });

  // The settings view's own `.settings-list` already restores its
  // scroll offset across a hide and show (dockview detaches a hidden
  // panel's element, and a detached box keeps no scroll offset). This
  // row space had no equivalent and reopened at the top;
  // `useScrollRestore` fixes both from one shared mechanism.
  it("puts the row space's own scroll offset back when the settings view comes back into view", async () => {
    rows = [row({ root: "/a" }), row({ root: "/b" }), row({ root: "/c" })];
    const { rerender } = render(
      <SettingsShownContext.Provider value={1}>
        <ProjectCachesList />
      </SettingsShownContext.Provider>,
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(3));
    const grid = document.querySelector(".project-caches-grid") as HTMLElement;

    grid.scrollTop = 40;
    fireEvent.scroll(grid);

    // dockview removes the hidden panel's element from the document; a
    // reattached box has no scroll offset of its own until something
    // puts it back. Simulated here since jsdom does not detach anything
    // on its own between renders.
    grid.scrollTop = 0;

    rerender(
      <SettingsShownContext.Provider value={2}>
        <ProjectCachesList />
      </SettingsShownContext.Provider>,
    );

    expect(grid.scrollTop).toBe(40);
  });
});

describe("the gridview", () => {
  // The list is a gridview (ADR 0044) of flat leaf rows, one per
  // project directory — no branches, so the row cursor is a plain walk.
  it("walks the rows with the row cursor", async () => {
    rows = [row({ root: "/a" }), row({ root: "/b" }), row({ root: "/c" })];
    await renderList();
    const container = document.querySelector(".project-caches-grid") as HTMLElement;
    const cursorId = () => container.getAttribute("aria-activedescendant");

    fireEvent.keyDown(container, { key: "ArrowDown" });
    const first = screen.getByText("/a").closest(".project-cache-row") as HTMLElement;
    expect(cursorId()).toBe(first.id);

    fireEvent.keyDown(container, { key: "ArrowDown" });
    const second = screen.getByText("/b").closest(".project-cache-row") as HTMLElement;
    expect(cursorId()).toBe(second.id);

    fireEvent.keyDown(container, { key: "ArrowUp" });
    expect(cursorId()).toBe(first.id);
  });
});
