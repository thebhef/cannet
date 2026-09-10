// @vitest-environment jsdom
//
// DOM tests for the settings view's units section: one row per unit with
// the strings that read as it, the per-row add path, and the two scope
// checkboxes that decide where a row's own mappings persist.
//
// Which row a string lands on is the host's answer (`list_unit_mappings`
// over `units::recognize`) — the mock below is that host, so the section
// is exercised as a thin view over it and re-derives no recognition of
// its own.

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/// The two dicts, as the host holds them.
let PROJECT: Record<string, string> = {};
let USER: Record<string, string> = {};

/// A stand-in for `units::mappings`: every base unit of this abridged
/// table, carrying the strings that reach it — the built-ins, then each
/// scope, with the **project winning** where both map one string.
const BASES = [
  { unit: { base: "volt" }, id: "volt", display: "V", dimensionLabel: "voltage" },
  {
    unit: { base: "degree-celsius" },
    id: "degree-celsius",
    display: "°C",
    dimensionLabel: "temperature",
  },
  { unit: { base: "ampere" }, id: "ampere", display: "A", dimensionLabel: "current" },
];
const BUILT_IN: Record<string, string> = { V: "volt", degC: "degree-celsius", A: "ampere" };
function mappings() {
  const spellings = new Map<string, { id: string; source: string }>();
  for (const [spelling, id] of Object.entries(BUILT_IN)) {
    spellings.set(spelling, { id, source: "builtIn" });
  }
  for (const [spelling, id] of Object.entries(USER)) {
    spellings.set(spelling, { id, source: "user" });
  }
  for (const [spelling, id] of Object.entries(PROJECT)) {
    spellings.set(spelling, { id, source: "project" });
  }
  return BASES.map((b) => ({
    ...b,
    mappings: [...spellings.entries()]
      .filter(([, v]) => v.id === b.id)
      .map(([spelling, v]) => ({ spelling, source: v.source })),
  }));
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "list_unit_mappings") return mappings();
    if (cmd === "get_settings") {
      return { unit_customizations: PROJECT, unit_customizations_user: USER };
    }
    if (cmd === "set_settings") {
      const sent = args?.settings as {
        unit_customizations: Record<string, string>;
        unit_customizations_user: Record<string, string>;
      };
      PROJECT = sent.unit_customizations;
      USER = sent.unit_customizations_user;
      return sent;
    }
    return undefined;
  }),
}));

import { UnitCustomizations } from "./UnitCustomizations";
import { hydrateSettings, updateSettings, type Settings } from "./hostSettings";
import type { SettingDescriptor } from "./settingDescriptors";

const descriptor = { key: "unit_customizations" } as unknown as SettingDescriptor;

/// Mounts the section the way the settings panel does: the descriptor's
/// own key as `value`, and a commit that writes it back — the panel's
/// own `commit` calls `updateSettings`, so the mock host sees it.
function show(onCommit = vi.fn()) {
  render(<UnitCustomizations descriptor={descriptor} value={PROJECT} onCommit={onCommit} />);
  return onCommit;
}

/// The section under the settings panel's **real** commit: the panel
/// sets the descriptor's value optimistically *and* starts the
/// `updateSettings` round-trip, which only reaches the host a couple of
/// awaits later. Nothing here is a stub — this is `SettingsPanel`'s own
/// `commit`, so the table is exercised against the ordering it actually
/// races.
function ThroughThePanel() {
  const [value, setValue] = useState<Record<string, string>>(PROJECT);
  return (
    <UnitCustomizations
      descriptor={descriptor}
      value={value}
      onCommit={(next) => {
        setValue(next as Record<string, string>);
        void updateSettings({ unit_customizations: next } as Partial<Settings>);
      }}
    />
  );
}

const rowFor = (unit: string) =>
  screen.getByText(unit, { selector: ".unit-customization-unit" }).closest("tr") as HTMLElement;

beforeEach(async () => {
  PROJECT = {};
  USER = {};
  await hydrateSettings();
});
afterEach(cleanup);

describe("the units section", () => {
  it("lists every base unit the library carries, with its dimension", async () => {
    show();
    await waitFor(() => expect(rowFor("V")).toBeInTheDocument());
    expect(rowFor("°C")).toBeInTheDocument();
    expect(rowFor("A")).toBeInTheDocument();
    expect(within(rowFor("°C")).getByText("temperature")).toBeInTheDocument();
  });

  it("puts each string on the row the host recognises it to", async () => {
    PROJECT = { "Deg C": "degree-celsius" };
    show();
    await waitFor(() => expect(rowFor("°C")).toBeInTheDocument());
    const celsius = within(rowFor("°C"));
    expect(celsius.getByText("degC")).toBeInTheDocument();
    expect(celsius.getByText("Deg C")).toBeInTheDocument();
    // A built-in recognition is not the user's to move between scopes,
    // so it carries no remove control.
    expect(celsius.queryByLabelText("Remove the mapping for degC")).toBeNull();
    expect(celsius.getByLabelText("Remove the mapping for Deg C")).toBeInTheDocument();
  });

  it("assigns a string to a row by typing it there", async () => {
    const onCommit = show();
    await waitFor(() => expect(rowFor("A")).toBeInTheDocument());
    const box = within(rowFor("A")).getByLabelText("Map a unit string to A");
    fireEvent.change(box, { target: { value: "  Amps  " } });
    fireEvent.keyDown(box, { key: "Enter" });
    // Trimmed — a database's padding is not part of what was typed.
    expect(onCommit).toHaveBeenCalledWith({ Amps: "ampere" });
  });

  /// The table is the host's answer, and the host answers out of its own
  /// settings cache — so a re-ask is only worth anything once the write
  /// has landed there. Asking on the commit's *optimistic* value asks a
  /// question the host cannot yet answer, and the value never changes
  /// again, so the row stays as it was until the panel is reopened.
  it("shows a spelling the moment it is added and again when it is removed", async () => {
    render(<ThroughThePanel />);
    await waitFor(() => expect(rowFor("A")).toBeInTheDocument());

    const box = within(rowFor("A")).getByLabelText("Map a unit string to A");
    fireEvent.change(box, { target: { value: "Amps" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(within(rowFor("A")).getByText("Amps")).toBeInTheDocument(),
    );

    fireEvent.click(within(rowFor("A")).getByLabelText("Remove the mapping for Amps"));
    await waitFor(() => expect(within(rowFor("A")).queryByText("Amps")).toBeNull());
  });

  it("removes a mapping without touching the others", async () => {
    PROJECT = { Amps: "ampere", Volts: "volt" };
    const onCommit = show();
    await waitFor(() => expect(rowFor("A")).toBeInTheDocument());
    fireEvent.click(
      within(rowFor("A")).getByLabelText("Remove the mapping for Amps"),
    );
    expect(onCommit).toHaveBeenCalledWith({ Volts: "volt" });
  });
});

describe("the per-row scope checkboxes", () => {
  it("are ticked where the row's mappings actually persist, and dead where nothing does", async () => {
    PROJECT = { Amps: "ampere" };
    show();
    await waitFor(() => expect(rowFor("A")).toBeInTheDocument());
    const amps = within(rowFor("A"));
    expect(amps.getByLabelText("Keep A mappings in this project")).toBeChecked();
    expect(amps.getByLabelText("Keep A mappings in every project")).not.toBeChecked();
    // A row whose only match is built in has nothing to promote.
    const volts = within(rowFor("V"));
    expect(volts.getByLabelText("Keep V mappings in this project")).toBeDisabled();
  });

  /// Ticking user promotes the row's mappings to every project. It is a
  /// copy, not a move: the project's own reading stays in force, and the
  /// host's join settles a string both scopes hold.
  it("promotes a row's mappings to user scope", async () => {
    PROJECT = { Amps: "ampere" };
    show();
    await waitFor(() => expect(rowFor("A")).toBeInTheDocument());
    fireEvent.click(within(rowFor("A")).getByLabelText("Keep A mappings in every project"));
    await waitFor(() => expect(USER).toEqual({ Amps: "ampere" }));
    expect(PROJECT).toEqual({ Amps: "ampere" });
  });

  it("demotes a row's mappings out of this project", async () => {
    PROJECT = { Amps: "ampere" };
    USER = { Amps: "ampere" };
    const onCommit = show();
    await waitFor(() => expect(rowFor("A")).toBeInTheDocument());
    fireEvent.click(within(rowFor("A")).getByLabelText("Keep A mappings in this project"));
    expect(onCommit).toHaveBeenCalledWith({});
  });

  /// Where both scopes map one string the host answers the project's
  /// reading, so the row shows it once — as the project's.
  it("shows a string both scopes map once, as the project's", async () => {
    PROJECT = { "Deg C": "degree-celsius" };
    USER = { "Deg C": "volt" };
    show();
    await waitFor(() => expect(rowFor("°C")).toBeInTheDocument());
    expect(within(rowFor("°C")).getByText("Deg C")).toBeInTheDocument();
    expect(within(rowFor("V")).queryByText("Deg C")).toBeNull();
  });
});

describe("filtering", () => {
  it("narrows the table by unit, dimension or matched string", async () => {
    show();
    await waitFor(() => expect(rowFor("V")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Filter units"), {
      target: { value: "temperature" },
    });
    expect(rowFor("°C")).toBeInTheDocument();
    expect(screen.queryByText("V", { selector: ".unit-customization-unit" })).toBeNull();
  });
});
