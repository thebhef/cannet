//! The RBS IPC command surface: load / save / mutate an element's
//! `.cannet_rbs` document and query dirty state (ADR 0028). Each
//! `#[tauri::command]` runs the runtime reconciliation tail after a
//! mutation.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;
use crate::ipc::{CounterSpec, CrcSpec};
use crate::sys_info;

use super::file_model::{disabled_key, RbsBus, RbsEcu, RbsFile, RbsMessage, RbsValue};
use super::runtime::{
    notify_schedule_change, refresh_all_elements, refresh_element, sync_schedules, RbsElementState,
};

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
        let seeded = state.rbs().ensure_seeded(&element_id);
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
        let mut rbs = state.rbs();
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
    let seeded = state.rbs().ensure_seeded(&element_id);
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
        let mut rbs = state.rbs();
        rbs.elements.remove(&element_id);
    }
    let mut registry = state.transmit_frames();
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
        let mut rbs = state.rbs();
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
        let mut rbs = state.rbs();
        let Some(element) = rbs.elements.get_mut(&element_id) else {
            return Ok(());
        };
        let started = run && !element.run;
        element.run = run;
        started
    };
    if started {
        let mut registry = state.transmit_frames();
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
        let mut rbs = state.rbs();
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
        let mut rbs = state.rbs();
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
        let mut rbs = state.rbs();
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
        let rbs = state.rbs();
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
        let mut rbs = state.rbs();
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
        let rbs = state.rbs();
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
        let mut rbs = state.rbs();
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
    let rbs = state.rbs();
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
#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for the non-atomic RBS save:
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
