// @vitest-environment jsdom
//
// Layer-A lifecycle of the plot's time-addressed windowed source (ADR
// 0025): the `DecimatedRange` sibling of `useWindowedQuery`. The plot is
// the one view addressed by time and lossy (one min/max bucket per
// pixel), so it gets its own accessor over the same lifecycle —
// descriptor-memo (skip the round-trip when the request is unchanged),
// re-anchor on window/descriptor change, base/extent tracked separately
// from content. `invoke` is mocked, so this exercises the lifecycle in
// isolation from the host.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";
import { fetchWindowExtent, useDecimatedRange, type DecimatedRequest } from "./useDecimatedRange";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

/// Build a `sample_signals` binary response (the `SIGSAMP\x01` layout
/// `decodeSignalsSample` reads). `null` first/last seconds encode as NaN.
function encode(
  fromS: number | null,
  lastS: number | null,
  series: { t: number[]; v: number[] }[],
  sliceMs = 0,
  decodeMs = 0,
  complete = true,
): ArrayBuffer {
  const totalPts = series.reduce((s, p) => s + p.t.length, 0);
  const buf = new ArrayBuffer(8 + 32 + 8 + series.length * 4 + totalPts * 16);
  const view = new DataView(buf);
  const magic = [0x53, 0x49, 0x47, 0x53, 0x41, 0x4d, 0x50, 0x02];
  for (let i = 0; i < 8; i++) view.setUint8(i, magic[i]);
  let off = 8;
  view.setFloat64(off, fromS == null ? NaN : fromS, true);
  off += 8;
  view.setFloat64(off, lastS == null ? NaN : lastS, true);
  off += 8;
  view.setFloat64(off, sliceMs, true);
  off += 8;
  view.setFloat64(off, decodeMs, true);
  off += 8;
  view.setUint32(off, complete ? 1 : 0, true);
  off += 4;
  view.setUint32(off, series.length, true);
  off += 4;
  for (const p of series) {
    view.setUint32(off, p.t.length, true);
    off += 4;
    for (const t of p.t) {
      view.setFloat64(off, t, true);
      off += 8;
    }
    for (const v of p.v) {
      view.setFloat64(off, v, true);
      off += 8;
    }
  }
  return buf;
}

const sig = {
  key: "k0",
  busId: null,
  messageId: 1,
  extended: false,
  signalName: "S",
};

function req(over: Partial<DecimatedRequest> = {}): DecimatedRequest {
  return {
    descriptor: "a",
    signals: [sig],
    winStart: 0,
    winEnd: 3,
    xMin: null,
    xMax: null,
    maxPoints: 600,
    ...over,
  };
}

beforeEach(() => mockInvoke.mockReset());
afterEach(() => vi.restoreAllMocks());

/// Drive one `sample` cycle to completion inside `act`.
async function run(
  fn: () => { sample: (r: DecimatedRequest, sidecar?: () => Promise<unknown>) => Promise<unknown> },
  r: DecimatedRequest,
  sidecar?: () => Promise<unknown>,
) {
  let out: unknown;
  await act(async () => {
    out = await fn().sample(r, sidecar);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return out as any;
}

describe("useDecimatedRange", () => {
  it("first fetch establishes base from from_seconds and returns samples relative to it", async () => {
    mockInvoke.mockResolvedValue(encode(100, 105, [{ t: [100, 101, 102], v: [1, 2, 3] }]));
    const { result } = renderHook(() => useDecimatedRange());

    const out = await run(() => result.current, req());

    expect(out.kind).toBe("sampled");
    expect(out.snapshot.base).toBe(100);
    expect(out.snapshot.firstT).toBe(0); // 100 − base (window starts at origin)
    expect(out.snapshot.lastT).toBe(5); // 105 − base
    expect(out.snapshot.byKey.get("k0")).toEqual({ t: [0, 1, 2], v: [1, 2, 3] });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(result.current.current()?.base).toBe(100);
  });

  it("firstT is the window start relative to the session origin, not the window's own first frame", async () => {
    // Window's first frame is at absolute 100 s, but the session origin
    // (`origin`) is 90 s — so firstT is 10, the elapsed time the window
    // begins at. This is the per-trace-Clear case (ADR 0024): the plot
    // must keep session time, not re-zero the left edge to 0.
    mockInvoke.mockResolvedValue(encode(100, 115, [{ t: [100, 110], v: [1, 2] }]));
    const { result } = renderHook(() => useDecimatedRange());

    const out = await run(() => result.current, req({ origin: 90 }));

    expect(out.kind).toBe("sampled");
    expect(out.snapshot.base).toBe(90);
    expect(out.snapshot.firstT).toBe(10); // 100 − 90
    expect(out.snapshot.lastT).toBe(25); // 115 − 90
  });

  it("skips the round-trip when the request is unchanged, reporting the live edge", async () => {
    mockInvoke.mockResolvedValue(encode(100, 105, [{ t: [100, 101], v: [1, 2] }]));
    const { result } = renderHook(() => useDecimatedRange());

    await run(() => result.current, req());
    const out = await run(() => result.current, req());

    expect(out.kind).toBe("unchanged");
    expect(out.firstT).toBe(0);
    expect(out.lastT).toBe(5);
    expect(mockInvoke).toHaveBeenCalledTimes(1); // no second fetch
  });

  it("skips the round-trip for a parked slice while the live edge advances", async () => {
    // A zoomed-into-history panel pins its visible bounds while `winEnd`
    // keeps growing. Frames appended past the last one we have already
    // seen cannot land inside a slice that ends before it, so the
    // request can only return the same bytes — the fast path must fire
    // rather than refetching, decoding and re-rendering identical output.
    mockInvoke.mockResolvedValue(encode(100, 110, [{ t: [101, 104], v: [1, 2] }]));
    const { result } = renderHook(() => useDecimatedRange());
    await run(() => result.current, req({ winEnd: 1000 })); // base = 100, live edge = 110
    await run(() => result.current, req({ winEnd: 1000, xMin: 1, xMax: 4 })); // zoom to 101..104
    expect(mockInvoke).toHaveBeenCalledTimes(2);

    const out = await run(() => result.current, req({ winEnd: 5000, xMin: 1, xMax: 4 }));

    expect(out.kind).toBe("unchanged");
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("reports a frozen live edge while parked — nothing here can see the capture grow", async () => {
    // The mechanism behind the panel-level staleness this fast path
    // causes: `unchanged` hands back the cached `lastT`, which is the
    // live edge as of the last *real* fetch. There is no round-trip to
    // refresh it, so anything that needs the window's current extent
    // (rather than the rendered one) has to ask for it separately.
    mockInvoke.mockResolvedValue(encode(100, 110, [{ t: [101, 104], v: [1, 2] }]));
    const { result } = renderHook(() => useDecimatedRange());
    await run(() => result.current, req({ winEnd: 1000 })); // base = 100, live edge = 110
    await run(() => result.current, req({ winEnd: 1000, xMin: 1, xMax: 4 })); // park on 101..104

    // The capture ran on — the host's live edge is now 150 s.
    mockInvoke.mockResolvedValue(encode(100, 150, [{ t: [101, 104], v: [1, 2] }]));
    const out = await run(() => result.current, req({ winEnd: 5000, xMin: 1, xMax: 4 }));

    expect(out.kind).toBe("unchanged");
    expect(out.lastT).toBe(10); // 110 − base, not the true 50
  });

  it("still refetches when the visible slice reaches the live edge", async () => {
    // The other side of the same rule: a slice whose right edge is at or
    // past the last frame seen *can* gain samples from a longer window,
    // so a growing `winEnd` must still re-anchor the fetch.
    mockInvoke.mockResolvedValue(encode(100, 110, [{ t: [105, 109], v: [1, 2] }]));
    const { result } = renderHook(() => useDecimatedRange());
    await run(() => result.current, req({ winEnd: 1000 })); // base = 100, live edge = 110
    await run(() => result.current, req({ winEnd: 1000, xMin: 5, xMax: 20 })); // 105..120
    expect(mockInvoke).toHaveBeenCalledTimes(2);

    const out = await run(() => result.current, req({ winEnd: 5000, xMin: 5, xMax: 20 }));

    expect(out.kind).toBe("sampled");
    expect(mockInvoke).toHaveBeenCalledTimes(3);
  });

  it("returns empty without fetching when the window has collapsed", async () => {
    const { result } = renderHook(() => useDecimatedRange());

    const out = await run(() => result.current, req({ winStart: 5, winEnd: 5 }));

    expect(out.kind).toBe("empty");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("stays pending (no base) when the fetch returns no real frames yet", async () => {
    mockInvoke.mockResolvedValue(encode(null, null, [{ t: [], v: [] }]));
    const { result } = renderHook(() => useDecimatedRange());

    const out = await run(() => result.current, req());

    expect(out.kind).toBe("pending");
    expect(result.current.current()).toBeNull();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("re-anchors on a descriptor change (new signal set)", async () => {
    mockInvoke.mockResolvedValue(encode(100, 105, [{ t: [100], v: [1] }]));
    const { result } = renderHook(() => useDecimatedRange());
    await run(() => result.current, req());

    mockInvoke.mockResolvedValue(encode(200, 205, [{ t: [200], v: [9] }]));
    const out = await run(() => result.current, req({ descriptor: "b" }));

    expect(out.kind).toBe("sampled");
    expect(out.snapshot.base).toBe(200); // re-established, not 100
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("re-anchors when winEnd shrinks under it (buffer cleared)", async () => {
    mockInvoke.mockResolvedValue(encode(100, 105, [{ t: [100], v: [1] }]));
    const { result } = renderHook(() => useDecimatedRange());
    await run(() => result.current, req({ winEnd: 10 }));

    mockInvoke.mockResolvedValue(encode(0, 1, [{ t: [0], v: [7] }]));
    const out = await run(() => result.current, req({ winEnd: 2 }));

    expect(out.kind).toBe("sampled");
    expect(out.snapshot.base).toBe(0); // re-anchored
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("translates a zoomed visible x-slice to absolute-seconds bounds", async () => {
    mockInvoke.mockResolvedValue(encode(100, 105, [{ t: [100], v: [1] }]));
    const { result } = renderHook(() => useDecimatedRange());
    await run(() => result.current, req()); // establishes base = 100

    mockInvoke.mockResolvedValue(encode(101, 104, [{ t: [101], v: [2] }]));
    await run(() => result.current, req({ xMin: 1, xMax: 4 }));

    const calls = mockInvoke.mock.calls;
    const lastArgs = calls[calls.length - 1]?.[1] as {
      fromSeconds: number;
      toSeconds: number;
    };
    expect(lastArgs.fromSeconds).toBe(101); // 1 + base
    expect(lastArgs.toSeconds).toBe(104); // 4 + base
  });

  it("reset() drops the window so the next fetch re-anchors", async () => {
    mockInvoke.mockResolvedValue(encode(100, 105, [{ t: [100], v: [1] }]));
    const { result } = renderHook(() => useDecimatedRange());
    await run(() => result.current, req());
    expect(result.current.current()?.base).toBe(100);

    act(() => result.current.reset());
    expect(result.current.current()).toBeNull();

    mockInvoke.mockResolvedValue(encode(50, 55, [{ t: [50], v: [3] }]));
    const out = await run(() => result.current, req());
    expect(out.snapshot.base).toBe(50);
  });

  it("runs the sidecar fetch in the same round-trip, only on a real fetch", async () => {
    mockInvoke.mockResolvedValue(encode(100, 105, [{ t: [100], v: [1] }]));
    const { result } = renderHook(() => useDecimatedRange());
    const sidecar = vi.fn().mockResolvedValue([{ lo: 1, hi: 3 }]);

    const out = await run(() => result.current, req(), sidecar);
    expect(out.kind).toBe("sampled");
    expect(out.extra).toEqual([{ lo: 1, hi: 3 }]);
    expect(sidecar).toHaveBeenCalledTimes(1);

    // Unchanged tick: no fetch, so the sidecar must not run again.
    const out2 = await run(() => result.current, req(), sidecar);
    expect(out2.kind).toBe("unchanged");
    expect(sidecar).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWindowExtent", () => {
  it("asks for the window's anchors alone — no signals, no slice bounds", async () => {
    // `last_seconds` is a fact about the window (the host reads it off
    // the store's anchors), not about the queried signals, so the
    // extent-only form of the query carries an empty signal list and
    // costs the host no per-signal slicing.
    mockInvoke.mockResolvedValue(encode(100, 150, []));

    expect(await fetchWindowExtent(0, 5000)).toBe(150);

    const args = mockInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(args.fromIndex).toBe(0);
    expect(args.windowEnd).toBe(5000);
    expect(args.signals).toEqual([]);
    expect(args.fromSeconds).toBeNull();
    expect(args.toSeconds).toBeNull();
  });

  it("is null for a collapsed window, without a round-trip", async () => {
    expect(await fetchWindowExtent(7, 7)).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("is null while the window holds no frames yet", async () => {
    mockInvoke.mockResolvedValue(encode(null, null, []));
    expect(await fetchWindowExtent(0, 10)).toBeNull();
  });
});
