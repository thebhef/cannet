import type { TraceStatus } from "./trace";

interface TraceControlsProps {
  status: TraceStatus;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
}

/**
 * The common Start / Stop / Pause / Resume / Clear toolbar for a
 * trace-style view. Stateless — the owning panel holds the trace (via
 * {@link useTrace}); this just renders the buttons for the current
 * status and calls back.
 */
export function TraceControls({
  status,
  onStart,
  onStop,
  onPause,
  onResume,
  onClear,
}: TraceControlsProps) {
  return (
    <span className="trace-controls">
      {status === "running" && (
        <>
          <button type="button" onClick={onPause}>
            Pause
          </button>
          <button type="button" onClick={onStop}>
            Stop
          </button>
        </>
      )}
      {status === "paused" && (
        <>
          <button type="button" onClick={onResume}>
            Resume
          </button>
          <button type="button" onClick={onStop}>
            Stop
          </button>
        </>
      )}
      {status === "stopped" && (
        <button type="button" onClick={onStart}>
          Start
        </button>
      )}
      <button type="button" onClick={onClear}>
        Clear
      </button>
      <span className={`trace-status trace-status-${status}`}>{status}</span>
    </span>
  );
}
