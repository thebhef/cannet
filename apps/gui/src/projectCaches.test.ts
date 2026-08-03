import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  badgeLabel,
  cacheSummary,
  canClear,
  canDelete,
  canSaveAs,
  loadProjectCaches,
  offersSaveAs,
  type ProjectCacheRow,
} from "./projectCaches";

function row(patch: Partial<ProjectCacheRow> = {}): ProjectCacheRow {
  return {
    root: "/work/ev-zonal",
    cache: "/cache/abc",
    project_file: "/work/ev-zonal/ev.cannet_prj",
    bytes: 1024,
    state: "known",
    auto_located: false,
    last_used_seconds: 1_700,
    ...patch,
  };
}

describe("project cache rows", () => {
  it("names each badge", () => {
    expect(badgeLabel("active")).toBe("active");
    expect(badgeLabel("missing")).toBe("project gone");
    expect(badgeLabel("auto-located")).toBe("auto-located");
    expect(badgeLabel("known")).toBe("known");
  });

  // ADR 0042 §5: Delete is unavailable for the open project, whose store
  // is mapped. Clear is offered wherever there is something to empty —
  // and means the same thing on every row.
  it("offers Clear wherever there is something to empty, and never Delete on the open project", () => {
    expect(canClear(row({ bytes: 512 }))).toBe(true);
    expect(canClear(row({ bytes: 0 }))).toBe(false);
    expect(canDelete(row())).toBe(true);
    expect(canDelete(row({ state: "active" }))).toBe(false);
    expect(canDelete(row({ state: "missing" }))).toBe(true);
  });

  // The offer belongs on the rows living in cache space, since this list
  // is the one place a user sees that theirs does — but Save As moves the
  // *session's* project, so only the open one can take it.
  it("offers Save as… on auto-located rows and enables it only for the open project", () => {
    expect(offersSaveAs(row({ auto_located: true }))).toBe(true);
    expect(offersSaveAs(row({ auto_located: false, state: "active" }))).toBe(false);
    expect(canSaveAs(row({ auto_located: true, state: "active" }))).toBe(true);
    expect(canSaveAs(row({ auto_located: true, state: "auto-located" }))).toBe(false);
  });

  it("summarises the list as a count and a total", () => {
    expect(cacheSummary([])).toBe("0 projects · 0 B cached");
    expect(cacheSummary([row({ bytes: 1024 })])).toBe("1 project · 1.0 KB cached");
    expect(
      cacheSummary([row({ bytes: 1024 }), row({ root: "/b", bytes: 3 * 1024 })]),
    ).toBe("2 projects · 4.0 KB cached");
  });

  // A stale registry, an unreadable config dir, no host at all: the list
  // comes back empty rather than throwing, because a project directory
  // deleted outside the app must never stop the panel opening.
  it("reads as an empty list when the host cannot answer", async () => {
    invoke.mockRejectedValueOnce(new Error("no host"));
    expect(await loadProjectCaches()).toEqual([]);
    invoke.mockResolvedValueOnce(null);
    expect(await loadProjectCaches()).toEqual([]);
  });
});
