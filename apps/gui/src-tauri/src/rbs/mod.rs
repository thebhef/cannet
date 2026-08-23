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

mod file_model;

pub use file_model::{format_message_key, parse_message_key, RbsFile, RbsMessage, RbsValue};

mod runtime;

pub use runtime::RbsRuntime;
pub(crate) use runtime::{refresh_all_elements, stop_elements_owning};

mod view;

pub use view::{rbs_crc_algorithms, rbs_view};
// Tauri's `#[command]` macro emits hidden `__cmd__*` /
// `__tauri_command_name_*` helpers next to each command fn;
// re-export them so `generate_handler![rbs::rbs_view, ...]` in
// lib.rs resolves the relocated commands.
pub use view::{
    __cmd__rbs_crc_algorithms, __cmd__rbs_view, __tauri_command_name_rbs_crc_algorithms,
    __tauri_command_name_rbs_view,
};

mod signals;

pub use signals::rbs_signal_rows;
pub use signals::{__cmd__rbs_signal_rows, __tauri_command_name_rbs_signal_rows};

pub(crate) mod watch;

mod commands;

pub use commands::{
    rbs_dirty, rbs_dismiss_disk_change, rbs_init, rbs_load, rbs_save, rbs_save_as, rbs_set_calc,
    rbs_set_enabled, rbs_set_kill_switch, rbs_set_period, rbs_set_run, rbs_set_signal,
    rbs_sync_project_buses, rbs_unload,
};
// Hidden tauri command helpers (see the view re-export note above).
pub use commands::{
    __cmd__rbs_dirty, __cmd__rbs_dismiss_disk_change, __cmd__rbs_init, __cmd__rbs_load,
    __cmd__rbs_save, __cmd__rbs_save_as, __cmd__rbs_set_calc, __cmd__rbs_set_enabled,
    __cmd__rbs_set_kill_switch, __cmd__rbs_set_period, __cmd__rbs_set_run, __cmd__rbs_set_signal,
    __cmd__rbs_sync_project_buses, __cmd__rbs_unload, __tauri_command_name_rbs_dirty,
    __tauri_command_name_rbs_dismiss_disk_change, __tauri_command_name_rbs_init,
    __tauri_command_name_rbs_load, __tauri_command_name_rbs_save, __tauri_command_name_rbs_save_as,
    __tauri_command_name_rbs_set_calc, __tauri_command_name_rbs_set_enabled,
    __tauri_command_name_rbs_set_kill_switch, __tauri_command_name_rbs_set_period,
    __tauri_command_name_rbs_set_run, __tauri_command_name_rbs_set_signal,
    __tauri_command_name_rbs_sync_project_buses, __tauri_command_name_rbs_unload,
};
