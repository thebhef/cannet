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
  /// Call from the fetch cycle as soon as the area has something to
  /// draw, or a definitive "there is none". Ends the wait and disarms
  /// the gate until the signal set changes again.
  ///
  /// "Something to draw" and "the host has finished" are two different
  /// moments, and this is the first of them (ADR 0049). A host serve is
  /// bounded in time, so a cold one answers with the prefix it has decoded: the
  /// gate ends there, on the first points, and the plot goes on filling
  /// in as later serves continue the rebuild. An answer that carries no
  /// points and is *not* the host's final word is not an outcome — it is
  /// the wait, still going.
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
/// The indication is indeterminate by design, and deliberately brief:
/// the host answers with whatever it has decoded so far, so the growing
/// picture itself is the progress report. Answering "how much longer"
/// would mean growing a progress channel; this is about informing until
/// there is something to look at, not about unblocking (the round-trip
/// does not run on the UI thread).
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
