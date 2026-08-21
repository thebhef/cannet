//! DBC commands and decode helpers.
//!
//! Loading / scoping / removing DBCs (`add_dbc` …), the DBC-content and
//! signal catalogs the discovery / picker panels read, per-signal value
//! tables, and the panel-side describe / encode / decode-frame surface —
//! plus the shared `decode_against` / `decode_raw_frame` helpers that
//! turn a raw frame into a decoded record against the loaded DBC set.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use cannet_core::CanId;
use cannet_dbc::{Database, DecodedSignal};

use crate::app_state::{invalidate_derived_caches, AppState, LoadedDbc};
use crate::ipc::{
    self, DbcAttributeRecord, DbcCollisionRecord, DbcContentRecord, DbcInfo,
    DbcMessageContentRecord, DbcSignalContentRecord, DecodedRecord, FileBackedContentRecord,
    SignalDescriptorRecord, SignalRecord, ValueTableEntryRecord,
};
use crate::trace_store::RawTraceFrame;
use crate::{filter, rbs, signal_snapshot};
use crate::{sys_error, sys_info, sys_warn};

/// The loaded-DBC list as IPC records (each one's path + message
/// count + bus scoping), in priority order. Returned from `add_dbc` /
/// `remove_dbc` / `set_dbc_buses` so the frontend always gets the
/// authoritative set after a change.
fn dbc_list(state: &AppState) -> Vec<DbcInfo> {
    state
        .databases()
        .iter()
        .map(|d| DbcInfo {
            dbc_path: d.path.clone(),
            message_count: d.db.message_count(),
            buses: d.buses.clone(),
        })
        .collect()
}

/// Tell every consumer of DBC-derived state that the loaded set
/// changed ([ADR 0053](../../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md)
/// §2): rebuild what the host rebuilds eagerly — RBS rows, calculated
/// -field resolutions, verification — then emit `dbc-changed`.
///
/// **Every** path that changes what the set decodes calls this, and
/// none of them emits by hand: add, reload in place, re-scope, remove,
/// clear, the filesystem watcher's reload, the capture-embedded
/// install. The caller has already invalidated at the point it mutated
/// (`invalidate_derived_caches`), so a consumer that reacts to the
/// event cannot read a cache the change has not reached.
///
/// `path` names the database that changed, or `"*"` when the whole set
/// did. It is news for the log, not a filter: a consumer re-asks the
/// host for whatever it renders rather than diffing the payload.
pub(crate) fn announce_dbc_change(app: &AppHandle, path: &str) {
    rbs::refresh_all_elements(app);
    let _ = app.emit("dbc-changed", path.to_owned());
}

/// What [`install_dbc`] did with one DBC source.
pub(crate) struct InstalledDbc {
    /// Whether a DBC of the same identity was already loaded, and this
    /// replaced it in place.
    pub reloaded: bool,
    /// Messages the parsed database defines.
    pub message_count: usize,
    /// Non-fatal attribute problems (malformed `CannetCounter` /
    /// `CannetCrc` values). The DBC still loaded.
    pub warnings: Vec<String>,
}

/// Parse `text` and put it in the loaded set under `path`, replacing any
/// DBC already loaded under that identity. The set is left untouched on
/// a parse error.
///
/// `path` is an *identity*, not necessarily a file: a database embedded
/// in a capture is loaded through here too, under an identity naming the
/// capture it came from ([ADR 0010](../../../docs/adr/0010-no-sidecar-files.md)
/// — the definitions are usable without extracting anything to disk).
/// Watching the filesystem is therefore the caller's business, not this
/// function's.
pub(crate) fn install_dbc(
    state: &AppState,
    path: &str,
    text: &str,
) -> Result<InstalledDbc, String> {
    let db = Database::parse(text).map_err(|e| format!("failed to parse DBC at {path}: {e}"))?;
    let warnings: Vec<String> = db
        .parse_warnings()
        .iter()
        .map(ToString::to_string)
        .collect();
    let message_count = db.message_count();
    let db = Arc::new(db);
    let mut list = state.databases();
    let reloaded = if let Some(slot) = list.iter_mut().find(|d| d.path == path) {
        slot.db = db;
        true
    } else {
        list.push(LoadedDbc {
            path: path.to_owned(),
            db,
            buses: Vec::new(),
        });
        false
    };
    drop(list);
    invalidate_derived_caches(state);
    Ok(InstalledDbc {
        reloaded,
        message_count,
        warnings,
    })
}

/// Load a DBC file and add it to the set (or, if a DBC with the same
/// path is already loaded, reload it in place — same effect as a
/// "reload from disk"). Returns the full loaded list on success; on a
/// read / parse error the set is left unchanged.
///
/// Emits `dbc`-tagged messages on the system log — `info` on
/// success (loaded or reloaded), `error` if the file can't be read or
/// the DBC can't be parsed.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn add_dbc(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<DbcInfo>, String> {
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            let msg = format!("failed to read DBC at {path}: {e}");
            sys_error!(&app, "dbc", "{msg}");
            return Err(msg);
        }
    };
    let installed = match install_dbc(state.inner(), &path, &text) {
        Ok(i) => i,
        Err(msg) => {
            sys_error!(&app, "dbc", "{msg}");
            return Err(msg);
        }
    };
    for w in &installed.warnings {
        sys_warn!(&app, "dbc", "{path}: {w}");
    }
    if installed.reloaded {
        sys_info!(&app, "dbc", "reloaded DBC {path}");
    } else {
        sys_info!(&app, "dbc", "loaded DBC {path}");
        // Start watching this file's parent dir for FS
        // events (only on first-load — a reload is already watched).
        if let Some(w) = state.dbc_watcher().as_mut() {
            w.watch_file(std::path::Path::new(&path));
        }
    }
    announce_dbc_change(&app, &path);
    Ok(dbc_list(state.inner()))
}

/// [`set_dbc_buses`]'s body without its `AppHandle`: replace the
/// assignment and re-judge everything derived from the set.
///
/// **Assignment is the cache lifecycle boundary**
/// ([ADR 0047](../../../docs/adr/0047-persisted-signal-pyramids.md)), and
/// it needs no machinery of its own. A bus change *is* a DBC-set change:
/// unassigning takes this database out of every candidate chain it was
/// in, so `invalidate_derived_caches` re-encodes the pyramids it decoded
/// and **parks** them; assigning puts those chains back, so the same call
/// **revives** every park whose fingerprint the restored chain answers
/// for, instead of decoding the capture a second time. What revives one
/// is the fingerprint, not the file it came from.
///
/// **Unassigning also stops what the database was driving.** Every
/// periodic still firing that no database assigned to its bus defines
/// any more is stopped, through the same path the user's own Stop takes
/// ([`crate::transmit_commands::stop_periodics_left_unbacked`]), and
/// their ids are returned so the caller can record the one system-log
/// entry that says so. The assignment change itself always proceeds: it
/// is a deliberate gesture, and refusing it would make assignment
/// conditional on the user first finding what is transmitting.
pub(crate) fn set_dbc_buses_inner(state: &AppState, path: &str, buses: Vec<String>) -> Vec<String> {
    let backed_before = crate::transmit_commands::dbc_backed_running_periodics(state);
    {
        let mut list = state.databases();
        if let Some(slot) = list.iter_mut().find(|d| d.path == path) {
            slot.buses = buses;
        }
    }
    invalidate_derived_caches(state);
    crate::transmit_commands::stop_periodics_left_unbacked(state, &backed_before)
}

/// [`remove_dbc`]'s body without its `AppHandle`. Removing a database
/// removes it from the buses it was assigned to and nothing more, so it
/// reaches [`set_dbc_buses_inner`]'s stop rule by the same route.
/// Returns the ids of the periodics it was driving, now stopped —
/// `None` when no DBC was loaded under this path.
///
/// It is also where a per-signal database pick naming this database is
/// dropped from the project — silently, because what is left is the
/// load-order default the signal had before anyone chose.
pub(crate) fn remove_dbc_inner(state: &AppState, path: &str) -> Option<Vec<String>> {
    let backed_before = crate::transmit_commands::dbc_backed_running_periodics(state);
    let removed = {
        let mut list = state.databases();
        let before = list.len();
        list.retain(|d| d.path != path);
        before != list.len()
    };
    if !removed {
        return None;
    }
    // A per-signal database pick naming this database has lost its
    // subject: drop it, silently, so the signal falls back to the
    // load-order default (`AppState::forget_dbc_picks`). Before the
    // invalidation below, so the pyramids are re-judged against the
    // model the pick no longer shortens.
    state.forget_dbc_picks(path);
    invalidate_derived_caches(state);
    Some(crate::transmit_commands::stop_periodics_left_unbacked(
        state,
        &backed_before,
    ))
}

/// Record, in **one** system-log entry, that an assignment change
/// stopped periodics that were firing. One line however many stopped:
/// no modal and no per-element notice.
fn log_periodics_stopped(app: &AppHandle, path: &str, stopped: &[String]) {
    if stopped.is_empty() {
        return;
    }
    sys_warn!(
        app,
        "dbc",
        "stopped {} running transmit(s) {path} was driving",
        stopped.len()
    );
}

/// Replace the bus assignment of a loaded DBC. An empty `buses`
/// assigns it to nothing, and a database assigned to nothing decodes
/// nothing ([`filter::dbc_applies`]). Unknown path is a no-op (returns
/// the unchanged list); the frontend's project state can drift if a DBC
/// is removed between the user clicking a checkbox and this command
/// firing.
///
/// This is also where a signal pyramid is parked or revived — see
/// [`set_dbc_buses_inner`].
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn set_dbc_buses(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    buses: Vec<String>,
) -> Vec<DbcInfo> {
    let stopped = set_dbc_buses_inner(state.inner(), &path, buses);
    // One line, however many stopped — then tell the open transmit
    // views, whose Run control is the state that just moved. RBS rows
    // stopped in the same call; the announcement below is what then
    // takes them out of the pool altogether, and it notifies the RBS
    // panel itself.
    log_periodics_stopped(&app, &path, &stopped);
    if !stopped.is_empty() {
        crate::transmit_commands::emit_transmit_frames_changed(&app);
    }
    announce_dbc_change(&app, &path);
    dbc_list(state.inner())
}

/// Remove the loaded DBC with this path (no-op if it isn't loaded).
/// Returns the remaining loaded list.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn remove_dbc(app: AppHandle, state: State<'_, AppState>, path: String) -> Vec<DbcInfo> {
    if let Some(stopped) = remove_dbc_inner(state.inner(), &path) {
        sys_info!(&app, "dbc", "removed DBC {path}");
        log_periodics_stopped(&app, &path, &stopped);
        if !stopped.is_empty() {
            crate::transmit_commands::emit_transmit_frames_changed(&app);
        }
        if let Some(w) = state.dbc_watcher().as_mut() {
            w.unwatch_file(std::path::Path::new(&path));
        }
        announce_dbc_change(&app, &path);
    }
    dbc_list(state.inner())
}

/// Unload every DBC (the "New project" reset, and the first half of an
/// "open project" — the project's DBCs are then re-added one by one).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn clear_dbcs(app: AppHandle, state: State<'_, AppState>) {
    let cleared: Vec<String> = {
        let mut list = state.databases();
        let paths = list.iter().map(|d| d.path.clone()).collect();
        list.clear();
        paths
    };
    if !cleared.is_empty() {
        sys_info!(&app, "dbc", "cleared {} loaded DBC(s)", cleared.len());
        invalidate_derived_caches(state.inner());
        // The whole set changed, so nothing names one database.
        announce_dbc_change(&app, "*");
    }
    // Unwatch the paths this actually unloaded, rather than dropping
    // every watch: the open project file rides on the same watch set
    // (`crate::project_watch`), and opening a project runs this command
    // first.
    if let Some(w) = state.dbc_watcher().as_mut() {
        for path in &cleared {
            w.unwatch_file(std::path::Path::new(path));
        }
    }
}
/// Decode a raw frame against the loaded DBCs, in order — the first
/// one that recognises the arbitration id wins. Skips any DBC not
/// assigned to the frame's bus ([`filter::dbc_applies`]), which
/// includes every DBC assigned to no bus at all. `None` if no DBC
/// decodes.
pub(crate) fn decode_against(dbs: &[LoadedDbc], frame: &RawTraceFrame) -> Option<DecodedRecord> {
    dbs.iter()
        .filter(|d| filter::dbc_applies(&d.buses, frame.bus_id.as_deref()))
        .find_map(|d| decode_raw_frame(&d.db, frame))
}
/// Every `(bus, message, signal)` triple the loaded DBCs define, for
/// a plot panel's signal picker. One record per matching project bus
/// per DBC signal — so a database produces one record per bus it is
/// **assigned to**, and one assigned to no bus produces none at all:
/// it decodes nothing, so it can name no row a frame could answer for.
/// Sorted by `(bus_id, message_id, signal_name)` and deduplicated on
/// that key.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn list_signals(state: State<'_, AppState>) -> Vec<SignalDescriptorRecord> {
    let dbs = state.databases();
    // Shared enumeration with `fetch_signal_page` (per-bus assignment
    // expansion + descriptor-key dedup), so the picker catalog and the
    // signal-view rows can't disagree about what exists.
    let mut out: Vec<SignalDescriptorRecord> = signal_snapshot::scoped_descriptors(
        dbs.iter().map(|l| (l.db.as_ref(), l.buses.as_slice())),
    )
    .into_iter()
    .map(|(bus_id, d)| SignalDescriptorRecord {
        bus_id,
        message_id: d.message_id,
        extended: d.extended,
        message_name: d.message_name,
        transmitter: d.transmitter,
        signal_name: d.signal_name,
        unit: d.unit,
        is_enum: d.is_enum,
        display_hex: d.display_hex,
        decimals: d.decimals,
        file_backed: false,
    })
    .collect();
    drop(dbs);
    // File-backed signals (`docs/CONTEXT.md`) are catalog entries like
    // any other series — the picker offers them, the plot draws them.
    // They come from the capture rather than from a DBC, so they are
    // appended here rather than enumerated by `scoped_descriptors`, and
    // they carry no bus, transmitter or value table.
    out.extend(
        state
            .signal_caches
            .file_signals()
            .into_iter()
            .map(signal_snapshot::file_backed_descriptor),
    );
    out
}

/// Snapshot the capture's **file-backed signals** (`docs/CONTEXT.md`)
/// for the Database view's per-file branches (ADR 0052): one record per
/// source file, each holding that file's signal channel groups and
/// their signals.
///
/// The twin of [`list_dbc_content`] for the other format the view
/// carries, and shaped the same way — the host arranges, the panel
/// renders. Empty whenever the open capture has no file-backed signals,
/// which is how the branches come and go with the capture rather than
/// with anything the project persists.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn list_file_backed_content(state: State<'_, AppState>) -> Vec<FileBackedContentRecord> {
    signal_snapshot::file_backed_content(state.signal_caches.file_signals())
}

/// Snapshot every loaded DBC's content for the DBC
/// discovery panel: one [`DbcContentRecord`] per loaded file, each
/// carrying the file path plus the tree the panel renders (messages
/// → signals + comments + attributes + value tables).
///
/// Unlike [`list_signals`], this is **not** expanded per bus —
/// scoping is a panel-side concern (the panel may show the same DBC
/// once, even when it's scoped to multiple buses) and re-expanding
/// here would multiply the payload. The DBC file path is the
/// frontend's grouping key.
///
/// Order matches the host's loaded-DBC list (priority order); the
/// `messages` list inside each record is sorted by
/// `(extended, message_id)`.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn list_dbc_content(state: State<'_, AppState>) -> Vec<DbcContentRecord> {
    let dbs = state.databases();
    dbs.iter()
        .map(|loaded| DbcContentRecord {
            dbc_path: loaded.path.clone(),
            messages: loaded
                .db
                .dbc_content()
                .into_iter()
                .map(message_record)
                .collect(),
        })
        .collect()
}

/// Duplicate-id collisions across the loaded set, for the Database
/// panel's warning: every `(bus, message id, extended, signal name)`
/// two or more assigned databases define, naming the database whose
/// signal wins today — the one the user chose for it in the
/// view-signal panel, or project load order where they have not. Detected host-side
/// ([`signal_snapshot::dbc_collisions`]) so the panel renders what the
/// host reports rather than re-scanning the loaded DBCs' contents in
/// JS.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn list_dbc_collisions(state: State<'_, AppState>) -> Vec<DbcCollisionRecord> {
    let dbs = state.databases();
    // Lock order: the DBC set before the picks, as `decode_model` takes
    // them. The picks decide who wins a collision the user has settled.
    let picks = state.picks_snapshot();
    signal_snapshot::dbc_collisions(
        dbs.iter()
            .map(|d| (d.path.as_str(), d.db.as_ref(), d.buses.as_slice())),
        &picks,
    )
    .into_iter()
    .map(|c| DbcCollisionRecord {
        bus_id: c.bus_id,
        message_id: c.message_id,
        extended: c.extended,
        signal_name: c.signal_name,
        winner_path: c.winner_path,
        loser_path: c.loser_path,
    })
    .collect()
}

fn message_record(m: cannet_dbc::DbcMessageContent) -> DbcMessageContentRecord {
    DbcMessageContentRecord {
        message_id: m.message_id,
        extended: m.extended,
        name: m.name,
        comment: m.comment,
        expected_len: m.expected_len,
        is_fd: m.is_fd,
        brs: m.brs,
        uses_extended_mux: m.uses_extended_mux,
        attributes: m.attributes.into_iter().map(attribute_record).collect(),
        transmitter: m.transmitter,
        signals: m.signals.into_iter().map(signal_record).collect(),
    }
}

/// Map a [`cannet_dbc::SignalMux`] to its wire record. Shared by the
/// discovery-tree ([`signal_record`]) and encoder-detail
/// ([`describe_message_inner`]) descriptor builders.
fn signal_mux_record(mux: cannet_dbc::SignalMux) -> ipc::SignalMuxRecord {
    match mux {
        cannet_dbc::SignalMux::Plain => ipc::SignalMuxRecord::Plain,
        cannet_dbc::SignalMux::Multiplexor => ipc::SignalMuxRecord::Multiplexor,
        cannet_dbc::SignalMux::Multiplexed { selector } => {
            ipc::SignalMuxRecord::Multiplexed { selector }
        }
        cannet_dbc::SignalMux::MultiplexorAndMultiplexed { selector } => {
            ipc::SignalMuxRecord::MultiplexorAndMultiplexed { selector }
        }
    }
}

/// Map a [`cannet_dbc::FloatKind`] to its wire tag. Shared by the two
/// descriptor builders (see [`signal_mux_record`]).
fn float_kind_str(float_kind: cannet_dbc::FloatKind) -> &'static str {
    match float_kind {
        cannet_dbc::FloatKind::Integer => "integer",
        cannet_dbc::FloatKind::Float32 => "float32",
        cannet_dbc::FloatKind::Float64 => "float64",
    }
}

fn signal_record(s: cannet_dbc::DbcSignalContent) -> DbcSignalContentRecord {
    DbcSignalContentRecord {
        name: s.name,
        unit: s.unit,
        comment: s.comment,
        start_bit: s.start_bit,
        length: s.length,
        byte_order: match s.byte_order {
            cannet_dbc::ByteOrder::Little => "little",
            cannet_dbc::ByteOrder::Big => "big",
        },
        signed: s.signed,
        factor: s.factor,
        offset: s.offset,
        min: s.min,
        max: s.max,
        mux: signal_mux_record(s.mux),
        float_kind: float_kind_str(s.float_kind),
        attributes: s.attributes.into_iter().map(attribute_record).collect(),
        value_table: s
            .value_table
            .into_iter()
            .map(|e| ValueTableEntryRecord {
                raw: e.raw,
                label: e.label,
            })
            .collect(),
    }
}

fn attribute_record(a: cannet_dbc::DbcAttribute) -> DbcAttributeRecord {
    DbcAttributeRecord {
        name: a.name,
        value: a.value,
    }
}
fn decode_raw_frame(db: &Database, frame: &RawTraceFrame) -> Option<DecodedRecord> {
    let id = CanId::new(frame.id, frame.extended).ok()?;
    let data = frame.payload.data();
    db.decode_raw(id, data).map(|m| DecodedRecord {
        name: m.name.to_string(),
        transmitter: m.transmitter.map(str::to_string),
        signals: m.signals.iter().map(signal_to_wire).collect(),
    })
}
/// Look up the full value table for one signal. Returns an empty vec
/// when the signal has none. The plot panel's symbolic y-axis ticks,
/// its enum lanes and the transmit panel's enum dropdown call this once
/// per signal — the table doesn't have to ride along on every decoded
/// frame.
///
/// `file_backed` says which namespace `message_id` is in, because the
/// two are unrelated numbers: for a DBC-backed signal it is a CAN id and
/// the `VAL_` table is looked up across the databases `bus_id` admits
/// (see [`list_value_tables_inner`]); for a file-backed one it is the
/// source file's signal channel group index and the table is the one the
/// channel's own conversion carried in (see
/// [`crate::signal_cache::SignalCacheStore::file_signal_value_table`]).
/// One command either way, so a view labels both kinds of enum the same
/// way.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn list_value_tables(
    state: State<'_, AppState>,
    message_id: u32,
    extended: bool,
    signal_name: String,
    file_backed: bool,
    bus_id: Option<String>,
) -> Vec<ipc::ValueTableEntryRecord> {
    list_value_tables_inner(
        state.inner(),
        message_id,
        extended,
        &signal_name,
        file_backed,
        bus_id.as_deref(),
    )
}

/// [`list_value_tables`]'s testable body.
///
/// `bus_id` scopes the DBC-backed branch exactly the way decode does:
/// the labels come from the databases `filter::dbc_applies` admits for
/// that bus, first-match-wins within that set, so a lane's labels can
/// only ever come from a database that could have decoded it. A lookup
/// naming no bus therefore resolves through nothing — every frame has a
/// bus, so a DBC-backed series is never in the "bus unknown" state the
/// old fall-back-to-every-database answer was guessing for. The
/// file-backed branch is unaffected — no DBC bears on a file-backed
/// series.
pub(crate) fn list_value_tables_inner(
    state: &AppState,
    message_id: u32,
    extended: bool,
    signal_name: &str,
    file_backed: bool,
    bus_id: Option<&str>,
) -> Vec<ipc::ValueTableEntryRecord> {
    if file_backed {
        return state
            .signal_caches
            .file_signal_value_table(message_id, signal_name);
    }
    state
        .databases()
        .iter()
        .filter(|d| filter::dbc_applies(&d.buses, bus_id))
        .find_map(|d| {
            d.db.value_table_for_signal(message_id, extended, signal_name)
                .map(|rows| {
                    rows.iter()
                        .map(|e| ipc::ValueTableEntryRecord {
                            raw: e.raw,
                            label: e.label.clone(),
                        })
                        .collect()
                })
        })
        .unwrap_or_default()
}

/// Run a batch of signal edits through
/// [`cannet_dbc::Database::encode_frame`] against the first database
/// **assigned to `bus_id`** that claims the `(message_id, extended)`
/// pair — the same set that would decode the frame once it is on that
/// bus. Returns the updated payload bytes plus any signals the encoder
/// couldn't place.
///
/// The transmit panel calls this on every signal-table edit: it passes
/// the current `dataHex` (decoded to bytes) and the signal that
/// changed; the host returns the new bytes which the panel writes back
/// into `dataHex`. Partial encode means an unrelated signal in the
/// same payload (or a non-DBC-mapped byte — CRC, sequence count,
/// padding) is preserved across the call.
///
/// Returns `Err` only on infrastructure faults (mutex poisoned, no
/// DBC matches the id). A signal name with no match on the resolved
/// message lands in the `skipped` list instead — same shape as a
/// successful response. The frontend treats "no DBC matches" as
/// "stay in raw-bytes mode."
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn encode_frame(
    state: State<'_, AppState>,
    bus_id: Option<String>,
    message_id: u32,
    extended: bool,
    signals: Vec<ipc::EncodeFrameSignal>,
    base: Vec<u8>,
) -> Result<ipc::EncodeFrameResponse, String> {
    encode_frame_inner(
        state.inner(),
        bus_id.as_deref(),
        message_id,
        extended,
        &signals,
        base,
    )
}

/// Return the rich descriptor for one DBC message (signals, range,
/// mux indicator, …) — what the transmit panel needs to render the
/// signals table without reimplementing DBC walking on the frontend.
///
/// `bus_id` is the bus the row transmits on, and scopes the lookup the
/// same way decode is scoped: only databases assigned to that bus may
/// answer, so a row on no bus — or one whose bus has no database
/// assigned — describes nothing. Returns `None` if no such DBC matches
/// the id.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn describe_message(
    state: State<'_, AppState>,
    bus_id: Option<String>,
    message_id: u32,
    extended: bool,
) -> Option<ipc::MessageDescriptorRecord> {
    describe_message_inner(state.inner(), bus_id.as_deref(), message_id, extended)
}

pub(crate) fn describe_message_inner(
    state: &AppState,
    bus_id: Option<&str>,
    message_id: u32,
    extended: bool,
) -> Option<ipc::MessageDescriptorRecord> {
    let id = cannet_core::CanId::new(message_id, extended).ok()?;
    state.first_dbc_on_bus(bus_id, |db| {
        db.describe_message(id).map(|desc| {
            let signals: Vec<ipc::SignalDescriptorRichRecord> = desc
                .signals
                .into_iter()
                .map(|s| ipc::SignalDescriptorRichRecord {
                    name: s.name,
                    unit: s.unit,
                    factor: s.factor,
                    offset: s.offset,
                    min: s.min,
                    max: s.max,
                    size: s.size,
                    signed: s.signed,
                    mux: signal_mux_record(s.mux),
                    float_kind: float_kind_str(s.float_kind),
                    has_value_table: s.has_value_table,
                    start_value_raw: s.start_value_raw,
                })
                .collect();
            let calc_fields = if desc.calc_fields.is_empty() {
                None
            } else {
                Some(ipc::CalcFieldsSpec::from_config(&desc.calc_fields))
            };
            ipc::MessageDescriptorRecord {
                name: desc.name,
                expected_len: desc.expected_len,
                is_fd: desc.is_fd,
                brs: desc.brs,
                gen_msg_cycle_time_ms: desc.gen_msg_cycle_time_ms,
                gen_msg_send_type: desc.gen_msg_send_type,
                uses_extended_mux: desc.uses_extended_mux,
                calc_fields,
                signals,
            }
        })
    })
}

/// Decode the current payload bytes of a hypothetical (panel-side)
/// frame through the first database **assigned to `bus_id`** that
/// claims `(message_id, extended)`. Same decoded-signal shape the trace
/// view uses, and the same scoping — a panel-side frame is decoded by
/// exactly the databases that would decode it once it is on the wire —
/// but the frame doesn't need to be in the trace store.
///
/// Returns `None` if no such DBC matches the id.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn decode_frame(
    state: State<'_, AppState>,
    bus_id: Option<String>,
    message_id: u32,
    extended: bool,
    data: Vec<u8>,
) -> Option<ipc::DecodedFrameRecord> {
    decode_frame_inner(
        state.inner(),
        bus_id.as_deref(),
        message_id,
        extended,
        &data,
    )
}

pub(crate) fn decode_frame_inner(
    state: &AppState,
    bus_id: Option<&str>,
    message_id: u32,
    extended: bool,
    data: &[u8],
) -> Option<ipc::DecodedFrameRecord> {
    let id = cannet_core::CanId::new(message_id, extended).ok()?;
    state.first_dbc_on_bus(bus_id, |db| {
        db.decode_raw(id, data)
            .map(|decoded| ipc::DecodedFrameRecord {
                name: decoded.name.to_string(),
                signals: decoded.signals.iter().map(signal_to_wire).collect(),
            })
    })
}

pub(crate) fn encode_frame_inner(
    state: &AppState,
    bus_id: Option<&str>,
    message_id: u32,
    extended: bool,
    signals: &[ipc::EncodeFrameSignal],
    base: Vec<u8>,
) -> Result<ipc::EncodeFrameResponse, String> {
    let mode = if extended { "extended" } else { "standard" };
    let id = cannet_core::CanId::new(message_id, extended)
        .map_err(|e| format!("invalid {mode} id: {e}"))?;
    let mut bytes = base;
    let signal_pairs: Vec<(&str, f64)> = signals
        .iter()
        .map(|s| (s.name.as_str(), s.physical))
        .collect();
    // The scan writes the encoded payload into `bytes` in place and
    // yields the skipped-signal list; `bytes` is consumed after it.
    let skipped = state.first_dbc_on_bus(bus_id, |db| {
        db.encode_frame(id, &signal_pairs, &mut bytes)
            .map(|report| {
                report
                    .skipped
                    .into_iter()
                    .map(|s| ipc::EncodeFrameSkipped {
                        name: s.name,
                        reason: match s.reason {
                            cannet_dbc::SkipReason::SignalNotFound => "signal_not_found",
                            cannet_dbc::SkipReason::BaseTooShort => "base_too_short",
                            cannet_dbc::SkipReason::SizeOutOfRange => "size_out_of_range",
                        },
                    })
                    .collect()
            })
    });
    match skipped {
        Some(skipped) => Ok(ipc::EncodeFrameResponse { bytes, skipped }),
        None => Err(format!(
            "no DBC matches id 0x{message_id:X} (extended={extended})"
        )),
    }
}

fn signal_to_wire(sig: &DecodedSignal<'_>) -> SignalRecord {
    SignalRecord {
        name: sig.name.to_string(),
        value: sig.value,
        unit: sig.unit.to_string(),
        raw_field: cannet_dbc::is_raw_field(sig.value_is_raw_integer, sig.unit, sig.is_enum),
        display_hex: sig.display_hex,
        label: sig.label.map(str::to_string),
    }
}
