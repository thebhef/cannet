//! Turn the loaded example into a concrete transmit schedule.
//!
//! Rest-of-bus semantics (ADR 0028): **every** DBC message on a
//! configured bus is scheduled unless the RBS file mutes it. Each
//! message's cadence is its RBS `period_ms` override, else the DBC's
//! `GenMsgCycleTime`; a message with neither has no cadence and is
//! skipped. Each payload is built fill bit → DBC `GenSigStartValue`
//! defaults → RBS signal overrides, then encoded through the production
//! [`cannet_dbc::Database::encode_frame`]. The result is a flat list of
//! [`ScheduledMessage`]s the per-mode workloads replay.

use cannet_core::CanId;
use cannet_dbc::{Database, MessageDescriptor};
use cannet_gui_lib::{format_message_key, RbsFile, RbsMessage, RbsValue};

use crate::LoadedExample;

/// One periodic message in the workload.
#[derive(Debug, Clone)]
pub struct ScheduledMessage {
    /// Logical bus id (project-local).
    pub bus_id: String,
    /// Logical bus name (the RBS key).
    pub bus_name: String,
    /// 0-based channel, assigned by the bus's order in the project.
    pub channel: u8,
    pub can_id: u32,
    pub extended: bool,
    pub is_fd: bool,
    /// Cadence in milliseconds.
    pub period_ms: u32,
    /// Encoded payload (length = the DBC's declared message size).
    pub payload: Vec<u8>,
}

impl ScheduledMessage {
    /// The message's id as a [`CanId`].
    ///
    /// # Panics
    /// Never in practice — the id came from a DBC the schedule builder
    /// already validated.
    #[must_use]
    pub fn canid(&self) -> CanId {
        to_canid(self.can_id, self.extended).expect("schedule holds only valid ids")
    }
}

/// Build the transmit schedule from the loaded example.
#[must_use]
pub fn build_schedule(ex: &LoadedExample) -> Vec<ScheduledMessage> {
    let mut out = Vec::new();

    for (dbc_idx, loaded) in ex.dbcs.iter().enumerate() {
        let dbc_ref = &ex.project.dbcs[dbc_idx];
        // Bus ids this DBC is scoped to; empty `buses` means "all buses".
        let bus_ids: Vec<String> = if dbc_ref.buses.is_empty() {
            ex.project.buses.iter().map(|b| b.id.clone()).collect()
        } else {
            dbc_ref.buses.clone()
        };

        // Collect ids first so the immutable `describe_message` borrow
        // below doesn't overlap the `message_names` iterator borrow.
        let ids: Vec<(u32, bool)> = loaded
            .db
            .message_names()
            .map(|(id, ext, _)| (id, ext))
            .collect();

        for (id, ext) in ids {
            let Some(canid) = to_canid(id, ext) else {
                continue;
            };
            let Some(desc) = loaded.db.describe_message(canid) else {
                continue;
            };
            let msg_key = format_message_key(id, ext);

            for bus_id in &bus_ids {
                let Some(bus) = ex.project.buses.iter().position(|b| &b.id == bus_id) else {
                    continue;
                };
                let bus_name = ex.project.buses[bus].name.clone();
                if !ex.rbs.is_message_enabled(&bus_name, &msg_key) {
                    continue;
                }
                let entry = rbs_entry(&ex.rbs, &bus_name, &msg_key);
                let Some(period_ms) = entry
                    .and_then(|m| m.period_ms)
                    .or(desc.gen_msg_cycle_time_ms)
                    .filter(|p| *p > 0)
                else {
                    continue;
                };
                let payload = build_payload(&loaded.db, canid, &desc, &ex.rbs, entry);
                out.push(ScheduledMessage {
                    bus_id: bus_id.clone(),
                    bus_name,
                    channel: u8::try_from(bus).unwrap_or(0),
                    can_id: id,
                    extended: ext,
                    is_fd: desc.is_fd,
                    period_ms,
                    payload,
                });
            }
        }
    }

    out.sort_by_key(|m| (m.channel, m.can_id));
    out
}

/// Aggregate steady-state frame rate of a schedule, in frames/second.
#[must_use]
pub fn aggregate_rate_hz(schedule: &[ScheduledMessage]) -> f64 {
    schedule
        .iter()
        .map(|m| 1000.0 / f64::from(m.period_ms))
        .sum()
}

fn to_canid(id: u32, extended: bool) -> Option<CanId> {
    if extended {
        CanId::extended(id).ok()
    } else {
        CanId::standard(id).ok()
    }
}

fn rbs_entry<'a>(rbs: &'a RbsFile, bus_name: &str, msg_key: &str) -> Option<&'a RbsMessage> {
    rbs.buses
        .get(bus_name)
        .and_then(|b| b.ecus.values().find_map(|e| e.messages.get(msg_key)))
}

/// Reconstruct a message's payload: fill bit, then DBC start values,
/// then RBS overrides, encoded through the production encoder.
fn build_payload(
    db: &Database,
    canid: CanId,
    desc: &MessageDescriptor,
    rbs: &RbsFile,
    entry: Option<&RbsMessage>,
) -> Vec<u8> {
    let fill = if rbs.fill_bit == 1 { 0xFF } else { 0x00 };
    let mut base = vec![fill; desc.expected_len];

    // Physical values to encode, keyed by signal name. Start with the
    // DBC `GenSigStartValue` defaults, then let RBS overrides replace.
    let mut values: Vec<(String, f64)> = desc
        .signals
        .iter()
        .filter_map(|s| {
            s.start_value_raw
                .map(|raw| (s.name.clone(), raw * s.factor + s.offset))
        })
        .collect();

    if let Some(msg) = entry {
        for (name, val) in &msg.signals {
            let physical = match val {
                RbsValue::Number(n) => Some(*n),
                RbsValue::Text(t) => resolve_label(db, canid, desc, name, t),
            };
            if let Some(p) = physical {
                values.retain(|(n, _)| n != name);
                values.push((name.clone(), p));
            }
        }
    }

    let pairs: Vec<(&str, f64)> = values.iter().map(|(n, v)| (n.as_str(), *v)).collect();
    db.encode_frame(canid, &pairs, &mut base);
    base
}

/// Resolve an enum-label override to a physical value via the signal's
/// `VAL_` table. Returns `None` if the label isn't in the table — the
/// signal then keeps its default (payload correctness isn't what the
/// harness measures, so a bad label is non-fatal).
fn resolve_label(
    db: &Database,
    canid: CanId,
    desc: &MessageDescriptor,
    signal_name: &str,
    label: &str,
) -> Option<f64> {
    let table = db.value_table_for_signal(canid.raw(), canid.is_extended(), signal_name)?;
    let raw = table.iter().find(|e| e.label == label)?.raw;
    let sig = desc.signals.iter().find(|s| s.name == signal_name)?;
    #[allow(clippy::cast_precision_loss)]
    Some(raw as f64 * sig.factor + sig.offset)
}
