// Mirrors the Rust shapes in src-tauri/src/ipc.rs. Kept manually in sync
// because the two surfaces are small enough that a code generator would
// be more friction than benefit at Phase 2.

export type CanFrameKind =
  | { kind: "classic" }
  | { kind: "fd"; brs: boolean; esi: boolean }
  | { kind: "remote"; dlc: number }
  | { kind: "error" };

export interface SignalRecord {
  name: string;
  value: number;
  unit: string;
  /// `VAL_` label matching this decoded value, if the DBC defines one.
  /// Trace rows render `<value> "<label>"` when present.
  label?: string | null;
}

export interface DecodedRecord {
  name: string;
  signals: SignalRecord[];
}

/// Returned by the `fetch_trace_range` Tauri command, one per row in
/// the requested range. Decoded against whichever DBC is currently
/// attached.
export interface TraceFrameRecord {
  index: number;
  timestamp_seconds: number;
  channel: number;
  id: number;
  extended: boolean;
  direction: "Rx" | "Tx";
  kind: CanFrameKind;
  data: number[];
  decoded: DecodedRecord | null;
}

/// Periodic IPC event carrying the trace store's current size + rate,
/// plus a short decoded tail of the newest frames so the auto-scrolling
/// trace view can paint the live edge without a fetch round-trip.
export interface TraceGrew {
  count: number;
  frames_per_second: number;
  tail: TraceFrameRecord[];
}

export type LogFinished =
  | { status: "ok"; total: number }
  | { status: "error"; message: string };

export interface OpenLogResult {
  blf_path: string;
}

export interface DbcInfo {
  dbc_path: string;
  message_count: number;
}

export interface InterfaceRecord {
  id: string;
  display_name: string;
  fd_capable: boolean;
}

export interface SubscriptionRecord {
  interface_id: string;
  channel: number;
}

export interface RemoteSessionResult {
  address: string;
  interfaces: InterfaceRecord[];
  subscriptions: SubscriptionRecord[];
}

/// One row of the per-message-ID view (mirrors `ipc.rs::ByIdSnapshot`):
/// an arbitration id's latest frame plus its current message rate
/// (frames/second).
export interface ByIdSnapshotRecord {
  frame: TraceFrameRecord;
  rate: number;
}

/// One element of a project: a discriminated-union record with a stable
/// `id`. `trace` = a trace panel; `plot` = a signal-plot panel (also
/// backed by a trace-style session window, but a distinct kind so the
/// project view and panel-reopen treat it as a plot, not a trace);
/// `transmit` = a Phase-5 transmit panel composing CAN frames. The
/// element itself carries no extra config — the panel showing it owns
/// its config (a trace's mode + columns, a plot's areas / cursors,
/// a transmit panel's frame list) in the dockview panel `params`.
export type ProjectElement =
  | { kind: "trace"; id: string }
  | { kind: "plot"; id: string }
  | { kind: "transmit"; id: string };

/// The discriminant of a {@link ProjectElement}.
export type ProjectElementKind = ProjectElement["kind"];

/// Mirrors `src-tauri/src/project.rs::Project` — the saved workspace.
/// `layout` (dockview's `SerializedDockview`) and `elements` are stored
/// by the host without interpretation, so they're typed loosely here
/// and validated before use (`dockLayout.ts::validateLayout`,
/// `projectElements.ts::isProjectElement`).
export interface Project {
  schema_version: number;
  layout: unknown;
  elements: unknown[];
  /// Paths of the loaded DBCs, in priority order (first match wins when
  /// decoding) — references re-read from disk on open.
  dbc_paths: string[];
  remote_address: string | null;
}

export const PROJECT_SCHEMA_VERSION = 2;

/// One `(message, signal)` pair the attached DBC defines, returned by
/// the `list_signals` command for a plot panel's signal picker.
export interface SignalDescriptorRecord {
  message_id: number;
  extended: boolean;
  message_name: string;
  signal_name: string;
  unit: string;
  /// True if the DBC defines a `VAL_` table for this signal. The plot
  /// panel uses it to switch to stepped + symbolic rendering; the
  /// transmit panel uses it to offer a value-label dropdown.
  has_value_table?: boolean;
}

/// One `(raw_value, label)` row of a signal's `VAL_` table — mirrors
/// `cannet_dbc::ValueTableEntry`. Returned by `list_value_tables`.
export interface ValueTableEntryRecord {
  raw: number;
  label: string;
}

/// One signal's freshly-decoded points from `sample_signals`: parallel
/// `(t, v)` arrays, `t` in absolute seconds.
export interface SampledPoints {
  t: number[];
  v: number[];
}

/// Returned by `sample_signals`: one `SampledPoints` per requested
/// signal (same order), plus the sampled slice's first/last frame
/// timestamps (seconds) — `from_seconds` is the x-origin when
/// `from_index` is the trace window's start; both `null` when the
/// window is empty.
export interface SignalsSample {
  from_seconds: number | null;
  last_seconds: number | null;
  series: SampledPoints[];
  /** Host wall-clock spent in the lock-held trace-store slice (ms). */
  slice_ms: number;
  /** Host wall-clock spent decoding + decimating off the lock (ms). */
  decode_ms: number;
}
