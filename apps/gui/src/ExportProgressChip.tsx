// The status-bar readout for a capture being exported: the file's name,
// how far the write has got, and the way out of it — then, briefly, the
// fact that it finished.
//
// The export runs on the host's own thread and the GUI stays live
// throughout, so this is the only place the write is visible. The
// numbers are the host's (`export-progress`); nothing here is derived
// from what the frontend can see happening.

/// What the export in flight is doing, as the status bar shows it.
export type ExportStatus =
  | { phase: "running"; name: string; written: number; total: number }
  /// Finished and written. Shown for a moment, then dropped — the file
  /// is the lasting record, not the chip.
  | { phase: "done"; name: string };

export function ExportProgressChip({
  status,
  onCancel,
}: {
  status: ExportStatus;
  onCancel: () => void;
}) {
  if (status.phase === "done") {
    return (
      <span className="export-chip done" data-testid="export-chip">
        Exported {status.name}
      </span>
    );
  }
  // A denominator of zero is a real state — an empty capture, or a
  // report that beat the writer's counting pass — and it has no
  // fraction. Say what is happening without inventing one.
  const determinate = status.total > 0;
  const percent = determinate ? Math.round((status.written / status.total) * 100) : 0;
  return (
    <span className="export-chip" data-testid="export-chip">
      <span className="export-chip-label">
        Exporting {status.name}
        {determinate ? ` — ${percent}%` : ""}
      </span>
      {determinate && (
        <span
          className="trace-progress-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${status.written.toLocaleString()} / ${status.total.toLocaleString()} frames`}
        >
          <i style={{ width: `${percent}%` }} />
        </span>
      )}
      <button
        type="button"
        className="export-chip-cancel"
        title="Stop this export. The partial file is removed."
        aria-label={`Cancel exporting ${status.name}`}
        onClick={onCancel}
      >
        Cancel
      </button>
    </span>
  );
}
