// @vitest-environment jsdom
//
// The application toolbar, after the chip sweep. A sweep across twenty
// controls is exactly where one gets quietly dropped, or re-labelled
// onto the wrong command — and counting chips would catch neither. So
// the bar is pinned against a literal table written out here: the order
// the chips sit in, the words each one shows, the sentence its tooltip
// says, and **the command each one actually dispatches when pressed**.
// The table is deliberately a copy rather than an import: a pin that
// reads the same list the component renders from pins nothing.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { Toolbar } from "./Toolbar";

afterEach(cleanup);

/// `[tooltip, label, command]`, left to right. A `null` label is the
/// icon-only form; a `null` command is a chip that opens a menu rather
/// than running something.
const BAR: readonly [string, string | null, string | null][] = [
  ["New project", "New", "project.new"],
  ["Open project…", "Open", "project.open"],
  ["Recent projects", "Projects", null],
  ["Save project", "Save", "project.save"],
  ["More save actions", "▾", null],
  ["Import trace… (BLF / MDF)", "Import", "trace.import"],
  ["Recent captures", "Recent", null],
  ["Add DBC…", "DBC", "dbc.add"],
  ["Clear capture", "Clear", "capture.clear"],
  ["Save capture…", "Capture", "capture.save"],
  ["Add a panel", "Add\u00a0\u25be", null],
  ["Database panel", null, "panel.show.dbc"],
  ["Graph panel", null, "panel.show.projectGraph"],
  ["Events panel", null, "panel.show.events"],
  ["Project panel", null, "panel.show.project"],
];

/// The Add menu, top to bottom: `[label, command]`.
const ADD_MENU: readonly [string, string][] = [
  ["Trace", "panel.add.trace"],
  ["Plot Panel", "panel.add.plot"],
  ["Signal View", "panel.add.signals"],
  ["Transmit Panel", "panel.add.transmit"],
  ["RBS Panel", "panel.add.rbs"],
  ["Color Map", "panel.add.colormap"],
  ["Generator", "panel.add.generator"],
];

const RECENTS = ["C:/captures/drive-cycle-08.blf", "C:/captures/bench.mf4"];
const RECENT_PROJECTS = ["C:/jobs/pack.cannet_prj", "C:/jobs/rig.cannet_prj"];

function renderBar(over: Partial<Parameters<typeof Toolbar>[0]> = {}) {
  const onRun = vi.fn();
  const onOpenRecent = vi.fn();
  const onOpenRecentProject = vi.fn();
  render(
    <Toolbar
      onRun={onRun}
      captureEmpty={false}
      importing={false}
      recentCaptures={RECENTS}
      onOpenRecent={onOpenRecent}
      recentProjects={RECENT_PROJECTS}
      onOpenRecentProject={onOpenRecentProject}
      {...over}
    />,
  );
  return { onRun, onOpenRecent, onOpenRecentProject };
}

/// The chips sitting on the bar itself, left to right — not the ones
/// inside an open menu.
function barChips(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(".toolbar .chip-button"),
  ).filter((el) => el.closest(".chip-menu-list") === null);
}

function labelOf(chip: Element): string | null {
  return chip.querySelector(".status-chip-label")?.textContent ?? null;
}

describe("Toolbar", () => {
  it("puts every chip where the design puts it, with the words the design gives it", () => {
    renderBar();
    expect(barChips().map((c) => [c.getAttribute("title"), labelOf(c)])).toEqual(
      BAR.map(([title, label]) => [title, label]),
    );
  });

  it("dispatches its own command from every chip, and nothing else", () => {
    for (const [title, , command] of BAR) {
      if (command === null) continue;
      cleanup();
      const { onRun } = renderBar();
      const chip = barChips().find((c) => c.getAttribute("title") === title);
      expect(chip, `no chip titled "${title}"`).toBeDefined();
      fireEvent.click(chip!);
      expect(onRun.mock.calls).toEqual([[command]]);
    }
  });

  it("collapses the seven Add commands into one menu, in order", () => {
    const { onRun } = renderBar();
    const add = barChips().find((c) => c.getAttribute("title") === "Add a panel")!;
    expect(add).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".chip-menu-list")).toBeNull();

    fireEvent.click(add);
    expect(add).toHaveAttribute("aria-expanded", "true");
    const menuEntries = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".chip-menu-list .chip-button"));
    expect(menuEntries().map(labelOf)).toEqual(ADD_MENU.map(([label]) => label));

    // Each entry runs its own command and shuts the menu behind it.
    // The menu is re-opened each time, so the nodes are re-queried:
    // React has torn the previous ones down.
    ADD_MENU.forEach(([, command], i) => {
      if (document.querySelector(".chip-menu-list") === null) fireEvent.click(add);
      fireEvent.click(menuEntries()[i]);
      expect(onRun.mock.calls[onRun.mock.calls.length - 1]).toEqual([command]);
      expect(document.querySelector(".chip-menu-list")).toBeNull();
    });
  });

  it("carries no launcher for anything the status bar already reports", () => {
    // The rule this sweep must not quietly undo (ADR 0055): the
    // connection control and the three badged launchers report from the
    // bar below, and a second copy up here would report the same
    // condition from two places.
    const { onRun } = renderBar();
    for (const chip of barChips()) {
      const words = `${chip.getAttribute("title") ?? ""} ${chip.getAttribute("aria-label") ?? ""}`;
      expect(words).not.toMatch(/connect|system messages|signal mapping|rbs mapping|view signals/i);
      fireEvent.click(chip);
    }
    const dispatched = onRun.mock.calls.map(([id]) => id as string);
    for (const forbidden of [
      "connection.connect",
      "connection.disconnect",
      "panel.show.systemMessages",
      "panel.show.viewSignals",
      "panel.show.busHealth",
    ]) {
      expect(dispatched).not.toContain(forbidden);
    }
  });

  it("offers nothing to clear or save while nothing has been captured", () => {
    renderBar({ captureEmpty: true });
    const byTitle = (t: string) => barChips().find((c) => c.getAttribute("title") === t)!;
    expect(byTitle("Clear capture")).toBeDisabled();
    expect(byTitle("Save capture…")).toBeDisabled();
    // Everything that does not act on the capture stays available.
    expect(byTitle("Open project…")).not.toBeDisabled();
  });

  it("says on the import chip that the import it started is running", () => {
    renderBar({ importing: true });
    const chip = barChips().find((c) => c.getAttribute("aria-busy") === "true")!;
    expect(chip).toBeDefined();
    expect(labelOf(chip)).toBe("Import");
    expect(chip).toBeDisabled();
    // Stopping it is the status bar's Cancel, not a second meaning on
    // the launcher — so the tooltip has to say where that is.
    expect(chip.getAttribute("title")).toMatch(/Cancel in the status bar/);
  });

  it("lists the captures this project has opened, and re-opens the one picked", () => {
    const { onOpenRecent } = renderBar();
    const recent = barChips().find((c) => c.getAttribute("title") === "Recent captures")!;
    expect(recent).toHaveAttribute("aria-label", "Recent captures (2)");
    fireEvent.click(recent);
    const entries = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".recent-captures-menu .chip-button"),
    );
    expect(entries.map(labelOf)).toEqual(RECENTS);
    fireEvent.click(entries[1]);
    expect(onOpenRecent.mock.calls).toEqual([[RECENTS[1]]]);
  });

  it("leaves the Recent chip out entirely when this project has opened nothing", () => {
    renderBar({ recentCaptures: [] });
    expect(document.querySelector(".recent-captures")).toBeNull();
    expect(barChips()).toHaveLength(BAR.length - 1);
  });

  it("lists the projects opened lately, and re-opens the one picked", () => {
    const { onOpenRecentProject, onRun } = renderBar();
    const chip = barChips().find((c) => c.getAttribute("title") === "Recent projects")!;
    expect(chip).toHaveAttribute("aria-label", "Recent projects (2)");
    fireEvent.click(chip);
    const entries = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".recent-projects-menu .chip-button"),
    );
    expect(entries.map(labelOf)).toEqual(RECENT_PROJECTS);
    fireEvent.click(entries[1]);
    // The path is the argument, so it is not a command id — nothing is
    // dispatched through `onRun`.
    expect(onOpenRecentProject.mock.calls).toEqual([[RECENT_PROJECTS[1]]]);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("leaves the Projects chip out entirely when nothing has been opened yet", () => {
    renderBar({ recentProjects: [] });
    expect(document.querySelector(".recent-projects")).toBeNull();
    expect(barChips()).toHaveLength(BAR.length - 1);
  });

  it("saves when Save is pressed — the disclosure never swallows the press", () => {
    // The owner's rule for the split chip: "clicking on the save button
    // should just save". Pressing Save must dispatch `project.save` and
    // open nothing; only the caret beside it opens the menu.
    const { onRun } = renderBar();
    const save = barChips().find((c) => c.getAttribute("title") === "Save project")!;
    expect(save).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(save);
    expect(onRun.mock.calls).toEqual([["project.save"]]);
    expect(document.querySelector(".save-split-menu")).toBeNull();
  });

  it("offers Save As from the disclosure beside Save, and only from there", () => {
    const { onRun } = renderBar();
    const caret = barChips().find((c) => c.getAttribute("title") === "More save actions")!;
    expect(caret).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(caret);
    // Opening the menu runs nothing by itself.
    expect(onRun).not.toHaveBeenCalled();
    expect(caret).toHaveAttribute("aria-expanded", "true");
    const entries = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".save-split-menu .chip-button"),
    );
    expect(entries.map(labelOf)).toEqual(["Save As…"]);
    fireEvent.click(entries[0]);
    expect(onRun.mock.calls).toEqual([["project.saveAs"]]);
    expect(document.querySelector(".save-split-menu")).toBeNull();
  });

  it("draws Save and its disclosure inside one hairline", () => {
    // A split chip is one control, so it carries one outline (ADR
    // 0055's segment): two chips each drawing their own would read as
    // two unrelated commands.
    renderBar();
    const seg = document.querySelector(".toolbar .chip-seg.save-split")!;
    expect(seg).not.toBeNull();
    expect(seg.querySelectorAll(".chip-button")).toHaveLength(2);
  });
});
