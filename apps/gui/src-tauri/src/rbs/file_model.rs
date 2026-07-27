//! The `.cannet_rbs` file model: the sparse-override document the user
//! owns and edits (ADR 0028).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::ipc::{CounterSpec, CrcSpec};

/// Current `.cannet_rbs` schema version — current-only, no migrators
/// (ADR 0011 semantics).
pub const RBS_SCHEMA_VERSION: u32 = 1;

/// The `.cannet_rbs` document. `BTreeMap`s keep the serialized key
/// order stable so saves diff cleanly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RbsFile {
    pub schema_version: u32,
    /// The bit value payload bytes start from where the DBC specifies
    /// no default: `0` or `1` (whole-byte fill `0x00` / `0xFF`).
    #[serde(default)]
    pub fill_bit: u8,
    /// Muted messages, flat `"<bus key>/<message key>"` entries.
    /// Everything not listed is enabled — rest-of-bus: every message
    /// plays unless muted. Combined (AND) with the bus / ECU enables.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub disabled_messages: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub buses: BTreeMap<String, RbsBus>,
}

/// The `disabled_messages` key for one message.
pub(super) fn disabled_key(bus: &str, message: &str) -> String {
    format!("{bus}/{message}")
}

impl RbsFile {
    /// A fresh, empty config.
    #[must_use]
    pub fn new() -> Self {
        Self {
            schema_version: RBS_SCHEMA_VERSION,
            fill_bit: 0,
            disabled_messages: BTreeSet::new(),
            buses: BTreeMap::new(),
        }
    }

    /// Whether a message is enabled (not muted). Default true — a
    /// message needs no file presence to play.
    #[must_use]
    pub fn is_message_enabled(&self, bus: &str, message: &str) -> bool {
        !self.disabled_messages.contains(&disabled_key(bus, message))
    }

    /// The file entry carrying a message's overrides, wherever the
    /// author placed it (the DBC's transmitter grouping wins for
    /// display; a mismatched placement warns).
    pub(super) fn entry_for(&self, bus: &str, message: &str) -> Option<(&str, &RbsMessage)> {
        self.buses.get(bus).and_then(|b| {
            b.ecus
                .iter()
                .find_map(|(ek, e)| e.messages.get(message).map(|m| (ek.as_str(), m)))
        })
    }

    /// Parse a `.cannet_rbs` document. Only the current
    /// `schema_version` is accepted (ADR 0011).
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut file: Self =
            crate::persisted_json::parse_versioned(text, "RBS", RBS_SCHEMA_VERSION)?;
        if file.fill_bit > 1 {
            return Err(format!("fill_bit must be 0 or 1, got {}", file.fill_bit));
        }
        // The format's first revision carried a per-entry `enabled`
        // flag; fold any `false` into the flat mute list (the field
        // is read but never written now).
        let mut legacy: Vec<String> = Vec::new();
        for (bus_key, bus) in &mut file.buses {
            for ecu in bus.ecus.values_mut() {
                for (msg_key, msg) in &mut ecu.messages {
                    if !msg.enabled {
                        legacy.push(disabled_key(bus_key, msg_key));
                        msg.enabled = true;
                    }
                }
            }
        }
        file.disabled_messages.extend(legacy);
        Ok(file)
    }
}

impl Default for RbsFile {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RbsBus {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub ecus: BTreeMap<String, RbsEcu>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RbsEcu {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub messages: BTreeMap<String, RbsMessage>,
}

/// One message entry — it exists to carry *overrides* (period,
/// signal values, counter / CRC designations). Enabled-ness lives in
/// the file's flat `disabled_messages` list, not here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RbsMessage {
    /// Legacy per-entry mute from the format's first revision: read
    /// and folded into `disabled_messages` on parse, never written.
    #[serde(default = "default_true", skip_serializing)]
    pub enabled: bool,
    /// Send period override; absent → the DBC's `GenMsgCycleTime`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_ms: Option<u32>,
    /// Sparse signal-value overrides: physical numbers, enum labels
    /// as strings, or `0x…` hex (raw) strings.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub signals: BTreeMap<String, RbsValue>,
    /// Counter designation override — replaces the DBC's
    /// `CannetCounter` default wholesale when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counter: Option<CounterSpec>,
    /// CRC designation override — replaces the DBC's `CannetCrc`
    /// default wholesale when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crc: Option<CrcSpec>,
}

impl RbsEcu {
    pub(super) fn new() -> Self {
        Self {
            enabled: true,
            messages: BTreeMap::new(),
        }
    }
}

impl RbsBus {
    pub(super) fn new() -> Self {
        Self {
            enabled: true,
            ecus: BTreeMap::new(),
        }
    }
}

impl RbsMessage {
    pub(super) fn new() -> Self {
        Self {
            enabled: true,
            period_ms: None,
            signals: BTreeMap::new(),
            counter: None,
            crc: None,
        }
    }
}

fn default_true() -> bool {
    true
}

/// A signal override value as written in the file: a physical number,
/// or a string carrying an enum label / `0x…` raw hex.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RbsValue {
    Number(f64),
    Text(String),
}

/// Parse a message key: hex CAN id, trailing `x` = extended
/// (`"0x123"`, `"0x18FF40E5x"`). A bare hex string without the `0x`
/// prefix is accepted too.
pub fn parse_message_key(key: &str) -> Result<(u32, bool), String> {
    // A trailing x marks an extended id — except when it's the x of a
    // bare "0x" prefix (rest == "0"), which is just a malformed key.
    let (body, extended) = match key.strip_suffix(['x', 'X']) {
        Some(rest) if !rest.is_empty() && rest != "0" => (rest, true),
        _ => (key, false),
    };
    let digits = body
        .strip_prefix("0x")
        .or_else(|| body.strip_prefix("0X"))
        .unwrap_or(body);
    let id = u32::from_str_radix(digits, 16).map_err(|_| format!("invalid message key {key}"))?;
    Ok((id, extended))
}

/// Format a message key — the inverse of [`parse_message_key`].
#[must_use]
pub fn format_message_key(id: u32, extended: bool) -> String {
    if extended {
        format!("0x{id:X}x")
    } else {
        format!("0x{id:X}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_keys_round_trip_and_reject_garbage() {
        assert_eq!(parse_message_key("0x123"), Ok((0x123, false)));
        assert_eq!(parse_message_key("0x18FF40E5x"), Ok((0x18FF_40E5, true)));
        assert_eq!(parse_message_key("123"), Ok((0x123, false)));
        assert_eq!(parse_message_key("10x"), Ok((0x10, true)));
        assert_eq!(parse_message_key("0x10"), Ok((0x10, false)));
        assert_eq!(parse_message_key("0X1AX"), Ok((0x1A, true)));
        for (id, ext) in [
            (0u32, false),
            (0, true),
            (0x7FF, false),
            (0x1FFF_FFFF, true),
        ] {
            assert_eq!(
                parse_message_key(&format_message_key(id, ext)),
                Ok((id, ext)),
                "round trip {id:#x} ext={ext}"
            );
        }
        assert!(parse_message_key("").is_err());
        assert!(parse_message_key("0x").is_err());
        assert!(parse_message_key("zz").is_err());
        assert!(parse_message_key("x").is_err());
    }

    /// The ADR 0028 example document (comments stripped) parses, and
    /// the sparse semantics round-trip: serialize → parse → equal,
    /// nothing absent materialises.
    #[test]
    fn adr_example_parses_and_round_trips_sparsely() {
        let text = r#"{
          "schema_version": 1,
          "fill_bit": 0,
          "buses": {
            "Powertrain": {
              "enabled": true,
              "ecus": {
                "BMS": {
                  "enabled": true,
                  "messages": {
                    "0x123": {
                      "enabled": false,
                      "period_ms": 10,
                      "signals": {
                        "TargetMode": "Standby",
                        "CmdWord": "0x1A2B",
                        "PackVoltage": 403.2
                      },
                      "counter": { "signal": "AliveCtr", "increment": 1, "rollover": 15 },
                      "crc": { "signal": "Crc8", "algorithm": "CRC-8/SAE-J1850",
                               "range_bits": [0, 56], "prefix": "A3" }
                    }
                  }
                }
              }
            }
          }
        }"#;
        let file = RbsFile::parse(text).unwrap();
        let msg = &file.buses["Powertrain"].ecus["BMS"].messages["0x123"];
        // The first revision's per-entry `enabled: false` folds into
        // the flat mute list on parse (and the field normalises true).
        assert!(msg.enabled);
        assert!(!file.is_message_enabled("Powertrain", "0x123"));
        assert!(file.disabled_messages.contains("Powertrain/0x123"));
        assert_eq!(msg.period_ms, Some(10));
        assert_eq!(msg.signals["PackVoltage"], RbsValue::Number(403.2));
        assert_eq!(msg.signals["TargetMode"], RbsValue::Text("Standby".into()));
        assert_eq!(msg.counter.as_ref().unwrap().rollover, Some(15));
        assert_eq!(msg.crc.as_ref().unwrap().prefix, "A3");

        let round = RbsFile::parse(&serde_json::to_string_pretty(&file).unwrap()).unwrap();
        assert_eq!(round, file);

        // Sparse: a minimal message entry defaults to enabled, no
        // overrides — and serializes back without materialising keys.
        let minimal: RbsFile = RbsFile::parse(
            r#"{ "schema_version": 1,
                 "buses": { "B": { "ecus": { "E": { "messages": { "0x1": {} } } } } } }"#,
        )
        .unwrap();
        let msg = &minimal.buses["B"].ecus["E"].messages["0x1"];
        assert!(msg.enabled && msg.period_ms.is_none() && msg.signals.is_empty());
        let text = serde_json::to_string(&minimal).unwrap();
        assert!(!text.contains("period_ms"), "{text}");
        assert!(!text.contains("signals"), "{text}");
        // The legacy per-entry flag is read-only: never written back.
        let msg_json = serde_json::to_string(&RbsMessage::new()).unwrap();
        assert!(!msg_json.contains("enabled"), "{msg_json}");
    }

    #[test]
    fn parse_gates_on_schema_version_and_fill_bit() {
        assert!(RbsFile::parse(r#"{ "schema_version": 2 }"#).is_err());
        assert!(RbsFile::parse(r#"{ "fill_bit": 0 }"#).is_err());
        assert!(RbsFile::parse(r#"{ "schema_version": 1, "fill_bit": 7 }"#).is_err());
        assert!(RbsFile::parse("not json").is_err());
        assert!(RbsFile::parse(r#"{ "schema_version": 1 }"#).is_ok());
    }
}
