// @vitest-environment jsdom
//
// The shared `useValueTables` hook: one `list_value_tables` fetch per
// signal, keyed by canonical signalKey, empties omitted. `invoke` is
// mocked so this runs without the host.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";
import { useValueTables, type ValueTableSignal } from "./useValueTables";
import { signalKey } from "./plotData";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

afterEach(() => vi.clearAllMocks());

const sig = (name: string): ValueTableSignal => ({
  busId: "b1",
  messageId: 100,
  extended: false,
  signalName: name,
});

describe("useValueTables", () => {
  it("keys each signal's table by canonical signalKey and omits empties", async () => {
    mockInvoke.mockImplementation(async (_cmd, args) => {
      const a = args as { signalName: string };
      if (a.signalName === "Mode") return [{ raw: 0, label: "Off" }, { raw: 1, label: "On" }];
      return []; // Counter: no table
    });
    const signals = [sig("Mode"), sig("Counter")];
    const { result } = renderHook(() => useValueTables(signals));
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get(signalKey("b1", 100, false, "Mode"))).toHaveLength(2);
    expect(result.current.has(signalKey("b1", 100, false, "Counter"))).toBe(false);
  });

  it("a failed lookup leaves that signal absent, not throwing", async () => {
    mockInvoke.mockImplementation(async (_cmd, args) => {
      const a = args as { signalName: string };
      if (a.signalName === "Bad") throw new Error("no such signal");
      return [{ raw: 0, label: "A" }, { raw: 1, label: "B" }];
    });
    const signals = [sig("Bad"), sig("Good")];
    const { result } = renderHook(() => useValueTables(signals));
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.has(signalKey("b1", 100, false, "Good"))).toBe(true);
  });

  it("does not refetch when the same signals arrive in a different order", async () => {
    // The result is keyed by signal, so order cannot change the answer —
    // and refetching would replace the map, which a caller deriving
    // state from it (the plot panel's enum-key set) reads as every
    // signal's table having changed.
    mockInvoke.mockImplementation(async () => [{ raw: 0, label: "Off" }]);
    const { result, rerender } = renderHook(
      ({ signals }: { signals: ValueTableSignal[] }) => useValueTables(signals),
      { initialProps: { signals: [sig("Mode"), sig("Counter")] } },
    );
    await waitFor(() => expect(result.current.size).toBe(2));
    const first = result.current;
    const calls = mockInvoke.mock.calls.length;

    rerender({ signals: [sig("Counter"), sig("Mode")] });
    await waitFor(() => expect(mockInvoke.mock.calls.length).toBe(calls));
    expect(result.current).toBe(first);
  });

  it("an empty signal list never invokes and returns an empty map — the gate panels use to skip non-enum signals", async () => {
    const { result } = renderHook(() => useValueTables([]));
    expect(result.current.size).toBe(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
