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
/// `id`. Now only traces; plots, transmit messages, filters etc. become
/// new `kind`s. A trace element carries no extra config — the panel
/// showing it owns its mode (chronological / by-id) and column layout
/// in the dockview panel `params`.
export type ProjectElement = {
  kind: "trace";
  id: string;
};

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
