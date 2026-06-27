// Mirrors the Rust shapes in src-tauri/src/ipc.rs. Kept manually in sync
// because the two surfaces are small enough that a code generator would
// be more friction than benefit at this scale.

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
  /// Logical bus id this frame was routed onto, if any.
  /// `undefined` / `null` means "unassigned" — the per-bus DBC scoping
  /// and the filter `{bus}` predicate both reject those.
  bus_id?: string | null;
  /// Ingest-time verification finding (`"crc"` / `"counter"` /
  /// `"truncated"`), if any — flagged rows render red (ADR 0027).
  violation?: string | null;
}

/// Periodic IPC event carrying the trace store's current size + rate,
/// plus a short decoded tail of the newest frames so the auto-scrolling
/// trace view can paint the live edge without a fetch round-trip.
export interface TraceGrew {
  count: number;
  frames_per_second: number;
  /// Per-bus frame-rate breakdown (`bus_id: null` is the unassigned
  /// bucket). Used by the diagnostic logging to localise a slowdown to a
  /// specific bus on a multi-bus stream.
  frames_per_second_by_bus: { bus_id: string | null; frames_per_second: number }[];
  /// Cumulative frames dropped by the session-start guard.
  frames_dropped_before_session: number;
  /// Session-start timestamp (Unix epoch seconds, fractional). The
  /// trace view subtracts this from frame timestamps to render relative
  /// time, so every frame in a session shares one stable zero. Zero
  /// before any session has been configured.
  session_start_seconds: number;
  /// Wall-clock span of the buffered frames in seconds (newest − oldest
  /// timestamp). Shown in the status line; zero when fewer than two
  /// frames are buffered.
  buffer_seconds: number;
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
  /// Logical bus ids this DBC is scoped to. Empty / absent =
  /// unscoped (applies to all buses).
  buses?: string[];
}

/// One logical bus the project owns. `id` is stable across
/// renames and what the graph view / per-DBC scoping / filter
/// predicates reference. Mirrors `src-tauri/src/project.rs::Bus`.
export interface Bus {
  id: string;
  name: string;
  /// Nominal (arbitration-phase) bitrate in bits/s. Pushed to the
  /// sidecar on connect via `ConfigureBus`. Common values: 125_000,
  /// 250_000, 500_000, 1_000_000.
  speed_bps?: number | null;
  /// Whether the underlying controller should be opened in CAN FD
  /// mode. When unset (or false) the sidecar opens classic-only and
  /// `fd_data_speed_bps` is ignored.
  fd?: boolean | null;
  /// FD data-phase bitrate in bits/s (only meaningful when `fd` is
  /// true). Common values: 1_000_000, 2_000_000, 4_000_000, 5_000_000.
  fd_data_speed_bps?: number | null;
  /// User-chosen colour (CSS hex, `#rrggbb`) for the bus across the
  /// graph view — its node tint and every wire that carries it.
  /// Optional: a bus saved before the colour field, or never edited,
  /// falls back to a palette colour derived from its list position.
  color?: string | null;
}

/// One of the three binding kinds (ADR 0021 / 0022):
///
/// - **`"remote"`** — a `(server, interface)` pair on a remote
///   `cannet-server` (or the local sidecar via the
///   {@link LOCAL_SERVER} sentinel). The default kind.
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
  /// Discriminator. Always written by the current build; defaults to
  /// `"remote"` when absent.
  kind?: BindingKind;
  server: string;
  interface: string;
  bus_id: string;
}

/// Convenience: read the binding's effective kind, treating
/// `undefined` as `"remote"` (the default kind).
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

/// A loaded DBC reference + its bus scoping. An empty `buses` is the
/// "all buses" default.
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
/// an arbitration id's latest frame, its current message rate
/// (frames/second), and the total number of frames seen for the id over
/// the session.
export interface ByIdSnapshotRecord {
  frame: TraceFrameRecord;
  rate: number;
  count: number;
}

/// One element of a project: a discriminated-union record with a stable
/// `id`. `trace` = a trace panel; `plot` = a signal-plot panel (also
/// backed by a trace-style session window, but a distinct kind so the
/// project view and panel-reopen treat it as a plot, not a trace);
/// `transmit` = a transmit panel composing CAN frames;
/// `filter` = a filter element (structured predicate +
/// upstream sources). A view-backed element (trace / plot) carries its
/// panel's setup in {@link PanelViewConfig} `config` — a trace's mode +
/// columns, a plot's areas / cursors. That's model state, so it survives
/// closing and reopening the panel within a session, not only a project
/// save/restore. The panel also mirrors the same blob into its dockview
/// `params` so the unsaved-workspace `localStorage` layout — which does
/// not persist the registry — can restore it across an app restart. A
/// transmit's frame list and an rbs's `.cannet_rbs` path live in their
/// own host-side stores, not in `config`.
///
/// Every kind carries a model-owned display `name` (ADR 0019),
/// resolved by `elementLabel` for every view. Optional in the type
/// only because elements are constructed/loaded incrementally; the
/// registry's `create` assigns a `${Kind} ${n}` default and
/// `assignDefaultNames` backfills on project open, so it's always
/// present in practice. Additive — no schema-version bump (the host
/// round-trips `elements` opaquely).
///
/// `sources` is every consumer's producer-selection list — bus ids or
/// upstream filter ids — with [`ALL_BUSES_WILDCARD`] (`"*"`) as the
/// wildcard meaning "every bus in the project, including buses added
/// later." The default for any freshly created consumer is
/// `["*"]`; an explicit list (e.g. `["b1","filter-3"]`) consumes
/// exactly those producers and future buses don't auto-flow. Older
/// projects saved a single `source?: string` field instead; the
/// loader normalises those to `sources: ["*"]` (`normalizeElement`).
/// One value→color rule in a {@link ProjectElement} `colormap`: an
/// inclusive raw-value range and the hex color to tint matching values
/// with. An enum value `v` is the degenerate range `[v, v]`. See ADR
/// 0029.
export interface ColorRule {
  min: number;
  max: number;
  color: string;
}

/// A view-backed element's persisted panel configuration: an opaque
/// blob the panel writes and reads, the model stores without
/// interpreting. Each panel owns its own keys and parses them
/// tolerantly (a plot's `areas` / `cursorX` / `measKeys` …, a trace's
/// `mode` / `columns` / `autoScroll`), so the shape is intentionally
/// `unknown`-valued here. It lives on the element (not just the dockview
/// `params`) so a view's setup survives closing and reopening its panel
/// within a session. Additive — the host round-trips `elements`
/// opaquely, so no schema-version bump.
export type PanelViewConfig = Record<string, unknown>;

export type ProjectElement =
  | { kind: "trace"; id: string; name?: string; sources: string[]; config?: PanelViewConfig }
  | { kind: "plot"; id: string; name?: string; sources: string[]; config?: PanelViewConfig }
  | {
      /// A standalone, ambient signal value→color map (ADR 0029): not a
      /// graph node, not wired through `sources`. Any view rendering the
      /// target signal tints its value cell by the matching rule.
      kind: "colormap";
      id: string;
      name?: string;
      /// Optional bus scope; null / absent matches the signal on any bus.
      busId?: string | null;
      /// Target signal: message arbitration id, std/ext, signal name.
      messageId: number;
      extended: boolean;
      signalName: string;
      rules: ColorRule[];
    }
  | {
      kind: "transmit";
      id: string;
      name?: string;
      sinks: string[];
      frameIds: string[];
    }
  | {
      kind: "filter";
      id: string;
      name?: string;
      sources: string[];
      predicate?: FilterPredicate | null;
    }
  | {
      kind: "rbs";
      id: string;
      name?: string;
      /// Path of the element's `.cannet_rbs` file. The project
      /// references the config by path and never embeds the content
      /// (ADR 0028); `null` until the user picks / creates one.
      path: string | null;
      /// The element's Run flag — persisted in the project, default
      /// off. A project saved with RBS running resumes transmitting
      /// on open once its bus connects (the global kill-switch is
      /// the guard rail).
      run: boolean;
    };

/// Wildcard entry in {@link ProjectElement.sources} / {@link
/// ProjectElement.sinks}: matches every bus in the project, current
/// and future. `["*"]` is the default for a freshly created consumer
/// (`sources`) and for a freshly created transmit (`sinks`).
export const ALL_BUSES_WILDCARD = "*";

/// Structured filter predicate. Mirrors
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
  /// Calculated-field override spec for this message (ADR 0027).
  /// Absent → the DBC's declared defaults apply per field.
  calc?: CalcFieldsSpec | null;
}

/// Calculated-fields spec — mirrors host `ipc::CalcFieldsSpec` and
/// the `.cannet_rbs` `counter` / `crc` objects (ADR 0028). Field
/// names stay snake_case: they're part of the human-edited file
/// format.
export interface CalcFieldsSpec {
  counter?: CounterSpec | null;
  crc?: CrcSpec | null;
}

export interface CounterSpec {
  signal: string;
  increment: number;
  rollover?: number | null;
}

/// Exactly one of `algorithm` (catalogue name) or the raw Rocksoft
/// fields (`width` + `poly` required). `poly` / `init` / `xorout`
/// accept numbers or `0x…` strings and serialize as hex strings.
export interface CrcSpec {
  signal: string;
  algorithm?: string | null;
  width?: number | null;
  poly?: number | string | null;
  init?: number | string | null;
  refin?: boolean | null;
  refout?: boolean | null;
  xorout?: number | string | null;
  /// `[start, length]` in bits — byte-aligned.
  range_bits: [number, number];
  /// Hex bytes prepended to the ranged data (E2E Data ID). Empty /
  /// absent = none.
  prefix?: string;
}

/// Mirrors `src-tauri/src/project.rs::Project` — the saved workspace.
/// `layout` (dockview's `SerializedDockview`) and `elements` are stored
/// by the host without interpretation, so they're typed loosely here
/// and validated before use (`dockLayout.ts::validateLayout`,
/// `projectElements.ts::isProjectElement`).
export interface Project {
  schema_version: number;
  layout: unknown;
  elements: unknown[];
  /// Logical buses. Empty for a freshly-created project.
  buses: Bus[];
  /// Interface → bus bindings (per remote server / sidecar).
  interface_bindings: InterfaceBinding[];
  /// Loaded DBCs in priority order, each with its bus scoping.
  dbcs: DbcRef[];
  remote_address: string | null;
  /// In-process virtual buses (ADR 0021). Bindings with
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
/// `list_dbc_content` Tauri command. The DBC panel groups
/// the tree by file using `dbcPath` as the React key. `messages` is
/// sorted by `(extended, messageId)`; signals within a message stay
/// in `SG_` declared order. Mirrors `ipc::DbcContentRecord`.
export interface DbcContentRecord {
  dbcPath: string;
  messages: DbcMessageContentRecord[];
}

/// One message row inside a [`DbcContentRecord`]. Every text field
/// is inlined so the fuzzy matcher (`fzf-for-js`) has
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
  /// The DBC's `GenMsgSendType` resolved to its label, or `null`.
  genMsgSendType: string | null;
  /// `true` iff any signal uses nested / extended multiplexing
  /// (`m<N>M`). The transmit panel falls back to bytes-only editing
  /// in that case.
  usesExtendedMux: boolean;
  /// The DBC-declared calculated-field designation (`CannetCounter` /
  /// `CannetCrc` — ADR 0027), or `null` when none. The default layer
  /// under any per-message override.
  calcFields: CalcFieldsSpec | null;
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
  /// The DBC's `GenSigStartValue` (raw units, verbatim), or `null`.
  /// Physical default = `raw * factor + offset`.
  startValueRaw?: number | null;
}

/// One RBS panel's whole tree, as assembled by the host's `rbs_view`
/// command (ADR 0028): the file's buses overlaid on each resolved
/// bus's DBC content, grouped per transmitter ECU.
export interface RbsView {
  elementId: string;
  /// `null` until the config is first saved.
  path: string | null;
  fillBit: number;
  dirty: boolean;
  run: boolean;
  killSwitch: boolean;
  buses: RbsBusView[];
}

export interface RbsBusView {
  /// The file's key — a project logical-bus *name*.
  key: string;
  /// Resolved project bus id; `null` renders the subtree inert.
  busId: string | null;
  /// Whether an active session currently routes this bus.
  connected: boolean;
  enabled: boolean;
  ecus: RbsEcuView[];
}

export interface RbsEcuView {
  name: string;
  enabled: boolean;
  messages: RbsMessageView[];
}

export interface RbsMessageView {
  /// The file key form (`0x…`, trailing `x` = extended).
  key: string;
  messageId: number;
  extended: boolean;
  /// DBC message name; `null` = file-listed but unknown to the DBC.
  name: string | null;
  /// Whether the file lists this message.
  inFile: boolean;
  enabled: boolean;
  /// Scheduled right now (run && enables && !kill-switch).
  running: boolean;
  /// Effective period (override else `GenMsgCycleTime`); `null` =
  /// none anywhere, the message can't run.
  periodMs: number | null;
  periodOverridden: boolean;
  isFd: boolean;
  expectedLen: number;
  /// Current payload buffer bytes.
  data: number[];
  counter: CounterSpec | null;
  counterOverridden: boolean;
  crc: CrcSpec | null;
  crcOverridden: boolean;
  /// DBC transmitter when it disagrees with the file's ECU placement.
  transmitterMismatch: string | null;
  signals: RbsSignalView[];
}

export interface RbsSignalView {
  name: string;
  unit: string;
  /// Decoded physical value from the current buffer (`null` for an
  /// inactive multiplexed arm).
  value: number | null;
  /// `VAL_` label for the decoded value, if any.
  label: string | null;
  overridden: boolean;
  /// The override as written in the file (number rendered, or the
  /// raw string).
  overrideText: string | null;
  /// `"counter"` / `"crc"` when this signal is a calculated field's
  /// destination — its value cell renders read-only.
  calcRole: "counter" | "crc" | null;
  factor: number;
  offset: number;
  min: number;
  max: number;
  size: number;
  signed: boolean;
  floatKind: "integer" | "float32" | "float64";
  hasValueTable: boolean;
}

/// One dirty RBS element (unsaved override edits) — `rbs_dirty`.
export interface RbsDirtyRecord {
  elementId: string;
  /// `null` = never saved; Save All prompts for a path.
  path: string | null;
}

/// Per-(bus, id) calculated-field validity — `fetch_field_validity`.
export interface FieldValidityRecord {
  busId: string | null;
  id: number;
  extended: boolean;
  valid: boolean;
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

/// Severity of a {@link SystemMessage}. The frontend's
/// minimum-level filter compares two levels by `SYSTEM_LOG_LEVEL_RANK`
/// — see `systemLog.ts`.
export type SystemLogLevel = "info" | "warn" | "error";

/// One entry on the host's structured log bus. Mirrors
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
