//! DBC commands and decode helpers.
//!
//! Loading / scoping / removing DBCs (`add_dbc` …), the DBC-content and
//! signal catalogs the discovery / picker panels read, per-signal value
//! tables, and the panel-side describe / encode / decode-frame surface —
//! plus the shared `decode_against` / `decode_raw_frame` helpers that
//! turn a raw frame into a decoded record against the loaded DBC set.

use std::sync::Arc;

use tauri::{AppHandle, State};

use cannet_core::CanId;
use cannet_dbc::{Database, DecodedSignal};

use crate::app_state::{invalidate_derived_caches, AppState, LoadedDbc};
use crate::ipc::{
    self, DbcAttributeRecord, DbcContentRecord, DbcInfo, DbcMessageContentRecord,
    DbcSignalContentRecord, DecodedRecord, SignalDescriptorRecord, SignalRecord,
    ValueTableEntryRecord,
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
    let db = match Database::parse(&text) {
        Ok(db) => db,
        Err(e) => {
            let msg = format!("failed to parse DBC at {path}: {e}");
            sys_error!(&app, "dbc", "{msg}");
            return Err(msg);
        }
    };
    // Non-fatal attribute problems (malformed CannetCounter /
    // CannetCrc values) surface as warnings; the DBC still loads.
    for w in db.parse_warnings() {
        sys_warn!(&app, "dbc", "{path}: {w}");
    }
    let db = Arc::new(db);
    let reloaded = {
        let mut list = state.databases();
        if let Some(slot) = list.iter_mut().find(|d| d.path == path) {
            slot.db = db;
            true
        } else {
            list.push(LoadedDbc {
                path: path.clone(),
                db,
                buses: Vec::new(),
            });
            false
        }
    };
    if reloaded {
        sys_info!(&app, "dbc", "reloaded DBC {path}");
    } else {
        sys_info!(&app, "dbc", "loaded DBC {path}");
        // Start watching this file's parent dir for FS
        // events (only on first-load — a reload is already watched).
        if let Some(w) = state
            .dbc_watcher()
            .as_mut()
        {
            w.watch_dbc(std::path::Path::new(&path));
        }
    }
    invalidate_derived_caches(state.inner());
    rbs::refresh_all_elements(&app);
    Ok(dbc_list(state.inner()))
}

/// Replace the bus-scoping set for a loaded DBC. An empty `buses` is
/// the "applies to all buses" default. Unknown path is a no-op (returns
/// the unchanged list); the frontend's project state can drift if a DBC
/// is removed between the user clicking a checkbox and this command
/// firing.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn set_dbc_buses(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    buses: Vec<String>,
) -> Vec<DbcInfo> {
    {
        let mut list = state.databases();
        if let Some(slot) = list.iter_mut().find(|d| d.path == path) {
            slot.buses = buses;
        }
    }
    invalidate_derived_caches(state.inner());
    rbs::refresh_all_elements(&app);
    dbc_list(state.inner())
}

/// Remove the loaded DBC with this path (no-op if it isn't loaded).
/// Returns the remaining loaded list.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn remove_dbc(app: AppHandle, state: State<'_, AppState>, path: String) -> Vec<DbcInfo> {
    let removed = {
        let mut list = state.databases();
        let before = list.len();
        list.retain(|d| d.path != path);
        before != list.len()
    };
    if removed {
        sys_info!(&app, "dbc", "removed DBC {path}");
        if let Some(w) = state
            .dbc_watcher()
            .as_mut()
        {
            w.unwatch_dbc(std::path::Path::new(&path));
        }
        invalidate_derived_caches(state.inner());
        rbs::refresh_all_elements(&app);
    }
    dbc_list(state.inner())
}

/// Unload every DBC (the "New project" reset, and the first half of an
/// "open project" — the project's DBCs are then re-added one by one).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn clear_dbcs(app: AppHandle, state: State<'_, AppState>) {
    let count = {
        let mut list = state.databases();
        let n = list.len();
        list.clear();
        n
    };
    if count > 0 {
        sys_info!(&app, "dbc", "cleared {count} loaded DBC(s)");
        invalidate_derived_caches(state.inner());
        rbs::refresh_all_elements(&app);
    }
    if let Some(w) = state
        .dbc_watcher()
        .as_mut()
    {
        w.unwatch_all();
    }
}
/// Decode a raw frame against the loaded DBCs, in order — the first
/// one that recognises the arbitration id wins. Skips any DBC whose
/// `buses` set is non-empty and doesn't contain the frame's `bus_id`
/// (per-bus scoping); an empty set is "all buses". `None` if
/// no DBC decodes.
pub(crate) fn decode_against(dbs: &[LoadedDbc], frame: &RawTraceFrame) -> Option<DecodedRecord> {
    dbs.iter()
        .filter(|d| filter::dbc_applies(&d.buses, frame.bus_id.as_deref()))
        .find_map(|d| decode_raw_frame(&d.db, frame))
}
/// Every `(bus, message, signal)` triple the loaded DBCs define, for
/// a plot panel's signal picker. One record per matching project bus
/// per DBC signal — so a scoped DBC produces one record per bus in
/// its scope, an unscoped DBC produces one record per project bus,
/// and a project with no buses falls back to one `bus_id: None`
/// record per signal (the legacy "any bus" path). Sorted by
/// `(bus_id, message_id, signal_name)` and deduplicated on that key.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn list_signals(
    state: State<'_, AppState>,
    project_buses: Vec<String>,
) -> Vec<SignalDescriptorRecord> {
    let dbs = state.databases();
    // Shared enumeration with `fetch_signal_page` (per-bus scope
    // expansion + descriptor-key dedup), so the picker catalog and the
    // signal-view rows can't disagree about what exists.
    signal_snapshot::scoped_descriptors(
        dbs.iter().map(|l| (l.db.as_ref(), l.buses.as_slice())),
        &project_buses,
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
    })
    .collect()
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
/// Look up the full `VAL_` table for one DBC signal across every
/// loaded DBC, first-match-wins. Returns an empty vec if no DBC has
/// a value table for the requested signal. The plot panel's symbolic
/// y-axis ticks and the transmit panel's enum dropdown call this
/// once per signal — the table doesn't have to ride along on every
/// decoded frame.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn list_value_tables(
    state: State<'_, AppState>,
    message_id: u32,
    extended: bool,
    signal_name: String,
) -> Vec<ipc::ValueTableEntryRecord> {
    state
        .first_dbc(|db| {
            db.value_table_for_signal(message_id, extended, &signal_name)
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
/// [`cannet_dbc::Database::encode_frame`] against the first DBC that
/// claims the `(message_id, extended)` pair. Returns the updated
/// payload bytes plus any signals the encoder couldn't place.
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
    message_id: u32,
    extended: bool,
    signals: Vec<ipc::EncodeFrameSignal>,
    base: Vec<u8>,
) -> Result<ipc::EncodeFrameResponse, String> {
    encode_frame_inner(state.inner(), message_id, extended, &signals, base)
}

/// Return the rich descriptor for one DBC message (signals, range,
/// mux indicator, …) — what the transmit panel needs to render the
/// signals table without reimplementing DBC walking on the frontend.
/// Returns `None` if no DBC matches the id.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn describe_message(
    state: State<'_, AppState>,
    message_id: u32,
    extended: bool,
) -> Option<ipc::MessageDescriptorRecord> {
    describe_message_inner(state.inner(), message_id, extended)
}

pub(crate) fn describe_message_inner(
    state: &AppState,
    message_id: u32,
    extended: bool,
) -> Option<ipc::MessageDescriptorRecord> {
    let id = cannet_core::CanId::new(message_id, extended).ok()?;
    state.first_dbc(|db| {
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
/// frame through the first DBC that claims `(message_id, extended)`.
/// Same decoded-signal shape the trace view uses, but the frame
/// doesn't need to be in the trace store.
///
/// Returns `None` if no DBC matches the id.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn decode_frame(
    state: State<'_, AppState>,
    message_id: u32,
    extended: bool,
    data: Vec<u8>,
) -> Option<ipc::DecodedFrameRecord> {
    decode_frame_inner(state.inner(), message_id, extended, &data)
}

pub(crate) fn decode_frame_inner(
    state: &AppState,
    message_id: u32,
    extended: bool,
    data: &[u8],
) -> Option<ipc::DecodedFrameRecord> {
    let id = cannet_core::CanId::new(message_id, extended).ok()?;
    state.first_dbc(|db| {
        db.decode_raw(id, data).map(|decoded| ipc::DecodedFrameRecord {
            name: decoded.name.to_string(),
            signals: decoded.signals.iter().map(signal_to_wire).collect(),
        })
    })
}

pub(crate) fn encode_frame_inner(
    state: &AppState,
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
    // `first_dbc` writes the encoded payload into `bytes` in place and
    // yields the skipped-signal list; `bytes` is consumed after the scan.
    let skipped = state.first_dbc(|db| {
        db.encode_frame(id, &signal_pairs, &mut bytes).map(|report| {
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
        label: sig.label.map(str::to_string),
    }
}
