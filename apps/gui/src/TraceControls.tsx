import { ChipButton } from "./ChipButton";
import { ChipSegment } from "./ChipSegment";
import type { TraceStatus } from "./trace";

interface TraceControlsProps {
  status: TraceStatus;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
  /// Widen the window to the whole session buffer, beside Clear —
  /// renders an "All Data" chip only when supplied. Currently only
  /// the plot passes it (post-DBC-reload recovery: Clear collapses the
  /// window for a cheap signal re-pick, All Data widens back out for
  /// one full-history resample); the other trace-style views don't
  /// need it.
  onAllData?: () => void;
}

/**
 * The common Start / Stop / Pause / Resume / Clear toolbar for a
 * trace-style view. Stateless — the owning panel holds the trace (via
 * {@link useTrace}); this just renders the chips for the current
 * status and calls back.
 */
export function TraceControls({
  status,
  onStart,
  onStop,
  onPause,
  onResume,
  onClear,
  onAllData,
}: TraceControlsProps) {
  return (
    <span className="trace-controls">
      <ChipSegment label="Run Controls" className="trace-controls-run">
        {status === "running" && (
          <>
            <ChipButton icon="pause" ariaLabel="Pause" title="Pause" onPress={onPause} />
            <ChipButton icon="stop" ariaLabel="Stop" title="Stop" onPress={onStop} />
          </>
        )}
        {status === "paused" && (
          <>
            <ChipButton icon="play" ariaLabel="Resume" title="Resume" onPress={onResume} />
            <ChipButton icon="stop" ariaLabel="Stop" title="Stop" onPress={onStop} />
          </>
        )}
        {status === "stopped" && (
          <ChipButton icon="play" ariaLabel="Start" title="Start" onPress={onStart} />
        )}
        <ChipButton icon="clear" ariaLabel="Clear" title="Clear" onPress={onClear} />
      </ChipSegment>
      {onAllData && (
        <ChipButton
          label="All Data"
          ariaLabel="All Data"
          title="widen the window to the whole session buffer and fit the x-axis to it"
          onPress={onAllData}
        />
      )}
      <span className={`trace-status trace-status-${status}`}>{status}</span>
    </span>
  );
}
