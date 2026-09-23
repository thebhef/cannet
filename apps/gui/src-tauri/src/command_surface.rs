//! The rule about which host commands may be synchronous, enforced over
//! the source rather than left to review.
//!
//! A synchronous Tauri command runs on the webview's IPC thread, and
//! every other command queues behind it — including `report_js_heap`,
//! whose arrival *is* the host's evidence that the window is alive
//! ([`crate::crash`]). So a synchronous command that walks a directory,
//! removes one, reads a file of unbounded size, waits on a socket or
//! waits on a lock a long job holds does not just take its own time: it
//! stops the frontend, and the host records the stop as a
//! `frontend unresponsive` warning.
//!
//! The rule is [ADR 0048](../../../docs/adr/0048-no-lock-across-rebuild.md)'s:
//! a body of that shape is `async` and runs through
//! [`crate::sampling::off_async_workers`], which hands it to the
//! blocking pool so neither the IPC thread nor an async-runtime worker
//! is held for its duration. What is left synchronous is state already
//! in memory, one small document under the config directory, or a
//! computation whose size is a loaded DBC — the set named below.
//!
//! The check reads the crate's own sources, so a new command is caught
//! the moment it is written, before anyone has to have noticed what its
//! body does.

/// Every `#[tauri::command]` allowed to be synchronous, with the reason
/// its group is bounded.
///
/// **Adding a name here is a claim about the body**, and the claim is
/// the one above: it touches memory, one small config-directory
/// document, or a DBC-sized computation, and it waits on nothing. A
/// command that walks the filesystem, spawns a process, joins a thread
/// or talks to the network does not belong in this list — it belongs on
/// the blocking pool.
#[cfg(test)]
const SYNCHRONOUS_COMMANDS: &[&str] = &[
    // Snapshots of state the host already holds in memory.
    "active_project_is_auto_located",
    "addresses_needing_trust",
    "app_version",
    "capture_extent",
    "fetch_field_validity",
    "fetch_notes",
    "fetch_system_log",
    "get_bus_health",
    "get_connection_states",
    "get_discovered_servers",
    "get_interfaces",
    "get_logger_statuses",
    "get_server_list",
    "get_server_prompts",
    "get_sidecar_status",
    "list_local_bus_bridges",
    "list_signal_units",
    "list_transmit_frames",
    "list_view_signals",
    "signal_pyramids_rebuilding",
    "diag_autostart",
    "diag_enabled",
    // Computations whose size is the loaded DBC set, not the capture.
    "check_unit_definition",
    "decode_frame",
    "describe_message",
    "encode_frame",
    "evaluate_signal_generators",
    "get_setting_descriptors",
    "list_dbc_collisions",
    "list_dbc_content",
    "list_file_backed_content",
    "list_math_signals",
    "list_signals",
    "list_unit_mappings",
    "list_unit_picker",
    "list_units",
    "list_value_tables",
    "preview_export_template",
    "rbs_crc_algorithms",
    "resolve_display_units",
    "validate_signal_generator",
    // In-memory mutations that emit: the change lands in host state and
    // an event tells the views. Nothing here reaches the filesystem
    // beyond the notes store's own small document.
    "add_note",
    "cancel_export",
    "cancel_import",
    "clear_notes",
    "clear_system_log",
    "clear_transmit_frames",
    "clear_view_signals",
    "create_local_virtual_bus",
    "describe_note",
    "detach_local_bus_bridge",
    "diag_capture_start",
    "diag_push",
    // Drops the session handle; the worker disconnects itself, nothing
    // is joined here.
    "disconnect_remote_server",
    "drop_local_virtual_bus",
    "exit_process",
    "gui_emit_system_log",
    "link_events",
    "recolor_note",
    "remove_note",
    "remove_transmit_frame",
    "remove_view_signals",
    "rename_note",
    "reorder_transmit_frames",
    "retag_note",
    "set_live_tail_rows",
    "set_note_subjects",
    "set_transmit_frame",
    "set_view_signals",
    "start_periodic_transmit",
    "stop_periodic_transmit",
    "unlink_events",
    "unwatch_interfaces",
    "watch_interfaces",
    // One small document under the config directory (or, for
    // `save_project`, the project file itself): a read or a write of a
    // few kilobytes of JSON, with no directory walk behind it.
    "accept_server_fingerprint",
    "accept_server_insecure",
    "add_server_to_path",
    "diag_capture_finish",
    "forget_server",
    "get_export_state",
    "get_settings",
    "get_settings_overrides",
    "get_state",
    "save_project",
    "set_export_state",
    "set_server_token",
    "set_state",
    "third_party_licenses",
    // The heartbeat itself. It **must** stay synchronous: its arrival on
    // the IPC thread is what proves the thread is turning, so dispatching
    // it anywhere else would measure something other than the window
    // (`crate::crash`).
    "report_js_heap",
    // Cache-invalidating mutations. Each drops the affected decoded
    // pyramids from memory and returns; the level files they leave
    // behind are unlinked by
    // `SignalCacheStore::sweep_unreferenced_in_background`, so no
    // unlinking happens under the gesture (ADR 0048).
    "clear_dbcs",
    "define_math_signal",
    "delete_math_signal",
    "remove_dbc",
    "set_dbc_buses",
    "set_signal_dbc_pick",
    "set_signal_unit",
    "update_math_signal",
    // Offers one frame to the wire without waiting for room in the
    // session's outgoing queue: a full queue comes back as a refusal
    // the caller reports, never as a wait (`session::SessionTx::transmit`).
    "transmit_frame_once",
    // Returns a row per registered project immediately; each row's size
    // is the directory walk ADR 0002 DS-8 calls expensive, and that walk
    // is not this command's to do.
    "list_project_caches",
];

#[cfg(test)]
mod tests {
    use super::SYNCHRONOUS_COMMANDS;
    use std::path::{Path, PathBuf};

    /// One declared command: its name and whether it is `async`.
    struct Command {
        name: String,
        is_async: bool,
        file: PathBuf,
    }

    /// Every `#[tauri::command]` in the crate's sources, read off the
    /// files themselves.
    ///
    /// Source-level rather than reflective because the fact being
    /// checked is a *declaration*: Tauri decides where a command runs
    /// from whether its `fn` is `async`, and nothing at run time can be
    /// asked which it was.
    fn declared_commands() -> Vec<Command> {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        collect_rust_files(&src, &mut files);
        assert!(
            files.len() > 10,
            "expected the crate's sources under {}",
            src.display()
        );
        let mut found = Vec::new();
        for file in files {
            let text = std::fs::read_to_string(&file).unwrap();
            let lines: Vec<&str> = text.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if line.trim() != "#[tauri::command]" {
                    continue;
                }
                // The attribute sits above the `fn`, with any number of
                // further attributes and comments between them.
                let signature = lines[i + 1..]
                    .iter()
                    .find(|l| l.split_whitespace().any(|w| w == "fn"))
                    .unwrap_or_else(|| panic!("no fn after a command attribute in {file:?}"));
                let words: Vec<&str> = signature.split_whitespace().collect();
                let at = words.iter().position(|w| *w == "fn").expect("the fn word");
                let name = words[at + 1]
                    .split(['(', '<'])
                    .next()
                    .expect("a command's fn name")
                    .to_string();
                found.push(Command {
                    name,
                    is_async: at > 0 && words[at - 1] == "async",
                    file: file.clone(),
                });
            }
        }
        found
    }

    fn collect_rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    #[test]
    fn every_synchronous_command_is_one_the_allow_list_names() {
        // The regression guard: a new command that walks a directory,
        // joins a thread or waits on a socket cannot land synchronous
        // unnoticed, because landing synchronous at all fails here until
        // someone writes the name down and says why (ADR 0048).
        let unexpected: Vec<String> = declared_commands()
            .into_iter()
            .filter(|c| !c.is_async && !SYNCHRONOUS_COMMANDS.contains(&c.name.as_str()))
            .map(|c| format!("{} ({})", c.name, c.file.display()))
            .collect();
        assert!(
            unexpected.is_empty(),
            "these commands are synchronous and not on the allow-list in \
             `command_surface.rs`. A synchronous command runs on the IPC \
             thread and stops the UI heartbeat for its duration: make it \
             `async` over `off_async_workers` (ADR 0048), or add it to the \
             list with the reason its body is bounded — {unexpected:?}"
        );
    }

    #[test]
    fn the_allow_list_names_no_command_that_has_gone_or_become_async() {
        // Keeps the list from outliving what it describes: a name left
        // behind would silently re-admit a future command of the same
        // name.
        let commands = declared_commands();
        let stale: Vec<&str> = SYNCHRONOUS_COMMANDS
            .iter()
            .copied()
            .filter(|name| !commands.iter().any(|c| !c.is_async && c.name == *name))
            .collect();
        assert!(
            stale.is_empty(),
            "the allow-list names commands that are no longer synchronous \
             commands — remove them: {stale:?}"
        );
    }

    #[test]
    fn the_command_scan_still_finds_the_whole_surface() {
        // A cheap tripwire on the scan itself: a parse that silently
        // stopped finding commands would make both tests above pass by
        // finding nothing.
        let commands = declared_commands();
        assert!(
            commands.len() > 100,
            "the command scan found only {} commands — it has stopped \
             reading the sources",
            commands.len()
        );
    }
}
