// @vitest-environment jsdom
//
// The units section at the library's real size: 2289 rows over 109
// dimensions. Two things only show up at that scale — that the rows
// scroll in a row space of their own rather than in the settings
// view's list (ADR 0044), and that the section opens collapsed apart
// from the dimensions this project has an interest in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import css from "./index.css?raw";

/// The declarations of the first top-level rule for `selector` — the
/// `index.css?raw` idiom `DisclosureToggle.dom.test.tsx` establishes,
/// since jsdom does no layout and there is no rendered box to measure.
function declarations(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `no \`${selector}\` rule in index.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

const DIMENSIONS = 109;
const ROWS = 2289;

/// One row per unit, in the host's own order — dimension label first,
/// so the table is dimension-contiguous the way `list_unit_mappings`
/// serves it.
const ALL = Array.from({ length: ROWS }, (_, i) => ({
  unit: { base: `base-${i}`, prefix: null },
  id: `base-${i}`,
  display: `u${i}`,
  dimensionLabel: `dimension ${String(i % DIMENSIONS).padStart(3, "0")}`,
  mappings: [] as { spelling: string; source: string }[],
  composition: null,
  definitionScope: null,
  error: null,
})).sort((a, b) => a.dimensionLabel.localeCompare(b.dimensionLabel));

/// The project maps one string, to a unit of `dimension 007`.
const MAPPED = ALL.find((r) => r.dimensionLabel === "dimension 007")!;
let PROJECT: Record<string, string> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "list_unit_mappings") {
      return ALL.map((r) =>
        r.id === MAPPED.id && Object.keys(PROJECT).length > 0
          ? { ...r, mappings: [{ spelling: "Flurbles", source: "project" }] }
          : r,
      );
    }
    if (cmd === "get_settings") {
      return {
        unit_customizations: PROJECT,
        unit_customizations_user: {},
        unit_definitions: {},
        unit_definitions_user: {},
      };
    }
    return undefined;
  }),
}));

import { UnitCustomizations } from "./UnitCustomizations";
import { hydrateSettings } from "./hostSettings";
import type { SettingDescriptor } from "./settingDescriptors";

const descriptor = { key: "unit_customizations" } as unknown as SettingDescriptor;

/// Mounted the way the settings view mounts it: inside the view's own
/// scrolling list.
function show() {
  render(
    <div className="settings-list">
      <UnitCustomizations descriptor={descriptor} value={PROJECT} onCommit={vi.fn()} />
    </div>,
  );
}

const unitRows = () => document.querySelectorAll(".unit-customization-row");
const branchRows = () => document.querySelectorAll(".unit-customization-dimension-row");

beforeEach(async () => {
  PROJECT = { Flurbles: MAPPED.id };
  await hydrateSettings();
});
afterEach(cleanup);

describe("the units section at library scale", () => {
  it("scrolls its rows in a bounded row space of its own, inside the settings list", async () => {
    show();
    await waitFor(() => expect(branchRows().length).toBe(DIMENSIONS));

    const space = document.querySelector(".unit-customizations-grid");
    expect(space).not.toBeNull();
    // Inside the settings view's list, not instead of it.
    expect(document.querySelector(".settings-list")!.contains(space!)).toBe(true);
    // Every row — branch and leaf alike — is inside that space, so the
    // settings list's own scrolled content does not grow with them.
    for (const row of [...branchRows(), ...unitRows()]) {
      expect(space!.contains(row)).toBe(true);
    }
    // And the space is what scrolls: its own bound, its own scrollbar.
    const rule = declarations(".unit-customizations-grid");
    expect(rule).toMatch(/\boverflow-y:\s*auto\b/);
    expect(rule).toMatch(/\bmax-height:\s*\d/);
  });

  it("opens with every dimension collapsed but the one this project maps a unit in", async () => {
    show();
    await waitFor(() => expect(branchRows().length).toBe(DIMENSIONS));
    // The branch rows land on the commit that lists the dimensions; the
    // seeded branch's unit rows land on a later commit, once the
    // `seeded` effect has set the expanded set and React has
    // re-rendered. Wait for that commit before reading the open set —
    // otherwise a poll can catch the branch rows with the unit rows
    // still pending.
    const mappedCount = ALL.filter((r) => r.dimensionLabel === "dimension 007").length;
    await waitFor(() => expect(unitRows().length).toBe(mappedCount));
    // One branch open, so the row space holds its units and no others
    // — not the whole 2289-row library.
    const open = [...branchRows()].filter((b) => b.getAttribute("aria-expanded") === "true");
    expect(open.map((b) => b.textContent)).toHaveLength(1);
    expect(open[0].textContent).toContain("dimension 007");
    expect(unitRows().length).toBeLessThan(ROWS);
  });

  it("expands what the filter matches, and collapses back when it is cleared", async () => {
    show();
    await waitFor(() => expect(branchRows().length).toBe(DIMENSIONS));
    // Same asynchronous seeding as above — wait for the seeded branch's
    // unit rows to land before treating their count as settled.
    const mappedCount = ALL.filter((r) => r.dimensionLabel === "dimension 007").length;
    await waitFor(() => expect(unitRows().length).toBe(mappedCount));
    const opened = unitRows().length;

    const box = screen.getByLabelText("Filter units");
    fireEvent.change(box, { target: { value: "dimension 042" } });
    expect(branchRows().length).toBe(1);
    expect(unitRows().length).toBe(
      ALL.filter((r) => r.dimensionLabel === "dimension 042").length,
    );

    fireEvent.change(box, { target: { value: "" } });
    expect(branchRows().length).toBe(DIMENSIONS);
    expect(unitRows().length).toBe(opened);
  });
});
