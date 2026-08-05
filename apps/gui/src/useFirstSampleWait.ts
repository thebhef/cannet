import { useCallback, useEffect, useRef, useState } from "react";

/// How long a plot area may wait on the first sample for its signal set
/// before it says so.
///
/// The gate is load-bearing, not a refinement. Changing an area's signal
/// list re-anchors the windowed source's cache, and with no cached
/// `base` the next request carries no visible slice — i.e. the whole
/// window at full point budget, decoded from cold. That fires on *every*
/// signal add, not only after a reload, so an ungated indicator would
/// flash on sub-100 ms adds and read as jitter rather than information.
export const FIRST_SAMPLE_INDICATOR_MS = 300;

export interface FirstSampleWait {
  /// True once the current signal set has been waiting longer than the
  /// gate for its first sample — the canvas is blank and the view should
  /// say why.
  waiting: boolean;
  /// Call from the fetch cycle as soon as it knows what the area holds:
  /// a window to draw, or a definitive "there is none". Ends the wait
  /// and disarms the gate until the signal set changes again.
  settled: () => void;
}

/// View-local "this area has nothing to draw *yet*" flag for a plot
/// area, distinct from "this area has nothing to draw".
///
/// `signalSetKey` identifies the signal set being waited on — `null`
/// when the area holds no signals, which arms nothing. A changed key
/// re-arms: the cache re-anchors per signal set, so each set pays its
/// own cold whole-window sample.
///
/// The indication is indeterminate by design. The host discovers the
/// decode work while doing it rather than knowing it up front, so
/// answering "how much longer" would mean growing a progress channel;
/// this is about informing, not about unblocking (the round-trip does
/// not run on the UI thread).
export function useFirstSampleWait(
  signalSetKey: string | null,
  delayMs = FIRST_SAMPLE_INDICATOR_MS,
): FirstSampleWait {
  const [waiting, setWaiting] = useState(false);
  const timerRef = useRef<number | null>(null);

  const disarm = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    disarm();
    setWaiting((w) => (w ? false : w));
    if (signalSetKey == null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setWaiting(true);
    }, delayMs);
    return disarm;
  }, [signalSetKey, delayMs, disarm]);

  const settled = useCallback(() => {
    disarm();
    setWaiting((w) => (w ? false : w));
  }, [disarm]);

  return { waiting, settled };
}
