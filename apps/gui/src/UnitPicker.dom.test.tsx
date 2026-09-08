// @vitest-environment jsdom
//
// DOM tests for the base × prefix unit picker: two columns, the whole
// exponent-ordered ladder in the second, kind-locking in the first, and
// the composition row the math editor offers beside the library.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const scale = (base: string, prefix: string | undefined, label: string, display: string, exponent: number) => ({
  unit: prefix === undefined ? { base } : { base, prefix },
  label,
  display,
  exponent,
});

/// The picker model, as `list_unit_picker` serves it — abridged to three
/// ladder rungs so a test can name every row.
const PICKER = [
  {
    id: "volt",
    display: "V",
    dimension: "voltage",
    dimensionLabel: "voltage",
    scales: [
      scale("volt", "milli", "m", "mV", -3),
      scale("volt", undefined, "", "V", 0),
      scale("volt", "kilo", "k", "kV", 3),
    ],
  },
  {
    id: "ampere",
    display: "A",
    dimension: "current",
    dimensionLabel: "current",
    scales: [scale("ampere", "milli", "m", "mA", -3), scale("ampere", undefined, "", "A", 0)],
  },
  {
    id: "ampere-hour",
    display: "Ah",
    dimension: "charge",
    dimensionLabel: "charge",
    scales: [
      scale("ampere-hour", "nano", "n", "nAh", -9),
      scale("ampere-hour", undefined, "", "Ah", 0),
    ],
  },
];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === "list_unit_picker" ? PICKER : cmd === "list_units" ? [] : undefined,
  ),
}));

import { UnitPicker } from "./UnitPicker";
import { hydrateUnits } from "./unitLibrary";
import type { UnitId } from "./types";

beforeAll(async () => {
  await hydrateUnits();
});
afterEach(cleanup);

function open(props: Partial<React.ComponentProps<typeof UnitPicker>> = {}) {
  const onPick = vi.fn<(unit: UnitId | null) => void>();
  render(
    <UnitPicker
      at={{ x: 0, y: 0 }}
      value={null}
      kind={null}
      ariaLabel="units"
      onPick={onPick}
      onClose={vi.fn()}
      {...props}
    />,
  );
  return onPick;
}

const bases = () => screen.getByRole("listbox", { name: "unit" });
const scales = () => screen.getByRole("listbox", { name: "scale" });

describe("UnitPicker", () => {
  it("offers every unit when no kind is named — reinterpretation crosses kinds", () => {
    open({ value: { base: "volt" } });
    const options = within(bases()).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Vvolt",
      "Aampere",
      "Ahampere-hour",
    ]);
  });

  it("offers only the locked kind where a unit is applied", () => {
    open({ kind: "current", value: { base: "ampere" } });
    expect(within(bases()).getAllByRole("option")).toHaveLength(1);
  });

  it("carries the exponent-ordered ladder with each rung's factor and spelling", () => {
    open({ value: { base: "volt" } });
    const rungs = within(scales()).getAllByRole("option");
    expect(rungs.map((r) => r.textContent)).toEqual(["m×10⁻³mV", "—×1V", "k×10³kV"]);
    // The current rung is what the picker opens on.
    expect(rungs[1]).toHaveAttribute("aria-selected", "true");
  });

  it("commits the whole unit identity when a rung is picked", () => {
    const onPick = open({ value: { base: "volt" } });
    fireEvent.click(within(scales()).getAllByRole("option")[0]);
    expect(onPick).toHaveBeenCalledWith({ base: "volt", prefix: "milli" });
  });

  /// The prefix survives a base change, so `mV` → `mA` is one click.
  it("keeps the prefix when the base changes and it offers one", () => {
    const onPick = open({ value: { base: "volt", prefix: "milli" } });
    fireEvent.click(within(bases()).getByText("ampere"));
    expect(onPick).toHaveBeenCalledWith({ base: "ampere", prefix: "milli" });
  });

  /// The math editor's extra row: a composition no unit names. Picking
  /// it commits nothing, which is what "derive it" is.
  it("offers a composition nothing names, and picking it commits nothing", () => {
    const onPick = open({
      kind: "current",
      value: null,
      composition: { label: "Ah/s", unit: null },
    });
    const options = within(bases()).getAllByRole("option");
    expect(options[0]).toHaveTextContent("Ah/s");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.click(options[0]);
    expect(onPick).toHaveBeenCalledWith(null);
  });

  /// A composition the table *does* name is already a row of its
  /// dimension — one row, not two.
  it("adds no row for a composition its dimension already lists", () => {
    open({
      kind: "charge",
      value: { base: "ampere-hour" },
      composition: { label: "Ah", unit: { base: "ampere-hour" } },
    });
    expect(within(bases()).getAllByRole("option")).toHaveLength(1);
    expect(within(scales()).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "n×10⁻⁹nAh",
      "—×1Ah",
    ]);
  });
});
