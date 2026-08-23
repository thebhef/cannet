// @vitest-environment jsdom
//
// Wiring test for `usePushViewSignals` itself: pushes on mount, skips
// a re-push when nothing changed, re-pushes when the refs change, and
// un-pushes on unmount. The per-view `*ViewSignalRefs` builders are
// covered in `viewSignalsPush.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { usePushViewSignals } from "./viewSignalsPush";
import type { ViewSignalRef } from "./types";

function Probe({ viewId, viewName, refs }: { viewId: string; viewName: string; refs: ViewSignalRef[] }) {
  usePushViewSignals(viewId, viewName, refs);
  return null;
}

const ref = (signalName: string): ViewSignalRef => ({
  busId: "power",
  messageId: 0x100,
  extended: false,
  signalName,
});

beforeEach(() => {
  vi.mocked(invoke).mockClear();
});
afterEach(() => cleanup());

describe("usePushViewSignals", () => {
  it("pushes on mount", () => {
    render(<Probe viewId="v1" viewName="Plot 1" refs={[ref("A")]} />);
    expect(invoke).toHaveBeenCalledWith("set_view_signals", {
      viewId: "v1",
      viewName: "Plot 1",
      signals: [ref("A")],
    });
  });

  it("does not re-invoke when a re-render passes an equal-by-value refs array", () => {
    const { rerender } = render(<Probe viewId="v1" viewName="Plot 1" refs={[ref("A")]} />);
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "set_view_signals")).toHaveLength(1);
    // A fresh array, same contents — what a config recompute usually
    // hands back.
    rerender(<Probe viewId="v1" viewName="Plot 1" refs={[ref("A")]} />);
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "set_view_signals")).toHaveLength(1);
  });

  it("re-pushes when the refs actually change", () => {
    const { rerender } = render(<Probe viewId="v1" viewName="Plot 1" refs={[ref("A")]} />);
    rerender(<Probe viewId="v1" viewName="Plot 1" refs={[ref("A"), ref("B")]} />);
    const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "set_view_signals");
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual({
      viewId: "v1",
      viewName: "Plot 1",
      signals: [ref("A"), ref("B")],
    });
  });

  it("un-pushes on unmount", () => {
    const { unmount } = render(<Probe viewId="v1" viewName="Plot 1" refs={[ref("A")]} />);
    unmount();
    expect(invoke).toHaveBeenCalledWith("remove_view_signals", { viewId: "v1" });
  });
});
