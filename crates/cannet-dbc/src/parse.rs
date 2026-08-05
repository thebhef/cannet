//! DBC text → [`Database`] model.
//!
//! Parsing is delegated to the `can-dbc` crate, which produces an AST.
//! This module folds the cannet-specific interpretation on top of it —
//! long-symbol names, per-message / per-signal comments and attributes,
//! `SIG_VALTYPE_` float kinds, the `CannetCounter` / `CannetCrc`
//! calculated-field designations and the `CannetDisplay` render mode —
//! into the indexed [`Database`] the decode / encode / view layers
//! read.

use std::collections::HashMap;

use can_dbc::{
    AttributeDefinition, AttributeValue, AttributeValueType, Comment, Dbc, MessageId,
    MultiplexIndicator, SignalExtendedValueType, Transmitter,
};

use crate::calc;
use crate::model::{
    is_enum, is_raw_field, value_is_raw_integer, Database, DbcAttribute, MessageEntry, SignalEntry,
    ValueTableEntry,
};

impl Database {
    /// Parse a DBC file from text.
    #[allow(clippy::too_many_lines)] // rustfmt's struct-literal expansion pushed this over the limit
    pub fn parse(text: &str) -> Result<Self, DbcError> {
        let dbc = Dbc::try_from(text).map_err(|e| DbcError::Parse(e.to_string()))?;

        // Long-name extension: the classic DBC format caps `BO_` / `SG_`
        // identifiers at 32 chars, so longer names appear truncated on
        // those lines plus a `BA_ "System{Message,Signal}LongSymbol" …`
        // attribute carrying the full one. Build the lookups up front so
        // the rest of the code (and our callers) see the real names.
        let long_message_names: HashMap<MessageId, String> = dbc
            .attribute_values_message
            .iter()
            .filter(|av| av.name == "SystemMessageLongSymbol")
            .filter_map(|av| string_value(&av.value).map(|s| (av.message_id, s)))
            .collect();
        let long_signal_names: HashMap<(MessageId, String), String> = dbc
            .attribute_values_signal
            .iter()
            .filter(|av| av.name == "SystemSignalLongSymbol")
            .filter_map(|av| {
                string_value(&av.value).map(|s| ((av.message_id, av.signal_name.clone()), s))
            })
            .collect();

        let (message_comments, signal_comments) = collect_comments(&dbc);
        let (mut message_attributes, mut signal_attributes) = collect_attributes(&dbc);

        let start_values = collect_start_values(&dbc);
        let send_type_labels = send_type_enum_labels(&dbc);

        let mut warnings = Vec::new();
        let mut messages = HashMap::with_capacity(dbc.messages.len());
        for msg in &dbc.messages {
            let expected_len = usize::try_from(msg.size).unwrap_or(usize::MAX);
            let mut signals: Vec<SignalEntry> = msg
                .signals
                .iter()
                .map(|s| {
                    // `SIG_VALTYPE_` references the signal by the name on
                    // its `SG_` line — the short one — so look it up
                    // before applying any long-symbol rename.
                    let extended_type = dbc
                        .extended_value_type_for_signal(msg.id, &s.name)
                        .copied()
                        .unwrap_or(SignalExtendedValueType::SignedOrUnsignedInteger);
                    let mut signal = s.clone();
                    if let Some(full) = long_signal_names.get(&(msg.id, s.name.clone())) {
                        signal.name.clone_from(full);
                    }
                    // `VAL_` lookups in `can-dbc` key on the original
                    // (short) signal name, the same as `SIG_VALTYPE_`.
                    let value_table = dbc
                        .value_descriptions_for_signal(msg.id, &s.name)
                        .map(|entries| {
                            let mut v: Vec<ValueTableEntry> = entries
                                .iter()
                                .map(|e| ValueTableEntry {
                                    raw: e.id,
                                    label: e.description.clone(),
                                })
                                .collect();
                            v.sort_by_key(|e| e.raw);
                            v
                        })
                        .unwrap_or_default();
                    let comment = signal_comments
                        .get(&(msg.id, s.name.clone()))
                        .cloned()
                        .unwrap_or_default();
                    let attributes = signal_attributes
                        .remove(&(msg.id, s.name.clone()))
                        .unwrap_or_default();
                    let start_value_raw = start_values.get(&(msg.id, s.name.clone())).copied();
                    SignalEntry {
                        signal,
                        extended_type,
                        value_table,
                        comment,
                        attributes,
                        start_value_raw,
                        // Needs the message name for its warnings, which
                        // long-symbol resolution hasn't produced yet.
                        display_hex: false,
                    }
                })
                .collect();
            let name = long_message_names
                .get(&msg.id)
                .cloned()
                .unwrap_or_else(|| msg.name.clone());
            let is_fd = message_is_fd(&dbc, msg.id, expected_len);
            let brs = is_fd && message_brs(&dbc, msg.id);
            let gen_msg_cycle_time_ms = message_cycle_time_ms(&dbc, msg.id);
            let gen_msg_send_type = message_send_type(&dbc, msg.id, send_type_labels);
            let transmitter = match &msg.transmitter {
                Transmitter::NodeName(name) => Some(name.clone()),
                Transmitter::VectorXXX => None,
            };
            let comment = message_comments.get(&msg.id).cloned().unwrap_or_default();
            let attributes = message_attributes.remove(&msg.id).unwrap_or_default();
            let calc_fields = collect_calc_fields(&name, &signals, &mut warnings);
            apply_display_attributes(&name, &mut signals, &mut warnings);
            messages.insert(
                msg.id,
                MessageEntry {
                    name,
                    expected_len,
                    is_fd,
                    brs,
                    gen_msg_cycle_time_ms,
                    comment,
                    gen_msg_send_type,
                    transmitter,
                    attributes,
                    calc_fields,
                    multiplexor: multiplexor_index(&signals),
                    signals,
                },
            );
        }
        Ok(Self { messages, warnings })
    }

    /// Non-fatal problems found while interpreting cannet attributes
    /// during [`Database::parse`] (malformed `CannetCounter` /
    /// `CannetCrc` values, duplicate designations). Empty when the
    /// file was clean. Callers surface these on their own log.
    #[must_use]
    pub fn parse_warnings(&self) -> &[String] {
        &self.warnings
    }
}

/// Whether the DBC marks this message as CAN-FD. Checks
/// `VFrameFormat` (14 = Standard CAN-FD, 15 = Extended CAN-FD) first,
/// then falls back to "size > 8" since classic CAN tops out at 8
/// payload bytes.
fn message_is_fd(dbc: &Dbc, msg_id: MessageId, expected_len: usize) -> bool {
    for av in &dbc.attribute_values_message {
        if av.message_id == msg_id && av.name == "VFrameFormat" {
            if let AttributeValue::Uint(n) = av.value {
                // VFrameFormat: 0 Standard CAN, 1 Extended CAN, 14
                // Standard CAN-FD, 15 Extended CAN-FD, 2 J1939PG, ...
                return n == 14 || n == 15;
            }
            if let AttributeValue::Int(n) = av.value {
                return n == 14 || n == 15;
            }
        }
    }
    expected_len > 8
}

/// Whether BRS (Bit Rate Switch) is on for this FD message, from
/// `GenMsgCANFDBRS` (1 = on, 0 = off). When the attribute is absent,
/// default to `true` — the typical real-world setting for FD frames.
fn message_brs(dbc: &Dbc, msg_id: MessageId) -> bool {
    for av in &dbc.attribute_values_message {
        if av.message_id == msg_id && av.name == "GenMsgCANFDBRS" {
            if let AttributeValue::Uint(n) = av.value {
                return n != 0;
            }
            if let AttributeValue::Int(n) = av.value {
                return n != 0;
            }
        }
    }
    true
}

/// The message's `GenMsgCycleTime` attribute in milliseconds, or
/// `None` when the attribute isn't set for this message. The value is
/// reported verbatim (including `0`, which DBCs use for "not cyclic");
/// callers decide whether a zero period is meaningful.
fn message_cycle_time_ms(dbc: &Dbc, msg_id: MessageId) -> Option<u32> {
    for av in &dbc.attribute_values_message {
        if av.message_id == msg_id && av.name == "GenMsgCycleTime" {
            if let AttributeValue::Uint(n) = av.value {
                return u32::try_from(n).ok();
            }
            if let AttributeValue::Int(n) = av.value {
                return u32::try_from(n).ok();
            }
        }
    }
    None
}

/// `GenSigStartValue` per signal (raw units, verbatim) — keyed on the
/// short signal name like every other per-signal lookup.
fn collect_start_values(dbc: &Dbc) -> HashMap<(MessageId, String), f64> {
    dbc.attribute_values_signal
        .iter()
        .filter(|av| av.name == "GenSigStartValue")
        .filter_map(|av| {
            attribute_value_to_f64(&av.value).map(|v| ((av.message_id, av.signal_name.clone()), v))
        })
        .collect()
}

/// `GenMsgSendType`'s `BA_DEF_` enum labels, if the DBC declares it
/// as an ENUM — integer values resolve through this list.
fn send_type_enum_labels(dbc: &Dbc) -> Option<&Vec<String>> {
    dbc.attribute_definitions.iter().find_map(|d| match d {
        AttributeDefinition::Message(name, AttributeValueType::Enum(labels))
            if name == "GenMsgSendType" =>
        {
            Some(labels)
        }
        _ => None,
    })
}

/// The message's `GenMsgSendType` attribute resolved to a label.
/// ENUM-typed definitions map the integer value through the
/// `BA_DEF_` label list; STRING values pass through verbatim; a
/// numeric value with no ENUM definition stringifies as-is.
fn message_send_type(dbc: &Dbc, msg_id: MessageId, labels: Option<&Vec<String>>) -> Option<String> {
    let av = dbc
        .attribute_values_message
        .iter()
        .find(|av| av.message_id == msg_id && av.name == "GenMsgSendType")?;
    let index = match &av.value {
        AttributeValue::String(s) => return Some(s.clone()),
        AttributeValue::Uint(n) => usize::try_from(*n).ok(),
        AttributeValue::Int(n) => usize::try_from(*n).ok(),
        AttributeValue::Double(_) => None,
    };
    match (index, labels) {
        (Some(i), Some(labels)) if i < labels.len() => Some(labels[i].clone()),
        _ => Some(attribute_value_to_string(&av.value)),
    }
}

/// Interpret the `CannetCounter` / `CannetCrc` attributes on a
/// message's signals (ADR 0027). At most one of each per message —
/// the first (in `SG_` declared order) wins and any further
/// designation is reported as a warning, as is a value that fails to
/// parse. Empty attribute values mean "unconfigured" and are skipped.
fn collect_calc_fields(
    message_name: &str,
    signals: &[SignalEntry],
    warnings: &mut Vec<String>,
) -> calc::CalculatedFieldsConfig {
    let mut config = calc::CalculatedFieldsConfig::default();
    for sig in signals {
        let signal_name = &sig.signal.name;
        for attr in &sig.attributes {
            let slot = match attr.name.as_str() {
                "CannetCounter" => true,
                "CannetCrc" => false,
                _ => continue,
            };
            if attr.value.is_empty() {
                continue;
            }
            if slot {
                match calc::parse_counter_attribute(signal_name, &attr.value) {
                    Ok(c) if config.counter.is_none() => config.counter = Some(c),
                    Ok(_) => warnings.push(format!(
                        "{message_name}.{signal_name}: second CannetCounter designation ignored"
                    )),
                    Err(e) => warnings.push(format!(
                        "{message_name}.{signal_name}: bad CannetCounter attribute: {e}"
                    )),
                }
            } else {
                match calc::parse_crc_attribute(signal_name, &attr.value) {
                    Ok(c) if config.crc.is_none() => config.crc = Some(c),
                    Ok(_) => warnings.push(format!(
                        "{message_name}.{signal_name}: second CannetCrc designation ignored"
                    )),
                    Err(e) => warnings.push(format!(
                        "{message_name}.{signal_name}: bad CannetCrc attribute: {e}"
                    )),
                }
            }
        }
    }
    config
}

/// Interpret the `CannetDisplay` attribute on a message's signals
/// (ADR 0043) and settle each signal's `display_hex`. Empty attribute
/// values mean "unconfigured" and are skipped; a value that fails to
/// parse is a warning and leaves the default rendering, as does
/// `radix=hex` on a signal that is not a raw field — a DBC author who
/// wrote it on a scaled, united or enum signal meant something by it,
/// and silently doing nothing hides the mistake.
fn apply_display_attributes(
    message_name: &str,
    signals: &mut [SignalEntry],
    warnings: &mut Vec<String>,
) {
    for sig in signals.iter_mut() {
        let Some(attr) = sig
            .attributes
            .iter()
            .find(|a| a.name == "CannetDisplay" && !a.value.is_empty())
        else {
            continue;
        };
        let config = match crate::display::parse_display_attribute(&attr.value) {
            Ok(config) => config,
            Err(e) => {
                warnings.push(format!(
                    "{message_name}.{}: bad CannetDisplay attribute: {e}",
                    sig.signal.name
                ));
                continue;
            }
        };
        if !config.hex {
            continue;
        }
        if is_raw_field(
            value_is_raw_integer(sig),
            &sig.signal.unit,
            is_enum(&sig.value_table),
        ) {
            sig.display_hex = true;
        } else {
            warnings.push(format!(
                "{message_name}.{}: CannetDisplay radix=hex ignored — not a raw integer field \
                 (it has a unit, a scale factor, or a VAL_ table)",
                sig.signal.name
            ));
        }
    }
}

/// A numeric DBC attribute value as `f64` (`GenSigStartValue` uses
/// this). String values that parse as numbers are accepted — some
/// tools quote numeric attribute values.
fn attribute_value_to_f64(value: &AttributeValue) -> Option<f64> {
    match value {
        #[allow(clippy::cast_precision_loss)]
        AttributeValue::Uint(u) => Some(*u as f64),
        #[allow(clippy::cast_precision_loss)]
        AttributeValue::Int(i) => Some(*i as f64),
        AttributeValue::Double(d) => Some(*d),
        AttributeValue::String(s) => s.trim().parse().ok(),
    }
}

/// The string payload of an attribute value, or `None` for the numeric
/// variants — the `System…LongSymbol` attributes are always strings.
fn string_value(value: &AttributeValue) -> Option<String> {
    match value {
        AttributeValue::String(s) => Some(s.clone()),
        AttributeValue::Uint(_) | AttributeValue::Int(_) | AttributeValue::Double(_) => None,
    }
}

/// Stringify an [`AttributeValue`] for the DBC discovery panel — both
/// for display and as a fuzzy-search target. The textual shape is the
/// natural one for each variant: integers as plain decimals, floats
/// via Rust's default `f64` formatter, strings verbatim (unquoted).
fn attribute_value_to_string(value: &AttributeValue) -> String {
    match value {
        AttributeValue::Uint(u) => u.to_string(),
        AttributeValue::Int(i) => i.to_string(),
        AttributeValue::Double(d) => d.to_string(),
        AttributeValue::String(s) => s.clone(),
    }
}

/// Per-message comment lookup keyed by `MessageId`.
type MessageCommentMap = HashMap<MessageId, String>;
/// Per-signal comment lookup keyed by `(MessageId, short_signal_name)`.
/// The short name matches `VAL_` / `SIG_VALTYPE_` conventions, before
/// any long-symbol rename is applied.
type SignalCommentMap = HashMap<(MessageId, String), String>;
/// Per-message attribute-value list keyed by `MessageId`; each list
/// is sorted by attribute name.
type MessageAttributeMap = HashMap<MessageId, Vec<DbcAttribute>>;
/// Per-signal attribute-value list keyed by
/// `(MessageId, short_signal_name)`.
type SignalAttributeMap = HashMap<(MessageId, String), Vec<DbcAttribute>>;

/// Bucket the parsed comments by their target. Node, env-var, and
/// plain comments are dropped.
fn collect_comments(dbc: &Dbc) -> (MessageCommentMap, SignalCommentMap) {
    let mut message_comments: MessageCommentMap = HashMap::new();
    let mut signal_comments: SignalCommentMap = HashMap::new();
    for c in &dbc.comments {
        match c {
            Comment::Message { id, comment } => {
                message_comments.insert(*id, comment.clone());
            }
            Comment::Signal {
                message_id,
                name,
                comment,
            } => {
                signal_comments.insert((*message_id, name.clone()), comment.clone());
            }
            Comment::Node { .. } | Comment::EnvVar { .. } | Comment::Plain { .. } => {}
        }
    }
    (message_comments, signal_comments)
}

/// Bucket per-message and per-signal `BA_` attribute values by target,
/// stringifying each value up front. Suppresses the long-symbol
/// extension attributes — they're not user-authored metadata. Each
/// bucket's `Vec<DbcAttribute>` is sorted by attribute name so the
/// downstream tree node lists are stable across runs.
fn collect_attributes(dbc: &Dbc) -> (MessageAttributeMap, SignalAttributeMap) {
    let mut message_attributes: MessageAttributeMap = HashMap::new();
    for av in &dbc.attribute_values_message {
        if av.name == "SystemMessageLongSymbol" {
            continue;
        }
        message_attributes
            .entry(av.message_id)
            .or_default()
            .push(DbcAttribute {
                name: av.name.clone(),
                value: attribute_value_to_string(&av.value),
            });
    }
    let mut signal_attributes: SignalAttributeMap = HashMap::new();
    for av in &dbc.attribute_values_signal {
        if av.name == "SystemSignalLongSymbol" {
            continue;
        }
        signal_attributes
            .entry((av.message_id, av.signal_name.clone()))
            .or_default()
            .push(DbcAttribute {
                name: av.name.clone(),
                value: attribute_value_to_string(&av.value),
            });
    }
    for attrs in message_attributes.values_mut() {
        attrs.sort_by(|a, b| a.name.cmp(&b.name));
    }
    for attrs in signal_attributes.values_mut() {
        attrs.sort_by(|a, b| a.name.cmp(&b.name));
    }
    (message_attributes, signal_attributes)
}

/// Index of the `Multiplexor` signal within a message's signal list,
/// precomputed at parse for [`MessageEntry::multiplexor`].
fn multiplexor_index(signals: &[SignalEntry]) -> Option<usize> {
    signals
        .iter()
        .position(|s| s.signal.multiplexer_indicator == MultiplexIndicator::Multiplexor)
}

#[derive(Debug)]
pub enum DbcError {
    Parse(String),
}

impl std::fmt::Display for DbcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(msg) => write!(f, "failed to parse DBC: {msg}"),
        }
    }
}

impl std::error::Error for DbcError {}
