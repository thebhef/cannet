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

/// One of the three binding kinds introduced in Phase 13 (ADR
/// 0021 / 0022):
///
/// - **`"remote"`** — a `(server, interface)` pair on a remote
///   `cannet-server` (or the local sidecar via the
///   {@link LOCAL_SERVER} sentinel). v5 entries default to this on
///   migration.
/// - **`"remote-virtual-bus"`** — subscribe to the factory id of a
///   remote virtual-bus server. The server allocates a participant
///   on `Subscribe`; the host uses the allocated id for tx.
/// - **`"local-virtual-bus"`** — bind to a virtual bus defined in
///   {@link Project.local_virtual_buses}. `server` carries the
///   `local-vbus://<vbus_id>` URL; `interface` is the canonical
///   {@link LOCAL_VBUS_INTERFACE}.
export type BindingKind =
  | "remote"
  | "remote-virtual-bus"
  | "local-virtual-bus";

/// URL scheme stored in {@link InterfaceBinding.server} for
/// `local-virtual-bus` bindings. The id following the scheme
/// references a {@link LocalVirtualBusDef.id}.
export const LOCAL_VBUS_URL_SCHEME = "local-vbus://";

/// Canonical {@link InterfaceBinding.interface} value for every
/// `local-virtual-bus` binding. A vbus has one conceptual interface
/// (the bus itself); multiple project buses bound to one vbus share
/// this interface name and rely on multi-subscriber fan-out.
export const LOCAL_VBUS_INTERFACE = "bus";

/// `vbus_id` extracted from a binding's `server` field if it carries
/// the `local-vbus://` URL scheme; `null` otherwise.
export function localVbusId(b: InterfaceBinding): string | null {
  return b.server.startsWith(LOCAL_VBUS_URL_SCHEME)
    ? b.server.slice(LOCAL_VBUS_URL_SCHEME.length)
    : null;
}

/// Construct a `local-virtual-bus` binding.
export function localVbusBinding(
  vbus_id: string,
  bus_id: string,
): InterfaceBinding {
  return {
    kind: "local-virtual-bus",
    server: `${LOCAL_VBUS_URL_SCHEME}${vbus_id}`,
    interface: LOCAL_VBUS_INTERFACE,
    bus_id,
  };
}

/// One bridge installed on a virtual bus. `remote_address` is the
/// bridged `cannet-server` ({@link LOCAL_SERVER} for the local
/// sidecar). `interface` is the wire id (or the factory id for a
/// virtual-bus target).
export interface BridgeSpec {
  remote_address: string;
  interface: string;
  name?: string;
}

/// A virtual bus owned by the project. Selectable as a binding
/// source in the project panel's interface combo. The host
/// instantiates one `SharedBus` per def on project open; bindings
/// reference it via the `local-vbus://<id>` URL stored in
/// {@link InterfaceBinding.server}. A vbus has no user-configurable
/// bitrate — it's in-process, not a model of a real wire.
export interface LocalVirtualBusDef {
  /// Stable project-local id, used in the binding's
  /// `local-vbus://<id>` URL and as the host's registry key.
  id: string;
  /// User-facing label.
  name: string;
  /// Bridges installed on the virtual bus.
  bridges?: BridgeSpec[];
}

/// An interface → bus binding (ADR 0023). Every binding is a uniform
/// `(server, interface, bus_id)` triple regardless of what's on the
/// other end. The {@link kind} discriminator is a hint about which
/// backend the host should pick; the effective dispatch is by the
/// URL scheme on {@link server}:
///
/// - `host:port` / {@link LOCAL_SERVER} → remote `cannet-server`
///   (`kind: "remote"` or `"remote-virtual-bus"`).
/// - `local-vbus://<vbus_id>` → in-process virtual bus
///   ({@link LocalVirtualBusDef}; `kind: "local-virtual-bus"`).
export interface InterfaceBinding {
  /// Discriminator. Absent on v5 files; the host defaults it to
  /// `"remote"` during the v5 → v6 migration. Always present on
  /// files saved by a Phase-13+ build.
  kind?: BindingKind;
  server: string;
  interface: string;
  bus_id: string;
}

/// Convenience: read the binding's effective kind, treating
/// `undefined` as `"remote"` (the v5 → v6 default).
export function bindingKind(b: InterfaceBinding): BindingKind {
  return b.kind ?? "remote";
}

/// Sentinel `server` value for a binding routed through the local
/// sidecar. The sidecar's listen port is randomised per launch, so
/// persisting a literal `host:port` would orphan the binding on every
/// project reload; persisting this sentinel decouples it from the
/// session's port. Code paths that need to actually reach the sidecar
/// (discovery polling, Tauri commands) resolve the sentinel to the
/// live address via {@link resolveServer}.
export const LOCAL_SERVER = "local";

/// True if the binding points at the local sidecar (regardless of
/// what port the sidecar is on this session).
export function isLocalBinding(b: InterfaceBinding): boolean {
  return b.server === LOCAL_SERVER;
}

/// Resolve a binding's `server` to the address discovery / Tauri
/// commands should use. {@link LOCAL_SERVER} becomes the live sidecar
/// address (or `null` if the sidecar isn't ready); any other value is
/// already a concrete address and passes through unchanged.
export function resolveServer(
  server: string,
  sidecarAddress: string | null,
): string | null {
  return server === LOCAL_SERVER ? sidecarAddress : server;
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
  | { kind: "transmit"; id: string; sinks: string[]; frameIds: string[] }
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

/// Manual (send-on-demand) vs periodic (cyclic) send mode for a TX
/// message. Mirrors host `transmit_frames::TransmitMode`. Persisted with
/// the message — distinct from whether a periodic is *running*.
export type TransmitMode = "manual" | "periodic";

/// The frame definition carried by a TX message. Mirrors host
/// `ipc::TransmitRequest` (camelCase on the wire). `busId` is the
/// destination logical bus (empty string when no bus is picked yet);
/// `data` is the raw payload (empty for `remote` / `error`).
export interface TransmitRequestRecord {
  busId: string;
  id: number;
  extended: boolean;
  kind: "classic" | "fd" | "remote" | "error";
  data: number[];
  brs: boolean;
  esi: boolean;
  dlc: number;
}

/// One TX message in the host pool, returned by `list_transmit_frames`.
/// Mirrors host `transmit_frames::TransmitFrameView`. `running` is
/// runtime-only (a live periodic thread); everything else persists in
/// `Project.transmit_frames`. The displayed *name* is the DBC message
/// name resolved from `request.id`; `description` is an optional user
/// annotation.
export interface TransmitFrameRecord {
  id: string;
  description: string;
  request: TransmitRequestRecord;
  cycleMs: number;
  mode: TransmitMode;
  running: boolean;
}

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
  /// Phase 13: in-process virtual buses (ADR 0021). Bindings with
  /// `kind = local-virtual-bus` reference one by id.
  local_virtual_buses?: LocalVirtualBusDef[];
}

export const PROJECT_SCHEMA_VERSION = 7;

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

/// One loaded DBC's full discovery-shaped content, as returned by the
/// `list_dbc_content` Tauri command. The DBC panel (Phase 12) groups
/// the tree by file using `dbcPath` as the React key. `messages` is
/// sorted by `(extended, messageId)`; signals within a message stay
/// in `SG_` declared order. Mirrors `ipc::DbcContentRecord`.
export interface DbcContentRecord {
  dbcPath: string;
  messages: DbcMessageContentRecord[];
}

/// One message row inside a [`DbcContentRecord`]. Every text field
/// is inlined so the fuzzy matcher (Phase 12 picks `fzf-for-js`) has
/// no lookups to do on its own. The layout / FD / mux metadata
/// powers the discovery panel's per-message detail view.
export interface DbcMessageContentRecord {
  messageId: number;
  extended: boolean;
  name: string;
  /// Empty when the DBC has no `CM_ BO_` comment for this message
  /// — empty, not absent, so the search has no nil case.
  comment: string;
  /// `BO_` declared payload length in bytes.
  expectedLen: number;
  /// CAN-FD message? (`VFrameFormat` 14/15, or `expectedLen > 8`
  /// fallback.)
  isFd: boolean;
  /// CAN-FD BRS — false on classic frames.
  brs: boolean;
  /// True when any signal uses nested / extended multiplexing.
  usesExtendedMux: boolean;
  attributes: DbcAttributeRecord[];
  signals: DbcSignalContentRecord[];
}

/// One signal row inside a [`DbcMessageContentRecord`]. Kept in
/// `SG_` declared order — matches the DBC author's bit-layout
/// intent. Carries every per-signal field the discovery panel
/// needs to display (bit layout, scale, range, mux, float kind,
/// attributes, value table, comment).
export interface DbcSignalContentRecord {
  name: string;
  unit: string;
  comment: string;
  /// First bit of the signal in the payload.
  startBit: number;
  /// Width in bits (1..=64).
  length: number;
  /// `little` (Intel) or `big` (Motorola).
  byteOrder: "little" | "big";
  signed: boolean;
  /// `physical = raw * factor + offset`.
  factor: number;
  offset: number;
  /// DBC-declared physical range. `min === max` indicates the DBC
  /// declared `[0|0]` (no constraint); the renderer should fall
  /// back to a `factor / offset / length / signed` derivation.
  min: number;
  max: number;
  /// Multiplexor / multiplexed-arm marker.
  mux: DbcSignalMux;
  /// `integer` / `float32` / `float64` (from `SIG_VALTYPE_`).
  floatKind: "integer" | "float32" | "float64";
  attributes: DbcAttributeRecord[];
  /// `VAL_` table rows in raw-ascending order. Empty when the signal
  /// has no value table.
  valueTable: ValueTableEntryRecord[];
}

/// Mux marker for a DBC signal. Mirrors the host's `SignalMuxRecord`
/// — same `{kind, selector?}` shape as the transmit panel uses.
export type DbcSignalMux =
  | { kind: "plain" }
  | { kind: "multiplexor" }
  | { kind: "multiplexed"; selector: number }
  | { kind: "multiplexor_and_multiplexed"; selector: number };

/// One `BA_ "<name>" … <value>` attribute pair, stringified on the
/// host so both display and fuzzy search work without per-variant
/// special-casing on the frontend.
export interface DbcAttributeRecord {
  name: string;
  value: string;
}

/// One signal edit passed to the `encode_frame` Tauri command: the DBC
/// signal name and the physical value the user typed. The host walks
/// the entries in order and partial-encodes each into the supplied
/// payload — bits the named signal covers are overwritten, every
/// other bit is preserved.
export interface EncodeFrameSignal {
  name: string;
  physical: number;
}

/// Response from `encode_frame`. `bytes` is the partial-encoded
/// payload (one entry per byte, 0–255). `skipped` carries any signal
/// the encoder couldn't place — in normal use this stays empty
/// because the panel only passes signal names it just listed via
/// `list_signals`.
export interface EncodeFrameResponse {
  bytes: number[];
  skipped: EncodeFrameSkipped[];
}

export interface EncodeFrameSkipped {
  name: string;
  /// `signal_not_found` | `base_too_short` | `size_out_of_range`.
  reason: string;
}

/// Rich descriptor for one DBC message — what the transmit panel
/// needs to render its signals table. Returned by `describe_message`;
/// `null` when no loaded DBC matches the requested id.
export interface MessageDescriptorRecord {
  name: string;
  expectedLen: number;
  /// `true` when the DBC marks this as a CAN-FD message
  /// (`VFrameFormat` = 14/15, or `expectedLen > 8` as fallback). The
  /// transmit panel mirrors this onto the frame's `kind`.
  isFd: boolean;
  /// CAN-FD BRS, `true` for FD messages by default unless the DBC's
  /// `GenMsgCANFDBRS` attribute sets it to 0. Always `false` on
  /// classic messages.
  brs: boolean;
  /// The DBC's `GenMsgCycleTime` attribute in milliseconds, or `null`
  /// when absent. The transmit panel pre-fills a message's cycle
  /// period from this when the message is added from the DBC.
  genMsgCycleTimeMs: number | null;
  /// `true` iff any signal uses nested / extended multiplexing
  /// (`m<N>M`). The transmit panel falls back to bytes-only editing
  /// in that case.
  usesExtendedMux: boolean;
  signals: SignalDescriptorRichRecord[];
}

export interface SignalDescriptorRichRecord {
  name: string;
  unit: string;
  factor: number;
  offset: number;
  /// DBC `SG_` declared min. When `min === max` the DBC didn't set a
  /// useful range — the panel derives a fallback from
  /// `factor / offset / size / signed`.
  min: number;
  max: number;
  size: number;
  signed: boolean;
  mux: SignalMuxRecord;
  floatKind: "integer" | "float32" | "float64";
  hasValueTable: boolean;
}

export type SignalMuxRecord =
  | { kind: "plain" }
  | { kind: "multiplexor" }
  | { kind: "multiplexed"; selector: number }
  | { kind: "multiplexor_and_multiplexed"; selector: number };

/// Decoded signals for a hypothetical (panel-side) frame — returned
/// by `decode_frame`. Empty signals on `null` (no DBC match).
export interface DecodedFrameRecord {
  name: string;
  signals: SignalRecord[];
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
