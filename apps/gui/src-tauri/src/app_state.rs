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
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::{AppHandle, Manager, State};

use cannet_core::CanId;
use cannet_dbc::Database;

use crate::dbc_watcher::DbcWatcher;
use crate::notes::NotesStore;
use crate::signal_cache::SignalCacheStore;
use crate::sys_warn;
use crate::system_log::SystemLog;
use crate::trace_store::{RawTraceFrame, TraceStore};
use crate::view_signals::ViewSignalRegistry;
use crate::{
    filter, ipc, local_buses, rbs, signal_snapshot, transmit_frames, transmit_scheduler,
    verification,
};
// `ActiveFilterIndex` / `RemoteSession` / `resolve_effective_calc` are
// referenced from here but live in the `trace_query` / `session` /
// `transmit_commands` modules once those are split out; they resolve at
// the crate root until then.
use crate::session::RemoteSession;
use crate::trace_query::ActiveFilterIndex;
use crate::transmit_commands::{merge_calc_override, resolve_effective_calc};

/// A loaded DBC: its source path, the parsed database, and the set of
/// logical bus ids this DBC is **assigned to**. Decoders walk the
/// loaded list in order — the first that decodes a given frame wins —
/// and skip any DBC whose `buses` set does not contain the frame's
/// `bus_id` ([`crate::filter::dbc_applies`]). An empty set is a
/// database assigned to nothing, which decodes nothing: loading a file
/// makes it available, assigning it to a bus makes it decode.
pub(crate) struct LoadedDbc {
    pub(crate) path: String,
    /// `Arc` so the trace store's per-frame mux-selector extractor can
    /// hold a snapshot of the loaded set without cloning parse results
    /// or locking `databases` on the append path.
    pub(crate) db: Arc<Database>,
    /// The bus ids this database is assigned to; empty = assigned to
    /// nothing, so it decodes nothing.
    pub(crate) buses: Vec<String>,
}

/// Process-wide state shared between commands and pump threads.
pub(crate) struct AppState {
    /// The loaded DBCs, in priority order — when decoding a frame the
    /// fetch commands try each in turn and take the first match. Mutated
    /// by `add_dbc` / `remove_dbc` / `clear_dbcs`. (Only one interface
    /// exists for now, so every loaded DBC applies to it.)
    pub(crate) databases: Mutex<Vec<LoadedDbc>>,
    /// Cached bus-expanded descriptor universe for the signal-snapshot
    /// path — see [`signal_snapshot::DescriptorSnapshot`]. `None` until
    /// the first `fetch_signal_page`; dropped by
    /// [`invalidate_derived_caches`] on any DBC-set change.
    pub(crate) descriptor_snapshot: Mutex<Option<signal_snapshot::DescriptorSnapshot>>,
    /// Cached "which message ids more than one loaded database defines"
    /// index — see
    /// [`signal_fingerprint::split_messages`](crate::signal_fingerprint::split_messages).
    /// A pure function of the DBC set, like the descriptor universe
    /// above, and dropped by [`invalidate_derived_caches`] on the same
    /// events. `None` until the first decode model is built.
    pub(crate) split_messages: Mutex<Option<Arc<crate::signal_fingerprint::SplitMessages>>>,
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
    /// ([`ActiveFilterIndex`]) writes its segment files here. Behind a lock
    /// because the session can move to a different project directory
    /// mid-flight (ADR 0042).
    pub(crate) filter_index_dir: Mutex<std::path::PathBuf>,
    /// The filter index for the trace's current filtered chronological view
    /// (ADR 0002 DS-3). `None` until the first filtered fetch builds one;
    /// rebuilt on a predicate or capture-session change, extended
    /// incrementally otherwise. `fetch_filtered_trace` serves pages from it.
    pub(crate) filter_index: Mutex<Option<ActiveFilterIndex>>,
    /// Cooperative cancel flag for the single trace-open pump in flight
    /// right now (`open_log` / `import_mdf`'s spawned thread), or
    /// `None` when nothing is importing. Each of those commands installs
    /// its own flag here before spawning and clears the slot back to
    /// `None` when its pump thread ends (cleanly, cancelled, or
    /// panicked) — mirroring `remote_sessions`'s per-session `stop`
    /// flag, but scoped to the one BLF/MDF import the frontend's own
    /// guard ever allows to run at a time. `cancel_import` flips
    /// whichever flag is here; a call with nothing importing is a no-op.
    pub(crate) import_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// How many trailing frames the frontend wants on each `trace-grew`
    /// (`set_live_tail_rows`). `0` — the startup default — means the
    /// emitter skips the tail collect + decode entirely; only an
    /// auto-scrolling chronological view ever reads it.
    pub(crate) live_tail_rows: std::sync::atomic::AtomicU64,
    /// Identity of the currently open project (ADR 0002 DS-7), set by
    /// `open_project`. Stamped into the scratch when a capture starts so a
    /// later launch reloads that scratch only against the same project;
    /// `None` when no project is open.
    pub(crate) active_project_id: Mutex<Option<uuid::Uuid>>,
    /// The open project *file* and the content the app last exchanged
    /// with it — the disk watch on `.cannet_prj`
    /// ([`crate::project_watch`], ADR 0053 §1).
    pub(crate) watched_project: Mutex<crate::watched_file::WatchedFile>,
    /// Which signals the open views reference, pushed here by the
    /// frontend as view configs are edited
    /// ([`crate::view_signals`]). The host owns the model the
    /// view-signal panel and its launcher badge read; the frontend owns
    /// the view configs it is derived from.
    pub(crate) view_signals: Mutex<ViewSignalRegistry>,
    /// Per-signal choices of which assigned database decodes a signal
    /// ([`crate::signal_fingerprint::SignalDbcPicks`]) — the resolution
    /// of the ambiguous case the view-signal panel surfaces. Host state
    /// because the decoder consumes it: loaded from the project on open,
    /// snapshotted back on save, empty in a project that never had an
    /// ambiguity to resolve.
    ///
    /// Behind an `Arc` because every decode model built for a serve
    /// carries it, and cloning a map per serve is a cost the ordinary
    /// project should not pay.
    pub(crate) signal_dbc_picks: Mutex<Arc<crate::signal_fingerprint::SignalDbcPicks>>,
}

/// Guarded-field accessors. Each wraps the one lock its field needs with
/// the canonical poison message, so call sites read
/// `state.databases()` instead of re-spelling
/// `state.databases.lock().expect("...")`. Poisoning is unrecoverable
/// here (a panic under a held lock), so `expect` is the intended policy —
/// the accessors centralise it. They take one lock each and never lock
/// ordering internally, so the documented lock order (`rbs` before
/// `databases` before `transmit_frames` before `remote_sessions`) is
/// still enforced by call-site acquisition sequence.
impl AppState {
    pub(crate) fn databases(&self) -> MutexGuard<'_, Vec<LoadedDbc>> {
        self.databases.lock().expect("databases mutex poisoned")
    }

    pub(crate) fn remote_sessions(&self) -> MutexGuard<'_, HashMap<String, RemoteSession>> {
        self.remote_sessions
            .lock()
            .expect("remote_sessions mutex poisoned")
    }

    pub(crate) fn dbc_watcher(&self) -> MutexGuard<'_, Option<DbcWatcher>> {
        self.dbc_watcher.lock().expect("dbc_watcher mutex poisoned")
    }

    /// The open project file's watch record. Taken *before*
    /// [`Self::dbc_watcher`] wherever both are needed.
    pub(crate) fn watched_project(&self) -> MutexGuard<'_, crate::watched_file::WatchedFile> {
        self.watched_project
            .lock()
            .expect("watched_project mutex poisoned")
    }

    pub(crate) fn transmit_frames(&self) -> MutexGuard<'_, transmit_frames::TransmitFrameRegistry> {
        self.transmit_frames
            .lock()
            .expect("transmit_frames mutex poisoned")
    }

    pub(crate) fn rbs(&self) -> MutexGuard<'_, rbs::RbsRuntime> {
        self.rbs.lock().expect("rbs mutex poisoned")
    }

    pub(crate) fn filter_index_dir(&self) -> MutexGuard<'_, std::path::PathBuf> {
        self.filter_index_dir
            .lock()
            .expect("filter index dir mutex poisoned")
    }

    pub(crate) fn filter_index(&self) -> MutexGuard<'_, Option<ActiveFilterIndex>> {
        self.filter_index
            .lock()
            .expect("filter index mutex poisoned")
    }

    pub(crate) fn active_project_id(&self) -> MutexGuard<'_, Option<uuid::Uuid>> {
        self.active_project_id
            .lock()
            .expect("active_project_id mutex poisoned")
    }

    /// The view-signal reference registry. Taken *before*
    /// [`Self::databases`] wherever both are needed.
    pub(crate) fn view_signals(&self) -> MutexGuard<'_, ViewSignalRegistry> {
        self.view_signals
            .lock()
            .expect("view_signals mutex poisoned")
    }

    /// The per-signal database picks. Taken *after* [`Self::databases`]
    /// wherever both are needed ([`Self::decode_model`] reads it under a
    /// held DBC-set guard), and released immediately — every reader
    /// wants the `Arc`, not the guard.
    pub(crate) fn signal_dbc_picks(
        &self,
    ) -> MutexGuard<'_, Arc<crate::signal_fingerprint::SignalDbcPicks>> {
        self.signal_dbc_picks
            .lock()
            .expect("signal_dbc_picks mutex poisoned")
    }

    /// A snapshot of the picks, for a decode model or for a save.
    pub(crate) fn picks_snapshot(&self) -> Arc<crate::signal_fingerprint::SignalDbcPicks> {
        Arc::clone(&self.signal_dbc_picks())
    }

    /// The model the per-signal decode resolves against right now: the
    /// loaded set the caller is holding, plus the current picks.
    pub(crate) fn decode_model<'a>(
        &self,
        dbcs: &'a [LoadedDbc],
    ) -> crate::signal_fingerprint::DecodeModel<'a> {
        let scopes = dbc_scopes(dbcs);
        let split = self.split_message_index(&scopes);
        crate::signal_fingerprint::DecodeModel::with_split(scopes, self.picks_snapshot(), split)
    }

    /// Forget every per-signal database pick naming `path`, and say
    /// whether any did. The database was removed from the project, so
    /// the choice those entries recorded has no subject any more.
    ///
    /// **Silently**, and by design: what is left is the load-order
    /// default, which is exactly what a project that never made the
    /// pick decodes. There is nothing for the user to repair and so
    /// nothing to tell them about.
    pub(crate) fn forget_dbc_picks(&self, path: &str) -> bool {
        let mut guard = self.signal_dbc_picks();
        if !guard.values().any(|p| p == path) {
            return false;
        }
        let mut next = (**guard).clone();
        next.retain(|_, p| p != path);
        *guard = Arc::new(next);
        true
    }

    pub(crate) fn import_cancel(&self) -> MutexGuard<'_, Option<Arc<AtomicBool>>> {
        self.import_cancel
            .lock()
            .expect("import_cancel mutex poisoned")
    }

    pub(crate) fn descriptor_snapshot(
        &self,
    ) -> MutexGuard<'_, Option<signal_snapshot::DescriptorSnapshot>> {
        self.descriptor_snapshot
            .lock()
            .expect("descriptor_snapshot mutex poisoned")
    }

    pub(crate) fn split_messages(
        &self,
    ) -> MutexGuard<'_, Option<Arc<crate::signal_fingerprint::SplitMessages>>> {
        self.split_messages
            .lock()
            .expect("split_messages mutex poisoned")
    }

    /// The split-message index for `scopes` — built on first use and
    /// reused until the DBC set changes, exactly like
    /// [`Self::scoped_descriptor_snapshot`] and for the same reason:
    /// it is a pure function of the set, and building it walks every
    /// message of every database, which is tens of microseconds on a
    /// project with two large databases and far too much to pay per
    /// serve.
    ///
    /// Deliberately holds only one lock at a time (check, release,
    /// build, store), so it adds no edge to the documented lock order.
    /// Two concurrent misses may each build one; they are equal by
    /// construction.
    pub(crate) fn split_message_index(
        &self,
        scopes: &[crate::signal_fingerprint::DbcScope<'_>],
    ) -> Arc<crate::signal_fingerprint::SplitMessages> {
        if let Some(hit) = self.split_messages().as_ref().map(Arc::clone) {
            return hit;
        }
        let built = Arc::new(crate::signal_fingerprint::split_messages(scopes));
        *self.split_messages() = Some(Arc::clone(&built));
        built
    }

    /// The bus-expanded descriptor universe — built on first use and
    /// reused until the DBC set (or a database's bus assignment)
    /// changes. See [`signal_snapshot::DescriptorSnapshot`] for why this
    /// is cached at all.
    ///
    /// Deliberately holds only one lock at a time (check, release,
    /// build, store), so it adds no edge to the documented lock order.
    /// Two concurrent misses may each build a snapshot; that is a
    /// wasted rebuild, not a correctness problem — they are equal by
    /// construction.
    pub(crate) fn scoped_descriptor_snapshot(&self) -> Arc<signal_snapshot::ScopedDescriptors> {
        if let Some(hit) = self
            .descriptor_snapshot()
            .as_ref()
            .map(|s| s.descriptors.clone())
        {
            return hit;
        }
        let built = Arc::new(signal_snapshot::scoped_descriptors(
            self.databases()
                .iter()
                .map(|l| (l.db.as_ref(), l.buses.as_slice())),
        ));
        *self.descriptor_snapshot() = Some(signal_snapshot::DescriptorSnapshot {
            descriptors: built.clone(),
        });
        built
    }

    /// First loaded DBC **assigned to `bus_id`** (in priority order) for
    /// which `f` yields a value — the per-bus "first assigned database
    /// that answers wins" scan the transmit panel's describe / decode /
    /// encode queries share, and the same priority the decode path
    /// applies to a frame. A query naming no bus resolves through
    /// nothing, because no assignment contains "no bus"
    /// ([`filter::dbc_applies`]).
    pub(crate) fn first_dbc_on_bus<T>(
        &self,
        bus_id: Option<&str>,
        f: impl FnMut(&Database) -> Option<T>,
    ) -> Option<T> {
        self.first_dbc_on_bus_with_path(bus_id, f).map(|(_, v)| v)
    }

    /// [`Self::first_dbc_on_bus`], naming the database that answered as
    /// well as its answer. One scan, two projections: "what does this
    /// bus say?" and "which database is saying it?" can never disagree,
    /// which is what makes the second usable as provenance.
    pub(crate) fn first_dbc_on_bus_with_path<T>(
        &self,
        bus_id: Option<&str>,
        mut f: impl FnMut(&Database) -> Option<T>,
    ) -> Option<(String, T)> {
        self.databases()
            .iter()
            .filter(|loaded| filter::dbc_applies(&loaded.buses, bus_id))
            .find_map(|loaded| f(loaded.db.as_ref()).map(|v| (loaded.path.clone(), v)))
    }
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
///
/// The **pyramids** are the exception, and judged rather than cleared: each
/// carries the fingerprint of the encoding it was decoded under (ADR 0047),
/// so the new set is what decides which of them are stale, which keep
/// decoding, and which are parked against their definition's return.
pub(crate) fn invalidate_derived_caches(state: &AppState) {
    // Before anything reads a model off the new set: the split-message
    // index is a function of that set, and `decode_model` below builds
    // one.
    *state.split_messages() = None;
    // Lock order: the DBC set before the signal caches, as every other
    // path that needs both takes them (`persist_pyramids`, `restore`,
    // `sample_signals`).
    let dbcs = state.databases();
    state
        .signal_caches
        .invalidate_dbcs(&state.decode_model(&dbcs));
    drop(dbcs);
    *state.filter_index() = None;
    // The descriptor universe is derived from the DBC set the same way,
    // and has the same staleness failure: a removed DBC's signals would
    // keep appearing in the signal view and the DBC panel's value column
    // until something else forced a rebuild.
    *state.descriptor_snapshot() = None;
    refresh_mux_extractor(state);
}

/// The **whole-set** gates the current model would reuse a persisted
/// signal-pyramid set against (ADR 0047), or `None` when the scratch holds
/// no identified capture — nothing is persisted or restored then, because
/// there is nothing to prove the samples belong to.
///
/// What each signal was decoded *with* is judged per signal, against the
/// fingerprints the manifest carries ([`crate::signal_fingerprint`]), so
/// no DBC state is read here.
pub(crate) fn pyramid_validity(state: &AppState) -> Option<crate::signal_cache::PyramidValidity> {
    let capture_id = state.trace_store.scratch_capture_id()?;
    let (low_water, _) = state.trace_store.low_water();
    Some(crate::signal_cache::PyramidValidity {
        capture_id: capture_id.to_string(),
        low_water: low_water as u64,
    })
}

/// The loaded set as the borrowed scopes a decode model is built from:
/// each database with the buses it is scoped to, **in load order** (the
/// order is the "first DBC that decodes wins" priority, so it is part
/// of what a signal decodes to). Borrowed from the guard the caller
/// holds, so the set cannot move under the fingerprints taken from it.
///
/// [`AppState::decode_model`] joins these to the per-signal picks and
/// the cached split-message index; a test that is not about ambiguity
/// pairs them with [`DecodeModel::plain`](crate::signal_fingerprint::DecodeModel::plain).
pub(crate) fn dbc_scopes(dbcs: &[LoadedDbc]) -> Vec<crate::signal_fingerprint::DbcScope<'_>> {
    dbcs.iter()
        .map(|d| crate::signal_fingerprint::DbcScope {
            path: &d.path,
            db: d.db.as_ref(),
            buses: &d.buses,
        })
        .collect()
}

/// (Re)install the trace store's multiplexor-selector extractor from
/// the current DBC set — the append-path hook behind the per-signal
/// latest-value view's mux index ([`TraceStore::latest_mux_in_window`]).
/// The closure holds `Arc` snapshots of the loaded databases, so the
/// append path never takes the `databases` lock; a DBC-set change just
/// swaps the closure (and resets the index) here. `None` when no loaded
/// DBC has a multiplexed message — the common case pays nothing.
///
/// **The one resolution site that cannot hold a
/// [`DecodeModel`](crate::signal_fingerprint::DecodeModel)**, for that
/// reason: a model borrows the loaded set, and this runs per appended
/// frame. So it snapshots the picks alongside the databases and applies
/// the rule through
/// [`signal_fingerprint::picked_path`](crate::signal_fingerprint::picked_path),
/// which is where that rule is written down. A candidate whose
/// multiplexor signal is pinned to a *different* database is not a
/// candidate for it — that is the per-signal half of ADR 0054 — so a
/// user who sees the wrong arm can pick their way out of it. A pick
/// change re-installs the closure, because it goes through
/// [`invalidate_derived_caches`] like any other change to what the set
/// decodes.
///
/// The fall-through behind the winner stays: a database that defines
/// the multiplexor but cannot read it out of *this* payload lets the
/// next one answer. That is an accepted exposure of the per-frame
/// decode path, not the per-signal question this resolves.
fn refresh_mux_extractor(state: &AppState) {
    // Lock order: the DBC set before the picks, as `decode_model` takes
    // them.
    let (snap, picks) = {
        let dbs = state.databases();
        let snap: Vec<(String, Arc<Database>, Vec<String>)> = dbs
            .iter()
            .filter(|d| d.db.has_multiplexor())
            .map(|d| (d.path.clone(), d.db.clone(), d.buses.clone()))
            .collect();
        (snap, state.picks_snapshot())
    };
    if snap.is_empty() {
        state.trace_store.set_mux_extractor(None);
        return;
    }
    state
        .trace_store
        .set_mux_extractor(Some(Arc::new(move |f: &RawTraceFrame| {
            let id = CanId::new(f.id, f.extended).ok()?;
            let bus_id = f.bus_id.as_deref();
            snap.iter()
                .filter(|(_, _, buses)| filter::dbc_applies(buses, bus_id))
                .find_map(|(path, db, _)| {
                    // Costs nothing where no pick exists at all, which
                    // is every project that has never met an ambiguity.
                    if !picks.is_empty() {
                        let chosen = db.multiplexor_signal_name(id).and_then(|name| {
                            crate::signal_fingerprint::picked_path(
                                &picks, bus_id, f.id, f.extended, name,
                            )
                        });
                        if chosen.is_some_and(|c| c != path) {
                            return None;
                        }
                    }
                    db.decode_mux_selector(id, f.payload.data())
                })
        })));
}
/// Rebuild the ingest-time verifier's config index from the loaded
/// DBC set plus every RBS element's per-message overrides (an
/// override replaces the DBC default per field — ADR 0027). Called
/// alongside the calc-resolution refresh whenever DBCs, project
/// buses, or RBS configs change.
pub(crate) fn rebuild_verification(state: &AppState) {
    let overrides: Vec<(String, u32, bool, cannet_dbc::CalculatedFieldsConfig)> = {
        let rbs_guard = state.rbs();
        let dbs = state.databases();
        let model = state.decode_model(&dbs);
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
                        let Ok(can_id) = CanId::new(id, extended) else {
                            continue;
                        };
                        let spec = ipc::CalcFieldsSpec {
                            counter: msg.counter.clone(),
                            crc: msg.crc.clone(),
                        };
                        let Ok(override_config) = spec.to_config() else {
                            continue;
                        };
                        // Per-field layering over the DBC default —
                        // the *defining* database's, resolved once
                        // (ADR 0054), so a designation never comes
                        // from a file that does not describe this
                        // message.
                        let dbc_default = model
                            .message_source(Some(bus_id.as_str()), id, extended)
                            .and_then(|d| d.db.dbc_calculated_fields(can_id))
                            .cloned()
                            .unwrap_or_default();
                        let merged = merge_calc_override(dbc_default, Some(override_config));
                        if !merged.is_empty() {
                            out.push((bus_id.clone(), id, extended, merged));
                        }
                    }
                }
            }
        }
        out
    };
    let dbs = state.databases();
    state
        .verifier
        .rebuild_configs(&state.decode_model(&dbs), &overrides);
}

/// Re-resolve every TX-registry entry's calculated fields against the
/// current DBC set. Called whenever either side changes — a DBC is
/// added / removed / rescoped / auto-reloaded, a project is opened,
/// or an entry is edited. A resolution failure clears that entry's
/// fields (the frame still transmits, without recompute) and warns on
/// the system log.
pub(crate) fn refresh_calc_resolutions(app: &AppHandle) {
    let state: State<'_, AppState> = app.state();
    let dbs = state.databases();
    let model = state.decode_model(&dbs);
    let mut registry = state.transmit_frames();
    for (id, request, spec) in registry.resolution_inputs() {
        match resolve_effective_calc(&model, &request, spec.as_ref()) {
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
