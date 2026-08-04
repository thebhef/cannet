// @vitest-environment jsdom
//
// `useTrace` binds a panel to a trace element: the window arithmetic
// (offset / frameCount / run state) plus, for the views that draw rows,
// a page of decoded frames. Three of its four callers — the plot, the
// signals view, and a by-id trace — never read a row, so the page is
// opt-in: these tests pin that it is not fetched unless asked for, and
// that the window arithmetic is unaffected either way.

import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { ElementRegistryContext, type ElementRegistry } from "./projectElements";
import type { TraceData } from "./traceData";
import type { TraceFrameRecord } from "./types";
import { freshTrace, useTrace } from "./trace";

function harness(rows: boolean) {
  const fetchRange = vi.fn(async (): Promise<TraceFrameRecord[]> => []);
  const data: TraceData = {
    count: 5_000,
    firstIndex: 0,
    truncationTsNs: null,
    sessionStartSeconds: 0,
    epoch: 0,
    fetchRange,
    liveTail: { start: 0, rows: [] },
  };
  const registry = {
    entries: [],
    get: () => ({ element: { kind: "trace", id: "el" }, trace: freshTrace(0) }),
    updateTrace: () => {},
  } as unknown as ElementRegistry;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ElementRegistryContext.Provider value={registry}>{children}</ElementRegistryContext.Provider>
  );
  const hook = renderHook(() => useTrace(data, "el", rows), { wrapper });
  return { hook, fetchRange };
}

describe("useTrace", () => {
  it("fetches no rows for a caller that does not draw them", async () => {
    // Every Clear / Connect / DBC reload / Start / Stop re-anchors the
    // window, so an unconditional page meant a thousand decoded frames
    // fetched and dropped per open plot / signals / by-id panel.
    const { hook, fetchRange } = harness(false);

    // Give any effect-scheduled fetch a chance to land before asserting.
    await act(async () => {});

    expect(fetchRange).not.toHaveBeenCalled();
    expect(hook.result.current.getFrame(0)).toBeNull();
  });

  it("pages the window for a caller that draws rows", async () => {
    const { fetchRange } = harness(true);

    await waitFor(() => expect(fetchRange).toHaveBeenCalled());

    expect(fetchRange).toHaveBeenCalledWith(0, 1_000);
  });

  it("reports the same window either way", async () => {
    const off = harness(false);
    const on = harness(true);
    await act(async () => {});

    for (const h of [off, on]) {
      expect(h.hook.result.current.frameCount).toBe(5_000);
      expect(h.hook.result.current.offset).toBe(0);
      expect(h.hook.result.current.status).toBe("running");
    }
  });
});
