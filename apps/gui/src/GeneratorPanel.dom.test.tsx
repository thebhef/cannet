// @vitest-environment jsdom
//
// Wiring test for the generator-rules editor (ADR 0026): the rule list
// edits back into the element, and every pattern is validated by the
// *host* — the frontend never compiles a user regex, so the inline
// error text can only come from `validate_signal_generator`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "validate_signal_generator") {
      // Stand-in for the host: only a parenthesised group is accepted.
      if (!String(args?.pattern).includes("(")) {
        throw "pattern has no capture group — parenthesise the number, e.g. Cell(\\d+)";
      }
      return null;
    }
    return null;
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { GeneratorPanel } from "./GeneratorPanel";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import { freshTrace } from "./trace";
import type { GeneratorRule, ProjectElement } from "./types";

function renderPanel(rules: GeneratorRule[]) {
  const element: ProjectElement = { kind: "generator", id: "g1", rules };
  const map = new Map<string, RegistryEntry>([["g1", { element, trace: freshTrace(0) }]]);
  const update = vi.fn();
  const registry = {
    get entries() {
      return [...map.values()];
    },
    get: (id: string) => map.get(id),
    create: () => "",
    ensure: () => {},
    updateTrace: () => {},
    update,
    remove: () => {},
  } as unknown as ElementRegistry;

  const props = { params: { elementId: "g1" } } as unknown as Parameters<typeof GeneratorPanel>[0];
  render(
    <ElementRegistryContext.Provider value={registry}>
      <GeneratorPanel {...props} />
    </ElementRegistryContext.Provider>,
  );
  return { update };
}

/// The `rules` array of the last `update` call that carried one.
function lastRules(update: ReturnType<typeof vi.fn>): GeneratorRule[] {
  const calls = update.mock.calls.filter((c) => Array.isArray(c[1]?.rules));
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1].rules as GeneratorRule[];
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("GeneratorPanel", () => {
  it("edits a rule's pattern back into the element", () => {
    const { update } = renderPanel([{ pattern: "Cell(\\d+)", enabled: true }]);

    const input = screen.getByLabelText("rule 1 pattern") as HTMLInputElement;
    expect(input.value).toBe("Cell(\\d+)");

    fireEvent.change(input, { target: { value: "Mod(\\d+)" } });
    expect(lastRules(update)).toEqual([{ pattern: "Mod(\\d+)", enabled: true }]);
  });

  it("asks the host to validate a pattern and shows its error inline", async () => {
    renderPanel([{ pattern: "Cell\\d+", enabled: true }]);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("validate_signal_generator", {
        pattern: "Cell\\d+",
      }),
    );
    await waitFor(() => expect(document.body.textContent).toContain("no capture group"));
  });

  it("says nothing about a pattern the host accepts, and nothing about a blank one", async () => {
    renderPanel([
      { pattern: "Cell(\\d+)", enabled: true },
      { pattern: "", enabled: true },
    ]);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("validate_signal_generator", {
        pattern: "Cell(\\d+)",
      }),
    );
    // A rule with nothing typed yet isn't an error — it's unfinished.
    expect(invoke).not.toHaveBeenCalledWith("validate_signal_generator", { pattern: "" });
    expect(document.querySelectorAll(".generator-error").length).toBe(0);
  });

  it("adds, deletes, and reorders rules — order is the evaluation order", () => {
    const { update } = renderPanel([
      { pattern: "A(\\d+)", enabled: true },
      { pattern: "B(\\d+)", enabled: true },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "+ rule" }));
    expect(lastRules(update)).toEqual([
      { pattern: "A(\\d+)", enabled: true },
      { pattern: "B(\\d+)", enabled: true },
      { pattern: "", enabled: true },
    ]);

    fireEvent.click(screen.getByLabelText("move rule 2 up"));
    expect(lastRules(update)).toEqual([
      { pattern: "B(\\d+)", enabled: true },
      { pattern: "A(\\d+)", enabled: true },
    ]);

    fireEvent.click(screen.getByLabelText("remove rule 1"));
    expect(lastRules(update)).toEqual([{ pattern: "B(\\d+)", enabled: true }]);
  });

  it("the first rule can't move up and the last can't move down", () => {
    renderPanel([
      { pattern: "A(\\d+)", enabled: true },
      { pattern: "B(\\d+)", enabled: true },
    ]);
    expect(screen.getByLabelText("move rule 1 up")).toBeDisabled();
    expect(screen.getByLabelText("move rule 2 down")).toBeDisabled();
    expect(screen.getByLabelText("move rule 1 down")).not.toBeDisabled();
  });

  it("parks a rule with the enable toggle instead of deleting it", () => {
    const { update } = renderPanel([{ pattern: "Cell(\\d+)", enabled: true }]);

    const toggle = screen.getByLabelText("rule 1 enabled") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(lastRules(update)).toEqual([{ pattern: "Cell(\\d+)", enabled: false }]);
  });

  it("offers an empty state that names what a rule is for", () => {
    renderPanel([]);
    expect(document.body.textContent).toContain("Cell(\\d+)");
  });
});
