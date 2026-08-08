// @vitest-environment jsdom
//
// The generator index (ADR 0026): the project's ordered rules and the
// DBC signal catalog go to the host, which answers one color-wheel slot
// per signal name; the frontend only zips those answers back onto the
// canonical signal keys. No user regex is ever compiled here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "list_signals") {
      // One DBC message on two buses: the same signal name appears
      // twice with different keys.
      return ["b1", "b2"].flatMap((bus) =>
        ["Cell1", "Cell2", "EngineRpm"].map((signal_name) => ({
          bus_id: bus,
          message_id: 256,
          extended: false,
          message_name: "Pack",
          transmitter: "Bms",
          signal_name,
          unit: "",
        })),
      );
    }
    if (cmd === "evaluate_signal_generators") {
      // Stand-in for the host's regex: "Cell<n>" → n, anything else no
      // answer. Positional, in the order the names were sent.
      const names = args?.names as string[];
      return names.map((n) => {
        const m = /^Cell(\d+)$/.exec(n);
        return m ? Number(m[1]) : null;
      });
    }
    return [];
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { SignalCatalogProvider } from "./signalCatalogContext";
import { SignalGeneratorProvider, useSignalGeneratorIndexes } from "./signalGeneratorContext";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ElementRegistryContext, type ElementRegistry } from "./projectElements";
import { freshTrace } from "./trace";
import { signalKey } from "./plotData";
import type { ProjectElement } from "./types";

const projectCtx = {
  buses: [
    { id: "b1", name: "Pack A" },
    { id: "b2", name: "Pack B" },
  ],
  dbcPaths: [],
} as unknown as ProjectContextValue;

/// Renders the resolved key→slot map so a test can assert on it.
function Probe() {
  const indexes = useSignalGeneratorIndexes();
  return (
    <div data-testid="probe">
      {[...indexes]
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(";")}
    </div>
  );
}

function renderProbe(elements: ProjectElement[]) {
  const registry = {
    entries: elements.map((element) => ({ element, trace: freshTrace(0) })),
    get: () => undefined,
    create: () => "",
    ensure: () => {},
    updateTrace: () => {},
    update: () => {},
    remove: () => {},
  } as unknown as ElementRegistry;
  render(
    <ProjectContext.Provider value={projectCtx}>
      <SignalCatalogProvider>
        <ElementRegistryContext.Provider value={registry}>
          <SignalGeneratorProvider>
            <Probe />
          </SignalGeneratorProvider>
        </ElementRegistryContext.Provider>
      </SignalCatalogProvider>
    </ProjectContext.Provider>,
  );
}

const generator = (id: string, ...rules: { pattern: string; enabled: boolean }[]): ProjectElement =>
  ({ kind: "generator", id, rules }) as ProjectElement;

/// The `evaluate_signal_generators` argument object of the last call.
function lastEvaluateArgs(): { patterns: string[]; names: string[] } {
  const calls = invoke.mock.calls.filter((c) => c[0] === "evaluate_signal_generators");
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as unknown as { patterns: string[]; names: string[] };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("SignalGeneratorProvider", () => {
  it("sends the enabled rules in element order and every catalog name once", async () => {
    renderProbe([
      generator("g1", { pattern: "Cell(\\d+)", enabled: true }, { pattern: "off", enabled: false }),
      generator("g2", { pattern: "", enabled: true }, { pattern: "Mod(\\d+)", enabled: true }),
    ]);

    await waitFor(() => expect(lastEvaluateArgs().patterns.length).toBeGreaterThan(0));
    const args = lastEvaluateArgs();
    // Disabled and blank rules never reach the host; the rest keep
    // their order, which is the evaluation order.
    expect(args.patterns).toEqual(["Cell(\\d+)", "Mod(\\d+)"]);
    // The same name on two buses is one question, not two.
    expect([...args.names].sort()).toEqual(["Cell1", "Cell2", "EngineRpm"]);
  });

  it("gives every bus's copy of a claimed name the same slot", async () => {
    renderProbe([generator("g1", { pattern: "Cell(\\d+)", enabled: true })]);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).not.toBe(""));
    expect(screen.getByTestId("probe").textContent).toBe(
      [
        `${signalKey("b1", 256, false, "Cell1")}=1`,
        `${signalKey("b1", 256, false, "Cell2")}=2`,
        `${signalKey("b2", 256, false, "Cell1")}=1`,
        `${signalKey("b2", 256, false, "Cell2")}=2`,
      ]
        .sort()
        .join(";"),
    );
    // A name no rule claims stays out of the map, so it keeps its hash.
    expect(screen.getByTestId("probe").textContent).not.toContain("EngineRpm");
  });

  it("asks the host nothing when the project declares no usable rule", async () => {
    renderProbe([generator("g1", { pattern: "Cell(\\d+)", enabled: false })]);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_signals", expect.anything()),
    );
    expect(invoke.mock.calls.some((c) => c[0] === "evaluate_signal_generators")).toBe(false);
    expect(screen.getByTestId("probe").textContent).toBe("");
  });
});
