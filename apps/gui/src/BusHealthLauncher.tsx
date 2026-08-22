/// The bus-health control: a compact icon button, not a status chip —
/// the launcher case of ADR 0055.
///
/// It began as a chip reading "Bus health — OK", and that was wrong
/// three ways. "Health" is a strange word for "this bus is fine"; it
/// overlapped the connection chip, which already says whether traffic
/// is flowing; and — the disqualifying one — with several buses a
/// single summary **cannot name which bus is off**, which is the only
/// thing worth knowing when one is. So it is a launcher, and the panel
/// it opens is where "which bus" is answered.
///
/// It stays neutral while every bus is error-active and **tints plus
/// grows a count when one is not**, with the tooltip naming the bus, so
/// a bus going off is still noticed without needing a word for the
/// healthy case.

/// One bus that is not error-active. `busOff` is the fault; anything
/// else is the warning.
export interface BusHealthConcern {
  bus: string;
  /// How the bus reads — "error-passive", "bus-off", whatever the
  /// health model calls it. Shown in the tooltip verbatim.
  state: string;
  busOff: boolean;
}

export interface BusHealthLauncherProps {
  /// Buses that are not error-active. Empty means every bus is.
  concerns: readonly BusHealthConcern[];
  /// Opens the bus health panel. Omitted when there is no panel to
  /// open, which leaves the launcher reporting but not pretending to
  /// be pressable.
  onOpen?: () => void;
}

export function BusHealthLauncher({ concerns, onOpen }: BusHealthLauncherProps) {
  const state = concerns.length === 0 ? "idle" : concerns.some((c) => c.busOff) ? "failed" : "degraded";
  const title =
    concerns.length === 0
      ? "Bus health — all buses error-active"
      : `Bus health — ${concerns.map((c) => `${c.bus} is ${c.state}`).join(", ")}`;
  return (
    <button
      type="button"
      className="bus-health-launcher"
      data-state={state}
      title={title}
      aria-label={title}
      disabled={onOpen === undefined}
      onClick={onOpen}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <polyline
          points="1,9 4,9 6,4 8,13 10,9 15,9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      {concerns.length > 0 && (
        <span className="bus-health-launcher-count" aria-hidden="true">
          {concerns.length}
        </span>
      )}
    </button>
  );
}
