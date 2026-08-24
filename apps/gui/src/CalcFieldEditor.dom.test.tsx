// @vitest-environment jsdom
//
// Component tests for the shared calculated-fields editor (ADR 0027).
// The editor sits over two layers — the DBC's `CannetCounter` /
// `CannetCrc` designations and the project's per-message override —
// and every case here fixes what the controls come up with for a
// given pair of layers, and what Apply hands back.
//
// The layers are the discriminator throughout: a DBC-declared field
// beside a file-overridden one on the same message, so "the DBC one
// is missing" reads as a difference between two sections rather than
// as an empty dialog.

import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ["CRC-8/SAE-J1850", "CRC-8/AUTOSAR"]),
}));

import { CalcFieldEditor } from "./CalcFieldEditor";
import type { CalcFieldsSpec } from "./types";

afterEach(cleanup);

/// The DBC layer: a counter on `AliveCtr` and a CRC on `Crc8`.
const DBC_DEFAULTS: CalcFieldsSpec = {
  counter: { signal: "AliveCtr", increment: 1, rollover: 15 },
  crc: { signal: "Crc8", algorithm: "CRC-8/SAE-J1850", range_bits: [0, 56] },
};

/// The override layer: the counter moved to `Ctr2`, stepping by 3.
const COUNTER_OVERRIDE: CalcFieldsSpec = {
  counter: { signal: "Ctr2", increment: 3, rollover: null },
  crc: null,
};

function open(
  dbcDefaults: CalcFieldsSpec | null,
  current: CalcFieldsSpec | null,
  onSave: (spec: CalcFieldsSpec | null) => void = () => {},
  preset: { role: "counter" | "crc"; signal: string } | null = null,
) {
  render(
    <CalcFieldEditor
      messageLabel="Status"
      signalNames={["Mode", "AliveCtr", "Ctr2", "Crc8"]}
      dbcDefaults={dbcDefaults}
      current={current}
      preset={preset}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
}

const counterBox = () => screen.getByLabelText("counter configured") as HTMLInputElement;
const crcBox = () => screen.getByLabelText("crc configured") as HTMLInputElement;

describe("CalcFieldEditor over its two layers", () => {
  it("comes up populated from the DBC when the project overrides nothing", () => {
    open(DBC_DEFAULTS, null);
    expect(counterBox().checked).toBe(true);
    expect(crcBox().checked).toBe(true);
    expect((screen.getByLabelText("counter signal") as HTMLInputElement).value).toBe("AliveCtr");
    expect((screen.getByLabelText("counter increment") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("counter rollover") as HTMLInputElement).value).toBe("15");
    expect((screen.getByLabelText("crc signal") as HTMLInputElement).value).toBe("Crc8");
    expect((screen.getByLabelText("crc algorithm") as HTMLInputElement).value).toBe(
      "CRC-8/SAE-J1850",
    );
    expect((screen.getByLabelText("crc range length") as HTMLInputElement).value).toBe("56");
  });

  it("shows a message's overridden counter beside its DBC-declared CRC", () => {
    // The per-field discrimination: one message, one field from each
    // layer. Both sections are populated, and each says which layer
    // it came from in the vocabulary the RBS signals grid uses.
    open(DBC_DEFAULTS, COUNTER_OVERRIDE);
    expect((screen.getByLabelText("counter signal") as HTMLInputElement).value).toBe("Ctr2");
    expect((screen.getByLabelText("counter increment") as HTMLInputElement).value).toBe("3");
    expect(crcBox().checked).toBe(true);
    expect((screen.getByLabelText("crc signal") as HTMLInputElement).value).toBe("Crc8");

    const badges = screen.getAllByTestId("calc-provenance").map((n) => n.textContent);
    expect(badges).toEqual(["Override", "Default"]);
  });

  it("leaves an untouched DBC default as a default rather than copying it into an override", () => {
    const saved: Array<CalcFieldsSpec | null> = [];
    open(DBC_DEFAULTS, null, (s) => saved.push(s));
    fireEvent.click(screen.getByText("Apply"));
    expect(saved).toEqual([null]);
  });

  it("makes an edited DBC default an override of that field alone", () => {
    const saved: Array<CalcFieldsSpec | null> = [];
    open(DBC_DEFAULTS, null, (s) => saved.push(s));
    fireEvent.change(screen.getByLabelText("counter increment"), { target: { value: "2" } });
    fireEvent.click(screen.getByText("Apply"));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.counter).toMatchObject({ signal: "AliveCtr", increment: 2, rollover: 15 });
    // The CRC was not touched, so it keeps tracking the DBC.
    expect(saved[0]?.crc).toBeNull();
  });

  it("keeps an existing override when the editor is applied untouched", () => {
    const saved: Array<CalcFieldsSpec | null> = [];
    open(DBC_DEFAULTS, COUNTER_OVERRIDE, (s) => saved.push(s));
    fireEvent.click(screen.getByText("Apply"));
    expect(saved[0]?.counter).toMatchObject({ signal: "Ctr2", increment: 3 });
    expect(saved[0]?.crc).toBeNull();
  });

  it("clearing a section drops that field's override so the DBC default returns", () => {
    const saved: Array<CalcFieldsSpec | null> = [];
    open(DBC_DEFAULTS, COUNTER_OVERRIDE, (s) => saved.push(s));
    fireEvent.click(counterBox());
    fireEvent.click(screen.getByText("Apply"));
    expect(saved).toEqual([null]);
  });

  it("\"configure as …\" overrides a DBC-declared field it moves", () => {
    // Opening on a destination the user picked is an authoring act,
    // even where the DBC already designates the field elsewhere — the
    // pick must not be swallowed as "still tracking the default".
    const saved: Array<CalcFieldsSpec | null> = [];
    open(DBC_DEFAULTS, null, (s) => saved.push(s), { role: "counter", signal: "Ctr2" });
    expect((screen.getByLabelText("counter signal") as HTMLInputElement).value).toBe("Ctr2");
    expect(screen.getAllByTestId("calc-provenance").map((n) => n.textContent)).toEqual([
      "Override",
      "Default",
    ]);
    fireEvent.click(screen.getByText("Apply"));
    expect(saved[0]?.counter).toMatchObject({ signal: "Ctr2" });
    expect(saved[0]?.crc).toBeNull();
  });

  it("a message with neither layer opens empty and authors a plain override", () => {
    const saved: Array<CalcFieldsSpec | null> = [];
    open(null, null, (s) => saved.push(s));
    expect(counterBox().checked).toBe(false);
    expect(crcBox().checked).toBe(false);
    expect(screen.queryAllByTestId("calc-provenance")).toHaveLength(0);
    fireEvent.click(counterBox());
    fireEvent.click(screen.getByText("Apply"));
    expect(saved[0]?.counter).toMatchObject({ signal: "Mode", increment: 1 });
  });
});
