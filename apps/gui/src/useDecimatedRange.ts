import { useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import { diagCount } from "./diag"; // DIAG
import { decodeSignalsSample } from "./plotData";
import type { Series } from "./plotCursors";

/// The plot's time-addressed windowed source — the `DecimatedRange`
/// sibling of [`useWindowedQuery`](./useWindowedQuery.ts), per the
/// Layer-A/B split in
/// [ADR 0025](../../docs/adr/0025-frontend-windowed-source-contract.md).
///
/// Three of the four data views are row-addressed and exact, so they
/// share `useWindowedQuery`. The plot is the odd one out: it is
/// addressed by **time** and its result is **lossy** (one min/max bucket
/// per pixel column), so "page 3 of RPM" is meaningless. It therefore
/// gets this sibling hook rather than the row-page primitive — same
/// lifecycle (descriptor-memo the round-trip, re-anchor on window or
/// signal-set change, drop on a buffer clear, track the x-axis origin
/// separately from content), different accessor shape.
///
/// This hook owns only the *fetch + cache lifecycle*. The plot's
/// renderer-shaping (auto-normalisation, `mergeSeries`, enum mode,
/// `uPlot.setData`, the follow-live edge slide) stays in the view, which
/// drives this from its self-paced resample loop. The per-signal y-extent
/// is a separate scalar host query (`signal_min_max`), not part of this
/// accessor (ADR 0025); the caller passes it as the optional `sidecar`
/// so it rides the same round-trip without re-coupling it to the window.

/// One signal to sample. `key` is the caller's stable per-signal id (the
/// cache and the returned `byKey` are keyed by it); the rest is the host
/// `SignalQuery`.
export interface DecimatedSignal {
  key: string;
  busId: string | null;
  messageId: number;
  extended: boolean;
  signalName: string;
}

/// Everything that determines a fetch. An unchanged request (same
/// window, slice, pixel budget, and signal set) means no round-trip; a
/// changed `descriptor`, `winStart`, or a `winEnd` that shrank below the
/// last seen one re-anchors the window.
export interface DecimatedRequest {
  /// Memo key for the signal set — changing it re-anchors the window.
  descriptor: string;
  /// Signals to sample, in render order (matches `descriptor`).
  signals: DecimatedSignal[];
  /// The trace window `[winStart, winEnd)`: the fetch anchor, and the
  /// buffer-clear sentinel (a `winEnd` below the last seen re-anchors).
  winStart: number;
  winEnd: number;
  /// Visible x-slice, seconds relative to `base`, or `null` to fetch the
  /// whole window (before zoom, or before `base` is known).
  xMin: number | null;
  xMax: number | null;
  /// Desired x-axis origin (absolute seconds): the single application-level
  /// trace start (ADR 0024), so the plot's `t=0` matches the trace table's.
  /// `null`/omitted falls back to the window's first-frame timestamp — the
  /// pre-session transient, before a session start is known.
  origin?: number | null;
  /// Pixel budget — the host returns at most `2 * maxPoints` min/max
  /// points (one bucket per pixel column).
  maxPoints: number;
}

/// The current decimated window, times relative to `base`.
export interface DecimatedSnapshot {
  /// x-axis origin (absolute seconds): the application-level trace start
  /// (`DecimatedRequest.origin`, ADR 0024), or the window's first-frame
  /// timestamp before a session start is known.
  base: number;
  /// The trace window's first-frame time relative to `base` — the floor
  /// the x-window may never drop below (ADR 0024: a Clear re-anchors the
  /// window but doesn't re-zero the display, so this is `0` only when the
  /// window starts at the session origin). `null` before the first
  /// non-empty fetch.
  firstT: number | null;
  /// The window's last-frame time relative to `base` (the live edge), or
  /// `null` before the first non-empty fetch.
  lastT: number | null;
  byKey: Map<string, Series>;
  /// Host diagnostics for the fetch that produced this snapshot.
  sliceMs: number;
  decodeMs: number;
}

/// What one `sample` cycle did, so the caller knows how to render:
/// - `empty` — the window collapsed; clear the plot.
/// - `pending` — no real frames yet (`base` not established); try again.
/// - `unchanged` — identical request; keep the rendered data, just feed
///   the follow-live edge from `lastT`.
/// - `sampled` — fresh `snapshot` to render; `extra` carries the
///   `sidecar` result (or `null` when none was passed).
export type DecimatedOutcome<X = unknown> =
  | { kind: "empty" }
  | { kind: "pending" }
  | { kind: "unchanged"; firstT: number | null; lastT: number | null }
  | { kind: "sampled"; snapshot: DecimatedSnapshot; extra: X | null };

export interface DecimatedRange {
  /// Run one fetch cycle for `req`. Owns the cache lifecycle; never
  /// touches uPlot. `sidecar`, if given, is awaited in parallel with the
  /// sample and only when a real round-trip happens (so a scalar
  /// companion query — `signal_min_max` — adds no wall-clock yet doesn't
  /// fire on skipped ticks); its result rides in `sampled.extra`.
  sample<X = unknown>(
    req: DecimatedRequest,
    sidecar?: () => Promise<X>,
  ): Promise<DecimatedOutcome<X>>;
  /// The current window, or `null` before the first non-empty fetch /
  /// after `reset`. Read for the cached-points gauge and the side-panel
  /// cache diagnostics.
  current(): DecimatedSnapshot | null;
  /// Drop the window — the signal set's uPlot instance was rebuilt, or
  /// the area went empty.
  reset(): void;
}

interface Cache {
  descriptor: string;
  anchorStart: number;
  base: number | null;
  firstT: number | null;
  lastT: number | null;
  byKey: Map<string, Series>;
  /// `${winStart}:${winEnd}:${fromSeconds}:${toSeconds}:${maxPoints}` —
  /// skip the fetch when it matches the last successful one.
  fetchKey: string;
  /// Latest `winEnd` seen, to detect a buffer clear shrinking the window.
  lastWinEnd: number;
  sliceMs: number;
  decodeMs: number;
}

export function useDecimatedRange(): DecimatedRange {
  const cacheRef = useRef<Cache | null>(null);

  const snapshotOf = (c: Cache | null): DecimatedSnapshot | null =>
    c && c.base != null
      ? { base: c.base, firstT: c.firstT, lastT: c.lastT, byKey: c.byKey, sliceMs: c.sliceMs, decodeMs: c.decodeMs }
      : null;

  const current = useCallback((): DecimatedSnapshot | null => snapshotOf(cacheRef.current), []);

  const reset = useCallback(() => {
    cacheRef.current = null;
  }, []);

  const sample = useCallback(
    async <X,>(req: DecimatedRequest, sidecar?: () => Promise<X>): Promise<DecimatedOutcome<X>> => {
      // (Re)anchor whenever the signal set or the window anchor changes,
      // or `winEnd` shrinks under us (the session buffer was cleared).
      let cache = cacheRef.current;
      if (
        !cache ||
        cache.anchorStart !== req.winStart ||
        cache.descriptor !== req.descriptor ||
        req.winEnd < cache.lastWinEnd
      ) {
        cache = {
          descriptor: req.descriptor,
          anchorStart: req.winStart,
          base: null,
          firstT: null,
          lastT: null,
          byKey: new Map(),
          fetchKey: "",
          lastWinEnd: req.winEnd,
          sliceMs: 0,
          decodeMs: 0,
        };
        cacheRef.current = cache;
      }

      // The visible x-slice is sent as absolute-seconds bounds, applied
      // host-side against the cached samples' own timestamps — avoiding
      // the average-rate approximation error that frame-index bounds
      // would introduce on a zoomed panel with a non-uniform per-id rate.
      let fromSeconds: number | null = null;
      let toSeconds: number | null = null;
      if (cache.base != null && req.xMin != null && req.xMax != null && req.xMax > req.xMin) {
        fromSeconds = req.xMin + cache.base;
        toSeconds = req.xMax + cache.base;
      }
      const fetchKey = `${req.winStart}:${req.winEnd}:${fromSeconds}:${toSeconds}:${req.maxPoints}`;

      if (cache.fetchKey === fetchKey && cache.byKey.size > 0) {
        return { kind: "unchanged", firstT: cache.firstT, lastT: cache.lastT };
      }
      if (req.winEnd <= req.winStart) {
        cache.byKey = new Map();
        cache.fetchKey = fetchKey;
        cache.lastWinEnd = req.winEnd;
        return { kind: "empty" };
      }

      diagCount("invoke.sample_signals"); // DIAG
      const [buf, extra] = await Promise.all([
        invoke<ArrayBuffer>("sample_signals", {
          fromIndex: req.winStart,
          windowEnd: req.winEnd,
          fromSeconds,
          toSeconds,
          signals: req.signals.map((s) => ({
            busId: s.busId,
            messageId: s.messageId,
            extended: s.extended,
            signalName: s.signalName,
          })),
          maxPoints: req.maxPoints,
        }),
        sidecar ? sidecar() : Promise.resolve(null),
      ]);
      // Re-anchored or reset while the fetch was in flight — drop this
      // result; a later tick refetches against the live cache.
      if (cacheRef.current !== cache) return { kind: "pending" };

      const res = decodeSignalsSample(buf);
      if (cache.base == null) {
        // The x-axis origin is the application-level trace start (`req.origin`,
        // ADR 0024) so the plot's `t=0` matches the trace table's. Until a
        // session start is known it falls back to `res.from_seconds` (exactly
        // ts(winStart), since the first fetch is anchored at `winStart`).
        const origin = req.origin ?? res.from_seconds;
        if (origin == null) return { kind: "pending" }; // nothing real yet
        cache.base = origin;
      }
      const base = cache.base;

      const byKey = new Map<string, Series>();
      req.signals.forEach((s, i) => {
        const got = res.series[i] ?? { t: [], v: [] };
        const t = new Array<number>(got.t.length);
        for (let j = 0; j < got.t.length; j++) t[j] = got.t[j] - base;
        byKey.set(s.key, { t, v: got.v.slice() });
      });
      cache.byKey = byKey;
      // `res.from_seconds` is the *window's* first-frame timestamp (the
      // frame at `winStart`, not the fetched slice's left edge), so the
      // window-start floor stays right on a zoomed-in panel. It is `0`
      // relative to `base` only when the window starts at the session
      // origin (ADR 0024).
      if (res.from_seconds != null) cache.firstT = res.from_seconds - base;
      // `res.last_seconds` is the *window's* last-frame timestamp (not
      // the fetched slice's edge), so the live edge stays accurate on a
      // zoomed-in panel.
      if (res.last_seconds != null) cache.lastT = res.last_seconds - base;
      cache.fetchKey = fetchKey;
      cache.lastWinEnd = req.winEnd;
      cache.sliceMs = res.slice_ms;
      cache.decodeMs = res.decode_ms;

      return { kind: "sampled", snapshot: snapshotOf(cache)!, extra: extra as X | null };
    },
    [],
  );

  return { sample, current, reset };
}
