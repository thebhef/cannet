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
  /// Logical bus id this frame was routed onto (Phase 6), if any.
  /// `undefined` / `null` means "unassigned" — the per-bus DBC scoping
  /// and the filter `{bus}` predicate both reject those.
  bus_id?: string | null;
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
  /// Logical bus ids this DBC is scoped to (Phase 6). Empty / absent =
  /// unscoped (applies to all buses).
  buses?: string[];
}

/// One logical bus the project owns (Phase 6). `id` is stable across
/// renames and what the graph view / per-DBC scoping / filter
/// predicates reference. Mirrors `src-tauri/src/project.rs::Bus`.
export interface Bus {
  id: string;
  name: string;
  speed_bps?: number | null;
  fd?: boolean | null;
  /// User-chosen colour (CSS hex, `#rrggbb`) for the bus across the
  /// graph view — its node tint and every wire that carries it.
  /// Optional: a bus saved before the colour field, or never edited,
  /// falls back to a palette colour derived from its list position.
  color?: string | null;
}

/// An interface → bus binding (Phase 6). `server` is the remote
/// address (or a sidecar prefix later); `interface` matches the
/// wire-level `Interface.id`.
export interface InterfaceBinding {
  server: string;
  interface: string;
  bus_id: string;
}

/// A loaded DBC reference + its bus scoping (Phase 6). Replaces the v2
/// `dbc_paths` entry on `Project`; an empty `buses` is the "all buses"
/// default.
export interface DbcRef {
  path: string;
  buses: string[];
}

export interface InterfaceRecord {
  id: string;
  display_name: string;
  fd_capable: boolean;
}

/// Coarse lifecycle of the auto-launched python-can sidecar. Mirrors
/// `src-tauri/src/sidecar.rs::SidecarPhase`. The connection panel
/// uses this to label its "Local sidecar" row — "Starting…",
/// "Listening on 127.0.0.1:43891", "Offline" — and decide whether
/// the user can bind interfaces against it without typing an address.
export type SidecarPhase = "offline" | "starting" | "ready";

/// Snapshot of the sidecar's state — see {@link SidecarPhase}.
/// Returned by the `get_sidecar_status` Tauri command and the payload
/// of the `sidecar-status-changed` event. `address` is the bound
/// `host:port` once the sidecar reports `listening`; `null` otherwise.
export interface SidecarStatus {
  phase: SidecarPhase;
  address: string | null;
}

/// Event name the Tauri host emits whenever the sidecar's phase or
/// bound address changes. Frontend subscribers re-fetch with
/// `get_sidecar_status` and re-render. Must match
/// `sidecar.rs::STATUS_EVENT`.
export const SIDECAR_STATUS_EVENT = "sidecar-status-changed";

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
/// `transmit` = a Phase-5 transmit panel composing CAN frames;
/// `filter` = a Phase-6 filter element (structured predicate +
/// upstream sources). The element itself carries no extra config beyond
/// what's listed below — the panel showing it owns its config (a
/// trace's mode + columns, a plot's areas / cursors, a transmit
/// panel's frame list) in the dockview panel `params`.
///
/// `sources` is every consumer's producer-selection list — bus ids or
/// upstream filter ids — with [`ALL_BUSES_WILDCARD`] (`"*"`) as the
/// wildcard meaning "every bus in the project, including buses added
/// later." The default for any freshly created consumer is
/// `["*"]`; an explicit list (e.g. `["b1","filter-3"]`) consumes
/// exactly those producers and future buses don't auto-flow. Older
/// projects saved a single `source?: string` field instead; the
/// loader normalises those to `sources: ["*"]` (`normalizeElement`).
export type ProjectElement =
  | { kind: "trace"; id: string; sources: string[] }
  | { kind: "plot"; id: string; sources: string[] }
  | { kind: "transmit"; id: string; sinks: string[] }
  | {
      kind: "filter";
      id: string;
      name?: string;
      sources: string[];
      predicate?: FilterPredicate | null;
    };

/// Wildcard entry in {@link ProjectElement.sources} / {@link
/// ProjectElement.sinks}: matches every bus in the project, current
/// and future. `["*"]` is the default for a freshly created consumer
/// (`sources`) and for a freshly created transmit (`sinks`).
export const ALL_BUSES_WILDCARD = "*";

/// Structured filter predicate (Phase 6). Mirrors
/// `src-tauri/src/filter.rs::FilterPredicate`. The frontend's filter-
/// node UI builds this directly; the host evaluates it.
export type FilterPredicate =
  | { all: FilterPredicate[] }
  | { any: FilterPredicate[] }
  | { bus: string }
  | { id_range: [number, number] }
  | { id_list: number[] }
  | { name_regex: string }
  | { signal_equals: { name: string; value: number } };

/// The discriminant of a {@link ProjectElement}.
export type ProjectElementKind = ProjectElement["kind"];

/// Mirrors `src-tauri/src/project.rs::Project` — the saved workspace.
/// `layout` (dockview's `SerializedDockview`) and `elements` are stored
/// by the host without interpretation, so they're typed loosely here
/// and validated before use (`dockLayout.ts::validateLayout`,
/// `projectElements.ts::isProjectElement`). Phase 6 grew the schema
/// with `buses`, `interface_bindings`, and per-DBC `dbcs` scoping
/// (the v2 `dbc_paths` list is migrated host-side on parse — see
/// `project.rs::migrate_v2`).
export interface Project {
  schema_version: number;
  layout: unknown;
  elements: unknown[];
  /// Phase 6: logical buses. Empty for a freshly-created or migrated v2 project.
  buses: Bus[];
  /// Phase 6: interface → bus bindings (per remote server / sidecar).
  interface_bindings: InterfaceBinding[];
  /// Phase 6: loaded DBCs in priority order, each with its bus
  /// scoping. Replaces the v2 `dbc_paths` list.
  dbcs: DbcRef[];
  remote_address: string | null;
}

export const PROJECT_SCHEMA_VERSION = 3;

/// One `(bus, message, signal)` triple the attached DBCs define,
/// returned by the `list_signals` command for a plot panel's signal
/// picker. The same signal on two different buses is two separate
/// records — `bus_id` disambiguates them so the picker can offer one
/// per bus and the host samples the right per-bus slice. `bus_id` is
/// `null` only when no project bus is configured *and* the DBC is
/// unscoped (degenerate "any bus" path).
export interface SignalDescriptorRecord {
  bus_id: string | null;
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

/// Severity of a {@link SystemMessage} (Phase 7). The frontend's
/// minimum-level filter compares two levels by `SYSTEM_LOG_LEVEL_RANK`
/// — see `systemLog.ts`.
export type SystemLogLevel = "info" | "warn" | "error";

/// One entry on the host's structured log bus (Phase 7). Mirrors
/// `src-tauri/src/system_log.rs::SystemMessage`. `seq` is monotonic
/// across the session (it does not reset when the ring rolls or is
/// cleared); the frontend uses it to deduplicate against in-flight
/// `system-log-appended` events.
export interface SystemMessage {
  seq: number;
  ts_ms: number;
  source: string;
  level: SystemLogLevel;
  message: string;
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
