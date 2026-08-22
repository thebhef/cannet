// @vitest-environment jsdom
//
// The RBS mapping chip's badge: the notes and warnings across *every*
// RBS configuration in the project, live whether or not any RBS panel
// is open. Combining is fine for reporting — it is editing that must
// stay one config at a time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import type { RbsSignalRow } from "./types";

const ROWS = new Map<string, RbsSignalRow[]>();
const calls: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "rbs_signal_rows") {
      const id = args?.elementId as string;
      calls.push(id);
      return ROWS.get(id) ?? null;
    }
    return undefined;
  }),
}));

type Handler = () => void;
const mockListeners = new Map<string, Set<Handler>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    const set = mockListeners.get(event) ?? new Set();
    set.add(handler);
    mockListeners.set(event, set);
    return () => set.delete(handler);
  }),
}));
function emitHostEvent(event: string) {
  for (const h of mockListeners.get(event) ?? []) h();
}

import { useRbsAttentionCount } from "./rbsAttention";

let nextRowId = 0;

function row(status: RbsSignalRow["status"], over: Partial<RbsSignalRow> = {}): RbsSignalRow {
  nextRowId += 1;
  return {
    id: `row-${nextRowId}`,
    busKey: "Powertrain",
    busId: "bus-1",
    ecuName: "ECU",
    messageKey: "Msg",
    messageName: "Msg",
    messageId: 1,
    extended: false,
    signalName: "Sig",
    unit: "",
    status,
    value: null,
    label: null,
    overridden: status === "override",
    overrideText: null,
    calcRole: null,
    factor: 1,
    offset: 0,
    min: 0,
    max: 100,
    size: 8,
    signed: false,
    hasValueTable: false,
    detail: "",
    ...over,
  };
}

beforeEach(() => {
  ROWS.clear();
  calls.length = 0;
  mockListeners.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useRbsAttentionCount", () => {
  it("sums the problems across every configuration", () => {
    ROWS.set("a", [row("not-encoded"), row("override"), row("unknown-value")]);
    ROWS.set("b", [row("not-encoded"), row("muted"), row("default")]);
    const { result } = renderHook(() => useRbsAttentionCount(["a", "b"]));
    return waitFor(() => expect(result.current).toBe(3));
  });

  it("counts nothing when nothing needs attention", async () => {
    ROWS.set("a", [row("override"), row("default"), row("muted")]);
    const { result } = renderHook(() => useRbsAttentionCount(["a"]));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(result.current).toBe(0);
  });

  it("asks the host nothing when the project has no RBS configuration", async () => {
    const { result } = renderHook(() => useRbsAttentionCount([]));
    await waitFor(() => expect(result.current).toBe(0));
    expect(calls).toEqual([]);
  });

  it("refetches when the host says an RBS config changed", async () => {
    ROWS.set("a", [row("override")]);
    const { result } = renderHook(() => useRbsAttentionCount(["a"]));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    ROWS.set("a", [row("not-encoded"), row("not-encoded")]);
    await act(async () => emitHostEvent("rbs-changed"));
    await waitFor(() => expect(result.current).toBe(2));
  });

  it("counts an applied override outside its signal's range, the way the grid does", async () => {
    // Out of Range is decided in the frontend, not by the host — so the
    // badge must apply the same rule the grid applies, or it would
    // disagree with the panel it opens.
    ROWS.set("a", [row("override", { value: 5000 })]);
    const { result } = renderHook(() => useRbsAttentionCount(["a"]));
    await waitFor(() => expect(result.current).toBe(1));
  });
});
