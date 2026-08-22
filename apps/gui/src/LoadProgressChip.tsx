// The progress readout for a capture being loaded: a determinate bar
// once the host has reported a fraction, the indeterminate chip until
// then.
//
// The numbers are the host's — how much of a file a census has read,
// how many frames a pump has moved — and this only draws them. It never
// derives one from what it can see arriving, which would be a different
// (and wrong) number: the trace store's count excludes the frames a
// skipped channel or an import range filtered out.

import { loadProgressReadout, type ProgressReport } from "./statusLine";

export function LoadProgressChip({ progress }: { progress: ProgressReport | null }) {
  const readout = loadProgressReadout(progress);
  // Nothing reported yet, or a phase with no denominator: the wait is
  // real but its length is not known, which is exactly what the sliding
  // chip says. Pinning a determinate bar at zero would say something
  // stronger and untrue.
  if (readout === null) {
    return <span className="trace-scan-bar" aria-hidden="true" />;
  }
  const percent = Math.round(readout.fraction * 100);
  return (
    <>
      <span
        className="trace-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={readout.text}
      >
        <i style={{ width: `${percent}%` }} />
      </span>
      <span className="trace-progress-readout">{readout.text}</span>
    </>
  );
}
