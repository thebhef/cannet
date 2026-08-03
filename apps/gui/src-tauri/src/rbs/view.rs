//! View shaping: the host-assembled panel tree one RBS element
//! renders — the view data model, the per-message shaping helper, and
//! the `rbs_view` / `rbs_crc_algorithms` query commands (ADR 0028).

use std::collections::BTreeMap;

use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;
use crate::ipc::{CalcFieldsSpec, CounterSpec, CrcSpec};

use super::file_model::{parse_message_key, RbsMessage, RbsValue};
use super::runtime::{for_each_scoped_message, reconstruct_payload, row_id};

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
    let rbs = state.rbs();
    let Some(element) = rbs.elements.get(&element_id) else {
        return Ok(None);
    };
    let dbs = state.databases();
    let registry = state.transmit_frames();
    let sessions = state.remote_sessions();

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
