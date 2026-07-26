//! Rest-of-bus simulation: the `.cannet_rbs` file model and its host
//! runtime (ADR 0028).
//!
//! An RBS config is a human-editable JSON document of **sparse
//! overrides** nested `bus → ecu → message`: a signal absent from a
//! message's `signals` keeps tracking its DBC default
//! (`GenSigStartValue`, else the file's `fill_bit`); `period_ms`
//! absent falls back to `GenMsgCycleTime`; `counter` / `crc` absent
//! fall back to the DBC's `CannetCounter` / `CannetCrc` attributes
//! (ADR 0027). Bus keys are the project's *logical bus names*; message
//! keys are hex CAN ids with a trailing `x` marking extended ids.
//!
//! At runtime **every DBC message on each configured bus** becomes a
//! provenance-tagged entry in the one
//! [`crate::transmit_frames::TransmitFrameRegistry`] (`rbs:<element>` —
//! excluded from the transmit panel and the project snapshot), with a
//! payload buffer reconstructed **fill bit → DBC defaults →
//! overrides** (a message needs a file entry only to carry
//! overrides). Messages are **enabled by default** — rest-of-bus:
//! everything plays unless muted via the flat `disabled_messages`
//! list. Whether an entry is *scheduled* is the AND of the element's
//! Run flag, the bus / ECU enables, the message not being muted, and
//! the global kill-switch; actual wire transmission additionally
//! gates on per-bus connectivity inside the scheduler (a disconnected
//! bus keeps ticking and resumes on reconnect). Reconciliation is
//! idempotent: [`runtime::sync_schedules`] recomputes desired-running for
//! every row (from the row keys the provenance tag carries — no DBC
//! walk) and starts / stops the difference.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::ipc::{CalcFieldsSpec, CounterSpec, CrcSpec};
use crate::app_state::AppState;
use crate::sys_info;

mod file_model;

pub use file_model::{
    format_message_key, parse_message_key, RbsBus, RbsEcu, RbsFile, RbsMessage, RbsValue,
};
use file_model::disabled_key;

mod runtime;

pub use runtime::{RbsElementState, RbsRuntime};
pub(crate) use runtime::refresh_all_elements;
use runtime::{
    for_each_scoped_message, notify_schedule_change, reconstruct_payload, refresh_element, row_id,
    sync_schedules,
};


// ---------------------------------------------------------------------
// IPC commands
// ---------------------------------------------------------------------

/// Load (or reload) a `.cannet_rbs` file for an RBS element. The run
/// flag starts/stays as the element previously had it only when
/// reloading the same element id; a fresh load starts stopped — the
/// frontend pushes the project-persisted Run flag separately via
/// [`rbs_set_run`].
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_load(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    path: String,
) -> Result<(), String> {
    // On any failure the element still gets state — the seeded
    // file-less default — so its panel shows the usual tree instead
    // of nothing (the error is on the system log; the element's path
    // is left unset so a later Save can't clobber the unreadable
    // file).
    let fallback = |msg: String| {
        crate::sys_error!(&app, "rbs", "{msg}");
        let seeded = state
            .rbs
            .lock()
            .expect("rbs mutex poisoned")
            .ensure_seeded(&element_id);
        if seeded {
            refresh_element(&app, &element_id);
        }
        msg
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => return Err(fallback(format!("failed to read RBS file at {path}: {e}"))),
    };
    let file = match RbsFile::parse(&text) {
        Ok(f) => f,
        Err(e) => return Err(fallback(format!("RBS file at {path}: {e}"))),
    };
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        let run = rbs.elements.get(&element_id).is_some_and(|e| e.run);
        rbs.elements.insert(
            element_id.clone(),
            RbsElementState {
                path: Some(path.clone()),
                file,
                dirty: false,
                run,
            },
        );
    }
    sys_info!(&app, "rbs", "loaded RBS config {path}");
    refresh_element(&app, &element_id);
    Ok(())
}


/// Ensure an element has host state. A fresh RBS element needs no
/// file: it starts as an in-memory config pre-seeded with the
/// project's current logical buses, and only touches disk when the
/// user saves (`rbs_save` / Save All prompt for a path). A no-op for
/// an element that's already loaded.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_init(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
) -> Result<(), String> {
    let seeded = state
        .rbs
        .lock()
        .expect("rbs mutex poisoned")
        .ensure_seeded(&element_id);
    if seeded {
        refresh_element(&app, &element_id);
    }
    Ok(())
}

/// Tear down an element's rows (element removed / project closing).
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_unload(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
) -> Result<(), String> {
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        rbs.elements.remove(&element_id);
    }
    let mut registry = state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned");
    for id in registry.rbs_row_ids(&element_id) {
        registry.remove(&id);
        state.transmit_scheduler.stop(id);
    }
    drop(registry);
    let _ = app.emit("rbs-changed", element_id);
    Ok(())
}

/// Push the project's logical-bus list (id, name pairs). RBS bus keys
/// resolve against the *names*; the frontend (which owns the project)
/// calls this on open and on any bus add / rename / remove.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_sync_project_buses(
    app: AppHandle,
    state: State<'_, AppState>,
    buses: Vec<(String, String)>,
) -> Result<(), String> {
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        rbs.project_buses = buses;
    }
    refresh_all_elements(&app);
    Ok(())
}

/// Set an element's Run flag (the project persists it; default off).
/// false→true seeds every row's counter at 0 (ADR 0028: counters seed
/// when the element starts running) before scheduling.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_set_run(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    run: bool,
) -> Result<(), String> {
    let started = {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        let Some(element) = rbs.elements.get_mut(&element_id) else {
            return Ok(());
        };
        let started = run && !element.run;
        element.run = run;
        started
    };
    if started {
        let mut registry = state
            .transmit_frames
            .lock()
            .expect("transmit_frames mutex poisoned");
        for id in registry.rbs_row_ids(&element_id) {
            registry.reset_counter(&id);
        }
    }
    sync_schedules(&state);
    let _ = app.emit("rbs-changed", element_id);
    Ok(())
}

/// The global RBS kill-switch (runtime-only, never persisted): on
/// stops every RBS row everywhere; off resumes whatever the model
/// says should run.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_set_kill_switch(
    app: AppHandle,
    state: State<'_, AppState>,
    on: bool,
) -> Result<(), String> {
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        rbs.kill_switch = on;
    }
    sys_info!(
        &app,
        "rbs",
        "global RBS kill-switch {}",
        if on {
            "ON — all simulation transmit stopped"
        } else {
            "off"
        }
    );
    sync_schedules(&state);
    // Dedicated event so every surface that mirrors the runtime-only
    // flag (panel button, palette toggle) tracks the same value.
    let _ = app.emit("rbs-kill-switch", on);
    let _ = app.emit("rbs-changed", "*");
    Ok(())
}

/// Mutate one element's file document in place, mark it dirty, and
/// run the rebuild/resolve/sync/notify tail. The closure returns
/// `Err` to reject the edit (nothing is marked dirty).
fn edit_file<F>(app: &AppHandle, state: &AppState, element_id: &str, edit: F) -> Result<(), String>
where
    F: FnOnce(&mut RbsFile) -> Result<(), String>,
{
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        let element = rbs
            .elements
            .get_mut(element_id)
            .ok_or_else(|| format!("no RBS element {element_id}"))?;
        edit(&mut element.file)?;
        element.dirty = true;
    }
    refresh_element(app, element_id);
    Ok(())
}

/// Address one message entry in a file, creating the path (bus → ecu
/// → message) if missing.
fn entry_mut<'a>(file: &'a mut RbsFile, bus: &str, ecu: &str, message: &str) -> &'a mut RbsMessage {
    file.buses
        .entry(bus.to_string())
        .or_insert_with(RbsBus::new)
        .ecus
        .entry(ecu.to_string())
        .or_insert_with(RbsEcu::new)
        .messages
        .entry(message.to_string())
        .or_insert_with(RbsMessage::new)
}

/// Set an `enabled` flag. `ecu` / `message` absent address the outer
/// levels. A message toggle edits the flat `disabled_messages` list
/// (messages are enabled by default); bus / ECU toggles edit their
/// entries (created as needed — adding a missing bus brings its DBC
/// tree into the simulation). Toggling an outer level preserves the
/// inner state (ADR 0028).
///
/// Pure-scheduling edits skip the row rebuild: only a *new bus*
/// changes what rows exist.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_set_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    bus: String,
    ecu: Option<String>,
    message: Option<String>,
    enabled: bool,
) -> Result<(), String> {
    let new_bus = {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        let element = rbs
            .elements
            .get_mut(&element_id)
            .ok_or_else(|| format!("no RBS element {element_id}"))?;
        let new_bus = !element.file.buses.contains_key(&bus);
        match (&ecu, &message) {
            (None, _) => {
                element
                    .file
                    .buses
                    .entry(bus)
                    .or_insert_with(RbsBus::new)
                    .enabled = enabled;
            }
            (Some(ecu), None) => {
                element
                    .file
                    .buses
                    .entry(bus)
                    .or_insert_with(RbsBus::new)
                    .ecus
                    .entry(ecu.clone())
                    .or_insert_with(RbsEcu::new)
                    .enabled = enabled;
            }
            (Some(_), Some(message)) => {
                let key = disabled_key(&bus, message);
                if enabled {
                    element.file.disabled_messages.remove(&key);
                } else {
                    element.file.disabled_messages.insert(key);
                }
            }
        }
        element.dirty = true;
        new_bus
    };
    if new_bus {
        refresh_element(&app, &element_id);
    } else {
        notify_schedule_change(&app, &element_id);
    }
    Ok(())
}

/// Addresses one message entry in an element's file — the `bus →
/// ecu → message` key path the per-message mutation commands share.
#[derive(Deserialize, Clone, Debug)]
pub struct RbsTarget {
    pub bus: String,
    pub ecu: String,
    pub message: String,
}

/// Set or clear a message's period override.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_set_period(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    target: RbsTarget,
    period_ms: Option<u32>,
) -> Result<(), String> {
    edit_file(&app, state.inner(), &element_id, |file| {
        entry_mut(file, &target.bus, &target.ecu, &target.message).period_ms = period_ms;
        Ok(())
    })
}

/// Set a signal-value override (`value` is a number, an enum label,
/// or a `0x…` hex string), or clear it with `None` — the signal goes
/// back to tracking its DBC default.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_set_signal(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    target: RbsTarget,
    signal: String,
    value: Option<RbsValue>,
) -> Result<(), String> {
    edit_file(&app, state.inner(), &element_id, |file| {
        let entry = entry_mut(file, &target.bus, &target.ecu, &target.message);
        match value {
            Some(v) => {
                entry.signals.insert(signal, v);
            }
            None => {
                entry.signals.remove(&signal);
            }
        }
        Ok(())
    })
}

/// Set or clear a message's calculated-field overrides (each replaces
/// the DBC default wholesale for that field — ADR 0027).
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_set_calc(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    target: RbsTarget,
    counter: Option<CounterSpec>,
    crc: Option<CrcSpec>,
) -> Result<(), String> {
    edit_file(&app, state.inner(), &element_id, |file| {
        let entry = entry_mut(file, &target.bus, &target.ecu, &target.message);
        entry.counter = counter;
        entry.crc = crc;
        Ok(())
    })
}

/// Write an element's document back to its file (pretty-printed) and
/// clear the dirty flag. Errors when the element has never been
/// saved — the caller routes through [`rbs_save_as`] with a
/// user-picked path in that case.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_save(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
) -> Result<(), String> {
    let path = {
        let rbs = state.rbs.lock().expect("rbs mutex poisoned");
        rbs.elements
            .get(&element_id)
            .ok_or_else(|| format!("no RBS element {element_id}"))?
            .path
            .clone()
            .ok_or("RBS config has no file yet — pick a path (Save As)")?
    };
    write_element(&app, state.inner(), &element_id, &path)
}

/// First save of a file-less config (or an explicit re-point): set
/// the element's path and write.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_save_as(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    path: String,
) -> Result<(), String> {
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        let element = rbs
            .elements
            .get_mut(&element_id)
            .ok_or_else(|| format!("no RBS element {element_id}"))?;
        element.path = Some(path.clone());
    }
    write_element(&app, state.inner(), &element_id, &path)
}

/// Serialize and write `file` to `path`, via a temp-file + rename
/// (ADR 0011's persistence contract, shared with the project file): a
/// failure partway through the write can't leave a truncated RBS file
/// on disk in place of the last good save.
fn write_rbs_file(path: &str, file: &RbsFile) -> std::io::Result<()> {
    crate::persisted_json::write_json_atomic(std::path::Path::new(path), file)
}

fn write_element(
    app: &AppHandle,
    state: &AppState,
    element_id: &str,
    path: &str,
) -> Result<(), String> {
    let file = {
        let rbs = state.rbs.lock().expect("rbs mutex poisoned");
        let element = rbs
            .elements
            .get(element_id)
            .ok_or_else(|| format!("no RBS element {element_id}"))?;
        element.file.clone()
    };
    write_rbs_file(path, &file).map_err(|e| {
        let msg = format!("failed to write RBS file to {path}: {e}");
        crate::sys_error!(app, "rbs", "{msg}");
        msg
    })?;
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        if let Some(element) = rbs.elements.get_mut(element_id) {
            element.dirty = false;
        }
    }
    sys_info!(app, "rbs", "saved RBS config {path}");
    let _ = app.emit("rbs-changed", element_id.to_string());
    Ok(())
}

/// One dirty element, for Save All and the exit prompt.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RbsDirtyRecord {
    pub element_id: String,
    /// `None` = never saved; Save All prompts for a path.
    pub path: Option<String>,
}

/// Every element with unsaved override edits.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_dirty(state: State<'_, AppState>) -> Result<Vec<RbsDirtyRecord>, String> {
    let rbs = state.rbs.lock().expect("rbs mutex poisoned");
    let mut out: Vec<RbsDirtyRecord> = rbs
        .elements
        .iter()
        .filter(|(_, e)| e.dirty)
        .map(|(id, e)| RbsDirtyRecord {
            element_id: id.clone(),
            path: e.path.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.element_id.cmp(&b.element_id));
    Ok(out)
}

// ---------------------------------------------------------------------
// The view query
// ---------------------------------------------------------------------

/// The whole tree one RBS panel renders, assembled host-side: the
/// file's buses overlaid on each resolved bus's DBC content (every
/// DBC message grouped per transmitter ECU, whether or not the file
/// lists it), with effective values decoded from the reconstructed
/// buffers.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RbsView {
    pub element_id: String,
    /// `None` until the config is first saved.
    pub path: Option<String>,
    pub fill_bit: u8,
    pub dirty: bool,
    pub run: bool,
    pub kill_switch: bool,
    pub buses: Vec<RbsBusView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RbsBusView {
    /// The file's key — the project logical-bus *name*.
    pub key: String,
    /// The resolved project bus id, or `None` when no project bus has
    /// this name (rows render inert).
    pub bus_id: Option<String>,
    /// Whether an active session currently routes this bus.
    pub connected: bool,
    pub enabled: bool,
    pub ecus: Vec<RbsEcuView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RbsEcuView {
    pub name: String,
    pub enabled: bool,
    pub messages: Vec<RbsMessageView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
// The flags are independent facts (file membership, enables, schedule
// state, FD-ness, per-field override markers) — collapsing them would
// erase which input each came from.
#[allow(clippy::struct_excessive_bools)]
pub struct RbsMessageView {
    /// The file key form (`0x…` / `0x…x`).
    pub key: String,
    pub message_id: u32,
    pub extended: bool,
    /// DBC message name; `None` when no scoped DBC defines the id
    /// (file-listed but unknown — inert row).
    pub name: Option<String>,
    /// Whether the file lists this message (it carries overrides /
    /// an enable). DBC messages not in the file render disabled.
    pub in_file: bool,
    pub enabled: bool,
    /// Scheduled right now (run flag && enables && !kill-switch).
    pub running: bool,
    /// The effective period: the file override, else
    /// `GenMsgCycleTime`. `None` = no period anywhere — the message
    /// can't be enabled.
    pub period_ms: Option<u32>,
    pub period_overridden: bool,
    pub is_fd: bool,
    pub expected_len: usize,
    /// Current payload buffer (reconstructed; live entries show the
    /// registry buffer with the last-applied calculated fields).
    pub data: Vec<u8>,
    /// Effective designations (override else DBC default), spec-shaped.
    pub counter: Option<CounterSpec>,
    pub counter_overridden: bool,
    pub crc: Option<CrcSpec>,
    pub crc_overridden: bool,
    /// DBC transmitter disagreeing with the file's ECU placement.
    pub transmitter_mismatch: Option<String>,
    pub signals: Vec<RbsSignalView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RbsSignalView {
    pub name: String,
    pub unit: String,
    /// Decoded physical value from the current buffer (`None` for an
    /// inactive multiplexed arm).
    pub value: Option<f64>,
    /// `VAL_` label for the decoded value, if any.
    pub label: Option<String>,
    /// Whether the file overrides this signal.
    pub overridden: bool,
    /// The override as written (number rendered, or the raw string).
    pub override_text: Option<String>,
    /// `"counter"` / `"crc"` when this signal is the effective
    /// destination of a calculated field (cells render read-only).
    pub calc_role: Option<&'static str>,
    pub factor: f64,
    pub offset: f64,
    pub min: f64,
    pub max: f64,
    pub size: u32,
    pub signed: bool,
    pub float_kind: &'static str,
    pub has_value_table: bool,
}

/// Assemble the panel view for one element. `None` if the element
/// isn't loaded.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    clippy::too_many_lines,
    clippy::unused_async
)]
pub async fn rbs_view(
    state: State<'_, AppState>,
    element_id: String,
) -> Result<Option<RbsView>, String> {
    let rbs = state.rbs.lock().expect("rbs mutex poisoned");
    let Some(element) = rbs.elements.get(&element_id) else {
        return Ok(None);
    };
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    let registry = state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned");
    let sessions = state
        .remote_sessions
        .lock()
        .expect("remote_sessions mutex poisoned");

    let mut buses = Vec::new();
    for (bus_key, bus) in &element.file.buses {
        let bus_id = rbs.resolve_bus(bus_key);
        let connected = bus_id
            .as_deref()
            .is_some_and(|b| crate::session::resolve_bus_route(&sessions, b).is_some());

        // ECU grouping: every message of every scoped DBC, grouped by
        // transmitter, merged with the file's (possibly DBC-unknown)
        // entries.
        let mut ecus: BTreeMap<String, Vec<RbsMessageView>> = BTreeMap::new();
        if let Some(bus_id) = &bus_id {
            for_each_scoped_message(&dbs, bus_id, |db, key, id, desc, ecu_name| {
                // The file entry, if the message is listed — under *any*
                // ECU key (hand-edits may misplace it; the DBC grouping
                // wins, with a warning).
                let file_entry: Option<(&String, &RbsMessage)> = bus
                    .ecus
                    .iter()
                    .find_map(|(ek, e)| e.messages.get(key).map(|m| (ek, m)));
                let view = build_message_view(
                    MessageViewInputs {
                        element_id: &element_id,
                        bus_key,
                        key,
                        enabled: element.file.is_message_enabled(bus_key, key),
                        id,
                        db,
                        desc,
                        file_entry,
                        fill_bit: element.file.fill_bit,
                        ecu_name,
                    },
                    &registry,
                );
                ecus.entry(ecu_name.to_string()).or_default().push(view);
            });
        }
        // File-listed messages no DBC defines (or for an unresolved
        // bus): inert rows under their file ECU.
        for (ecu_key, ecu) in &bus.ecus {
            for (msg_key, msg) in &ecu.messages {
                let already = ecus.values().flatten().any(|m| &m.key == msg_key);
                if already {
                    continue;
                }
                let (message_id, extended) = parse_message_key(msg_key).unwrap_or((0, false));
                ecus.entry(ecu_key.clone())
                    .or_default()
                    .push(RbsMessageView {
                        key: msg_key.clone(),
                        message_id,
                        extended,
                        name: None,
                        in_file: true,
                        enabled: element.file.is_message_enabled(bus_key, msg_key),
                        running: false,
                        period_ms: msg.period_ms,
                        period_overridden: msg.period_ms.is_some(),
                        is_fd: false,
                        expected_len: 0,
                        data: Vec::new(),
                        counter: msg.counter.clone(),
                        counter_overridden: msg.counter.is_some(),
                        crc: msg.crc.clone(),
                        crc_overridden: msg.crc.is_some(),
                        transmitter_mismatch: None,
                        signals: Vec::new(),
                    });
            }
        }

        let ecu_views: Vec<RbsEcuView> = ecus
            .into_iter()
            .map(|(name, mut messages)| {
                messages.sort_by_key(|a| (a.extended, a.message_id));
                let enabled = bus.ecus.get(&name).is_none_or(|e| e.enabled);
                RbsEcuView {
                    name,
                    enabled,
                    messages,
                }
            })
            .collect();
        buses.push(RbsBusView {
            key: bus_key.clone(),
            bus_id,
            connected,
            enabled: bus.enabled,
            ecus: ecu_views,
        });
    }

    Ok(Some(RbsView {
        element_id: element_id.clone(),
        path: element.path.clone(),
        fill_bit: element.file.fill_bit,
        dirty: element.dirty,
        run: element.run,
        kill_switch: rbs.kill_switch,
        buses,
    }))
}

/// Inputs for one message row's view assembly — bundled so the
/// builder's signature stays readable.
#[derive(Clone, Copy)]
struct MessageViewInputs<'a> {
    element_id: &'a str,
    bus_key: &'a str,
    key: &'a str,
    /// From the file's `disabled_messages` (default enabled).
    enabled: bool,
    id: cannet_core::CanId,
    db: &'a cannet_dbc::Database,
    desc: &'a cannet_dbc::MessageDescriptor,
    file_entry: Option<(&'a String, &'a RbsMessage)>,
    fill_bit: u8,
    ecu_name: &'a str,
}

fn build_message_view(
    inputs: MessageViewInputs<'_>,
    registry: &crate::transmit_frames::TransmitFrameRegistry,
) -> RbsMessageView {
    let MessageViewInputs {
        element_id,
        bus_key,
        key,
        enabled,
        id,
        db,
        desc,
        file_entry,
        fill_bit,
        ecu_name,
    } = inputs;
    let default_msg = RbsMessage::new();
    let (file_ecu, msg, in_file) = match file_entry {
        Some((ecu_key, m)) => (Some(ecu_key.as_str()), m, true),
        None => (None, &default_msg, false),
    };

    // Live entries show the registry's buffer (it carries the last
    // applied counter / CRC bytes); unlisted rows reconstruct on the
    // fly.
    let registry_data = registry.request_data(&row_id(element_id, bus_key, key));
    let running = registry.is_running(&row_id(element_id, bus_key, key));
    let data = registry_data.unwrap_or_else(|| reconstruct_payload(db, id, desc, msg, fill_bit).0);

    // Effective designations: override else DBC default (per field).
    let dbc_calc = CalcFieldsSpec::from_config(&desc.calc_fields);
    let counter = msg.counter.clone().or(dbc_calc.counter);
    let crc = msg.crc.clone().or(dbc_calc.crc);

    let decoded = db.decode_raw(id, &data);
    let signals = desc
        .signals
        .iter()
        .map(|s| {
            let dec = decoded
                .as_ref()
                .and_then(|d| d.signals.iter().find(|x| x.name == s.name));
            let override_value = msg.signals.get(&s.name);
            let calc_role = if counter.as_ref().is_some_and(|c| c.signal == s.name) {
                Some("counter")
            } else if crc.as_ref().is_some_and(|c| c.signal == s.name) {
                Some("crc")
            } else {
                None
            };
            RbsSignalView {
                name: s.name.clone(),
                unit: s.unit.clone(),
                value: dec.map(|d| d.value),
                label: dec.and_then(|d| d.label.map(ToString::to_string)),
                overridden: override_value.is_some(),
                override_text: override_value.map(|v| match v {
                    RbsValue::Number(n) => n.to_string(),
                    RbsValue::Text(t) => t.clone(),
                }),
                calc_role,
                factor: s.factor,
                offset: s.offset,
                min: s.min,
                max: s.max,
                size: s.size,
                signed: s.signed,
                float_kind: match s.float_kind {
                    cannet_dbc::FloatKind::Integer => "integer",
                    cannet_dbc::FloatKind::Float32 => "float32",
                    cannet_dbc::FloatKind::Float64 => "float64",
                },
                has_value_table: s.has_value_table,
            }
        })
        .collect();

    let transmitter_mismatch = match (file_ecu, &desc.transmitter) {
        (Some(fe), Some(t)) if fe != t && fe != ecu_name => Some(t.clone()),
        _ => None,
    };

    RbsMessageView {
        key: key.to_string(),
        message_id: id.raw(),
        extended: id.is_extended(),
        name: Some(desc.name.clone()),
        in_file,
        enabled,
        running,
        period_ms: msg.period_ms.or(desc.gen_msg_cycle_time_ms),
        period_overridden: msg.period_ms.is_some(),
        is_fd: desc.is_fd,
        expected_len: desc.expected_len,
        data,
        counter,
        counter_overridden: msg.counter.is_some(),
        crc,
        crc_overridden: msg.crc.is_some(),
        transmitter_mismatch,
        signals,
    }
}

/// The available CRC algorithm names (the `crc-catalog` list) for the
/// GUI's algorithm combo.
#[tauri::command]
pub fn rbs_crc_algorithms() -> Vec<&'static str> {
    cannet_dbc::named_crc_algorithms()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for the non-atomic RBS save (task 0030 item 7):
    /// `write_element` used to `std::fs::write` straight to the target
    /// path, so a write failure partway could leave a corrupted RBS
    /// file in place of the last good save. Force the write to fail by
    /// blocking the temp-file step (a directory sits where the `.tmp`
    /// sibling needs to go) and confirm the original, valid file on
    /// disk is left completely untouched.
    #[test]
    fn save_leaves_the_original_file_untouched_when_the_write_fails() {
        let dir = std::env::temp_dir().join(format!("cannet-rbs-atomic-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.cannet_rbs");
        let original = serde_json::to_string_pretty(&RbsFile::new()).unwrap();
        std::fs::write(&path, &original).unwrap();

        let mut tmp = path.clone().into_os_string();
        tmp.push(".tmp");
        std::fs::create_dir(&tmp).unwrap();

        let result = write_rbs_file(path.to_str().unwrap(), &RbsFile::new());

        assert!(
            result.is_err(),
            "the write must fail when the temp file can't be created"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            original,
            "a failed save must not touch the previously-saved file"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

}
