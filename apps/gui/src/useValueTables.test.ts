// @vitest-environment jsdom
//
// The shared `useValueTables` hook: one `list_value_tables` fetch per
// signal, keyed by canonical signalKey, empties omitted. `invoke` is
// mocked so this runs without the host.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";
import { useValueTables, type ValueTableSignal } from "./useValueTables";
import { signalKey } from "./plotData";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The shared carrier's one listener (ADR 0053 §3) — the host announcing
// a DBC-set change is what this file drives through `announce()`.
type Handler = () => void;
let handlers: Handler[] = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: Handler) => {
    handlers.push(handler);
    return () => {
      handlers = handlers.filter((h) => h !== handler);
    };
  }),
}));
function announce(): void {
  for (const h of [...handlers]) h();
}

const mockInvoke = vi.mocked(invoke);

afterEach(() => {
  cleanup();
  handlers = [];
  vi.clearAllMocks();
});

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

  it("asks in the signal's own namespace, so a file-backed table is fetched and keyed as one", async () => {
    // A file-backed signal's `messageId` is its source file's signal
    // channel group index, not a CAN id; the host needs the flag to
    // know which of the two it was handed.
    mockInvoke.mockImplementation(async (_cmd, args) => {
      const a = args as { fileBacked: boolean };
      return a.fileBacked ? [{ raw: 0, label: "Startup" }, { raw: 1, label: "Idle" }] : [];
    });
    const coded: ValueTableSignal = { ...sig("CurrentState"), busId: null, fileBacked: true };
    const { result } = renderHook(() => useValueTables([coded, sig("Mode")]));
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get(signalKey(null, 100, false, "CurrentState", true))).toHaveLength(2);
    expect(mockInvoke).toHaveBeenCalledWith("list_value_tables", {
      messageId: 100,
      extended: false,
      signalName: "CurrentState",
      fileBacked: true,
      busId: null,
    });
    expect(mockInvoke).toHaveBeenCalledWith("list_value_tables", {
      messageId: 100,
      extended: false,
      signalName: "Mode",
      fileBacked: false,
      busId: "b1",
    });
  });

  it("passes each signal's busId through the invoke, so the host resolves per bus", async () => {
    mockInvoke.mockImplementation(async () => []);
    const powertrain: ValueTableSignal = { ...sig("Gear"), busId: "powertrain" };
    const unknown: ValueTableSignal = { ...sig("Mode"), busId: null };
    renderHook(() => useValueTables([powertrain, unknown]));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
    expect(mockInvoke).toHaveBeenCalledWith("list_value_tables", {
      messageId: 100,
      extended: false,
      signalName: "Gear",
      fileBacked: false,
      busId: "powertrain",
    });
    expect(mockInvoke).toHaveBeenCalledWith("list_value_tables", {
      messageId: 100,
      extended: false,
      signalName: "Mode",
      fileBacked: false,
      busId: null,
    });
  });

  it("refetches when the host announces a DBC-set change, so a panel that mounted first is not stuck", async () => {
    // Measured: a panel mounts and asks before the project's DBCs are
    // installed, gets "no table", and — keying its
    // fetch on the signal set alone — never asks again. The enum lane
    // stays numeric until the view is closed and reopened. The DBC set
    // changing is the carrier that has to reach it (ADR 0053 §4).
    let installed = false;
    mockInvoke.mockImplementation(async () =>
      installed ? [{ raw: 0, label: "Off" }, { raw: 1, label: "On" }] : [],
    );
    const signals = [sig("Mode")];
    const { result } = renderHook(() => useValueTables(signals));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
    expect(result.current.size).toBe(0);

    installed = true;
    act(() => announce());
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get(signalKey("b1", 100, false, "Mode"))).toHaveLength(2);
  });

  it("an empty signal list never invokes and returns an empty map — the gate panels use to skip non-enum signals", async () => {
    const { result } = renderHook(() => useValueTables([]));
    expect(result.current.size).toBe(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
