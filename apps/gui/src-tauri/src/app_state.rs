//! Process-wide application state ([`AppState`]) and the derived-state
//! refreshers that submodules depend on.
//!
//! `AppState` is the host model every Tauri command reads: the loaded DBC
//! set, the trace store, the per-signal caches, active sessions, the TX
//! registry, and the RBS / verification runtimes. Submodules
//! (`rbs`, `project`, `dbc_watcher`, `crash`, and the command modules)
//! depend on this module rather than reaching up into the crate root.
//!
//! The three derived-state refreshers here rebuild lazily-built caches
//! when their inputs change. They are deliberately **not** merged: each
//! drops a different subset (ADR 0033) — `invalidate_derived_caches`
//! clears the signal pyramids + the on-disk filter index (rare DBC-set
//! changes), while `refresh_calc_resolutions` and `rebuild_verification`
//! re-derive the TX calc resolutions and the verifier config index
//! (chained together by `rbs::refresh_all_elements`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, State};

use cannet_core::CanId;
use cannet_dbc::Database;

use crate::dbc_watcher::DbcWatcher;
use crate::notes::NotesStore;
use crate::signal_cache::SignalCacheStore;
use crate::system_log::SystemLog;
use crate::trace_store::{RawTraceFrame, TraceStore};
use crate::sys_warn;
use crate::{filter, ipc, local_buses, rbs, transmit_frames, transmit_scheduler, verification};
// `ActiveFilterIndex` / `RemoteSession` / `resolve_effective_calc` are
// referenced from here but live in the `trace_query` / `session` /
// `transmit_commands` modules once those are split out; they resolve at
// the crate root until then.
use crate::trace_query::ActiveFilterIndex;
use crate::transmit_commands::resolve_effective_calc;
use crate::session::RemoteSession;

/// A loaded DBC: its source path, the parsed database, and the set of
/// logical bus ids this DBC is scoped to. Decoders walk the
/// loaded list in order — the first that decodes a given frame wins —
/// and skip any DBC whose `buses` set is non-empty and doesn't contain
/// the frame's `bus_id`. An empty set is "applies to every bus".
pub(crate) struct LoadedDbc {
    pub(crate) path: String,
    /// `Arc` so the trace store's per-frame mux-selector extractor can
    /// hold a snapshot of the loaded set without cloning parse results
    /// or locking `databases` on the append path.
    pub(crate) db: Arc<Database>,
    /// Scoped bus ids; empty = unscoped (applies to all buses).
    pub(crate) buses: Vec<String>,
}

/// Process-wide state shared between commands and pump threads.
pub(crate) struct AppState {
    /// The loaded DBCs, in priority order — when decoding a frame the
    /// fetch commands try each in turn and take the first match. Mutated
    /// by `add_dbc` / `remove_dbc` / `clear_dbcs`. (Only one interface
    /// exists for now, so every loaded DBC applies to it.)
    pub(crate) databases: Mutex<Vec<LoadedDbc>>,
    /// Active remote sessions, keyed by server address. Each value is
    /// the gRPC [`SessionHandle`] (drop to disconnect), a
    /// [`SessionTransmitter`] the transmit panel uses to push frames
    /// over the wire, the interfaces the session is subscribed to (so
    /// the transmit-panel command can pick the right `interface_id` for
    /// a chosen channel), and a stop flag the pump thread watches.
    /// `disconnect_remote_server` takes one or all entries out, sets
    /// the flag, and drops the handle — the flag makes the pump exit
    /// promptly instead of first draining whatever frames the gRPC
    /// task already buffered, and dropping the handle closes the
    /// stream. The pump thread removes its own entry on exit.
    pub(crate) remote_sessions: Mutex<HashMap<String, RemoteSession>>,
    /// The trace model — the single source of truth for the captured
    /// stream. Pump threads append; `fetch_trace_range` reads slices
    /// out for the trace view to render. `Arc`-wrapped so background
    /// threads spawned outside an `AppHandle` context (e.g. the local
    /// virtual-bus observer pumps in [`local_buses`]) can hold their
    /// own clone of the store across their lifetime.
    pub(crate) trace_store: Arc<TraceStore>,
    /// Per-`(message, signal)` decoded-sample caches, extended
    /// incrementally by `sample_signals` so a plot doesn't re-decode
    /// the same matching frames every tick. Cleared on
    /// `clear_trace_store` (the frame indices it holds wouldn't
    /// otherwise survive).
    pub(crate) signal_caches: SignalCacheStore,
    /// Host-side log bus. Append-side: the `sys_info!` /
    /// `sys_warn!` / `sys_error!` macros that wrap call sites in
    /// project / DBC / connection / BLF-import flows. Read-side: the
    /// `fetch_system_log` / `clear_system_log` IPC commands and the
    /// `system-log-appended` event the host emits on every successful
    /// push.
    pub(crate) system_log: SystemLog,
    /// Session-scoped notes. Edited by `add_note` / `rename_note` /
    /// `remove_note` / `clear_notes` (each emits `notes-changed` on
    /// success); snapshotted by `fetch_notes`. Save Capture writes
    /// them inside the BLF as `GLOBAL_MARKER` records; Open Capture
    /// and project-open migration restore through them.
    pub(crate) notes: NotesStore,
    /// Filesystem watcher for loaded DBC paths. Lazily
    /// initialised in the Tauri `setup` hook (it needs an
    /// `AppHandle` to drive its event callback). `None` only
    /// briefly during startup or if backend construction fails on
    /// an exotic platform; `add_dbc` / `remove_dbc` / `clear_dbcs`
    /// handle the `None` case as "no auto-reload" rather than
    /// failing.
    pub(crate) dbc_watcher: Mutex<Option<DbcWatcher>>,
    /// Host-side `SharedBus` instances for
    /// `local-virtual-bus` bindings (ADR 0021). Reconstructed on
    /// every project open; dropped on close.
    pub(crate) local_buses: local_buses::LocalBusRegistry,
    /// The host-side TX-message pool. The transmit
    /// panel is a thin view onto this. Populated on project open,
    /// snapshotted on save.
    pub(crate) transmit_frames: Mutex<transmit_frames::TransmitFrameRegistry>,
    /// Handle to the single transmit scheduler thread
    /// (`run_transmit_scheduler`) that drives every running periodic.
    /// `start`/`stop_periodic_transmit` push schedule changes through
    /// it; the thread itself is spawned in `run`'s `setup`.
    pub(crate) transmit_scheduler: transmit_scheduler::TransmitScheduler,
    /// Rest-of-bus-simulation state (ADR 0028): loaded `.cannet_rbs`
    /// documents per element, the project's logical-bus name map, and
    /// the global kill-switch. Lock order: `rbs` before `databases`
    /// before `transmit_frames` before `remote_sessions`.
    pub(crate) rbs: Mutex<rbs::RbsRuntime>,
    /// Ingest-time CRC / counter verification (ADR 0027): the
    /// per-`(bus, id)` config index, counter continuity, the sparse
    /// violation index the trace fetch decorates rows from, and the
    /// validity map. Owns its own lock.
    pub(crate) verifier: verification::VerificationState,
    /// Directory the live filter index roots in (a `filter/` subdir of the
    /// disk-spill scratch). The materialized filtered-trace index
    /// ([`ActiveFilterIndex`]) writes its segment files here.
    pub(crate) filter_index_dir: std::path::PathBuf,
    /// The filter index for the trace's current filtered chronological view
    /// (ADR 0002 DS-3). `None` until the first filtered fetch builds one;
    /// rebuilt on a predicate or capture-session change, extended
    /// incrementally otherwise. `fetch_filtered_trace` serves pages from it.
    pub(crate) filter_index: Mutex<Option<ActiveFilterIndex>>,
    /// Identity of the currently open project (ADR 0002 DS-7), set by
    /// `open_project`. Stamped into the scratch when a capture starts so a
    /// later launch reloads that scratch only against the same project;
    /// `None` when no project is open.
    pub(crate) active_project_id: Mutex<Option<uuid::Uuid>>,
}

/// Drop the derived, lazily-built decode state after a DBC-set change:
/// the per-signal decoded-sample caches (pyramids) and the active filter
/// index. Both are functions of the current DBCs applied to the raw store,
/// but each advances its own decode cursor to the store tip unconditionally
/// (`SignalCache::catch_up`, `TraceStore::refresh_filter_index`) — so a
/// frame the *old* DBC set couldn't decode is skipped once and never
/// revisited. A DBC loaded, removed, re-scoped, or reloaded therefore
/// leaves a stale cache: on a stopped/reloaded capture (no new appends to
/// trigger a rebuild) the plot and filtered view stay empty/partial forever.
/// Clearing forces a full rebuild on the next serve. DBC-set changes are
/// rare, so clear-and-rebuild is cheaper and safer than tracking per-frame
/// decode dependencies (ADR 0033: build dependent state in order, and
/// rebuild it when its inputs change).
pub(crate) fn invalidate_derived_caches(state: &AppState) {
    state.signal_caches.clear();
    *state
        .filter_index
        .lock()
        .expect("filter index mutex poisoned") = None;
    refresh_mux_extractor(state);
}

/// (Re)install the trace store's multiplexor-selector extractor from
/// the current DBC set — the append-path hook behind the per-signal
/// latest-value view's mux index ([`TraceStore::latest_mux_in_window`]).
/// The closure holds `Arc` snapshots of the loaded databases, so the
/// append path never takes the `databases` lock; a DBC-set change just
/// swaps the closure (and resets the index) here. `None` when no loaded
/// DBC has a multiplexed message — the common case pays nothing.
fn refresh_mux_extractor(state: &AppState) {
    let snap: Vec<(Arc<Database>, Vec<String>)> = {
        let dbs = state.databases.lock().expect("databases mutex poisoned");
        dbs.iter()
            .filter(|d| d.db.has_multiplexor())
            .map(|d| (d.db.clone(), d.buses.clone()))
            .collect()
    };
    if snap.is_empty() {
        state.trace_store.set_mux_extractor(None);
        return;
    }
    state
        .trace_store
        .set_mux_extractor(Some(Arc::new(move |f: &RawTraceFrame| {
            let id = CanId::new(f.id, f.extended).ok()?;
            snap.iter()
                .filter(|(_, buses)| filter::dbc_applies(buses, f.bus_id.as_deref()))
                .find_map(|(db, _)| db.decode_mux_selector(id, f.payload.data()))
        })));
}
/// Rebuild the ingest-time verifier's config index from the loaded
/// DBC set plus every RBS element's per-message overrides (an
/// override replaces the DBC default per field — ADR 0027). Called
/// alongside the calc-resolution refresh whenever DBCs, project
/// buses, or RBS configs change.
pub(crate) fn rebuild_verification(state: &AppState) {
    let overrides: Vec<(String, u32, bool, cannet_dbc::CalculatedFieldsConfig)> = {
        let rbs_guard = state.rbs.lock().expect("rbs mutex poisoned");
        let dbs = state.databases.lock().expect("databases mutex poisoned");
        let mut out = Vec::new();
        for element in rbs_guard.elements.values() {
            for (bus_key, bus) in &element.file.buses {
                let Some(bus_id) = rbs_guard
                    .project_buses
                    .iter()
                    .find(|(_, n)| n == bus_key)
                    .map(|(id, _)| id.clone())
                else {
                    continue;
                };
                for ecu in bus.ecus.values() {
                    for (msg_key, msg) in &ecu.messages {
                        if msg.counter.is_none() && msg.crc.is_none() {
                            continue;
                        }
                        let Ok((id, extended)) = rbs::parse_message_key(msg_key) else {
                            continue;
                        };
                        let Ok(can_id) = CanId::new(id, extended) else { continue };
                        let spec = ipc::CalcFieldsSpec {
                            counter: msg.counter.clone(),
                            crc: msg.crc.clone(),
                        };
                        let Ok(override_config) = spec.to_config() else {
                            continue;
                        };
                        // Per-field layering over the DBC default.
                        let dbc_default = dbs
                            .iter()
                            .filter(|d| d.buses.is_empty() || d.buses.iter().any(|b| b == &bus_id))
                            .find_map(|d| d.db.dbc_calculated_fields(can_id))
                            .cloned()
                            .unwrap_or_default();
                        let merged = cannet_dbc::CalculatedFieldsConfig {
                            counter: override_config.counter.or(dbc_default.counter),
                            crc: override_config.crc.or(dbc_default.crc),
                        };
                        if !merged.is_empty() {
                            out.push((bus_id.clone(), id, extended, merged));
                        }
                    }
                }
            }
        }
        out
    };
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    state.verifier.rebuild_configs(&dbs, &overrides);
}

/// Re-resolve every TX-registry entry's calculated fields against the
/// current DBC set. Called whenever either side changes — a DBC is
/// added / removed / rescoped / auto-reloaded, a project is opened,
/// or an entry is edited. A resolution failure clears that entry's
/// fields (the frame still transmits, without recompute) and warns on
/// the system log.
pub(crate) fn refresh_calc_resolutions(app: &AppHandle) {
    let state: State<'_, AppState> = app.state();
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    let mut registry = state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned");
    for (id, request, spec) in registry.resolution_inputs() {
        match resolve_effective_calc(&dbs, &request, spec.as_ref()) {
            Ok(resolved) => registry.set_resolved_calc(&id, resolved),
            Err(e) => {
                registry.set_resolved_calc(&id, None);
                sys_warn!(
                    app,
                    "transmit",
                    "calculated fields disabled for TX message {id}: {e}"
                );
            }
        }
    }
}
