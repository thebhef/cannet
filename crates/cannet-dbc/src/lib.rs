//! DBC database loading and runtime signal decoding.
//!
//! Parsing is delegated to the `can-dbc` crate, which produces an AST.
//! This crate builds an indexed, decode-friendly view on top of that AST
//! and runs the bit-extraction maths against `cannet_core::CanFrame` payloads.

mod decode;
mod encode;

pub use decode::{decode_signal_bits, sign_extend};
pub use encode::encode_signal_bits;

use std::collections::HashMap;

use cannet_core::CanFrame;
use can_dbc::{
    AttributeValue, Comment, Dbc, MessageId, MultiplexIndicator, NumericValue, Signal,
    SignalExtendedValueType, ValueType,
};

/// A parsed DBC database, indexed for fast frame lookup.
pub struct Database {
    messages: HashMap<MessageKey, MessageEntry>,
}

/// Lookup key matching a frame to a DBC message: raw id + addressing mode.
/// `can-dbc`'s `MessageId` already encodes both, so we reuse it directly.
type MessageKey = MessageId;

struct MessageEntry {
    name: String,
    /// Expected payload length in bytes from the DBC `BO_` declaration.
    expected_len: usize,
    /// True if the DBC marks this message as CAN-FD — either via the
    /// `VFrameFormat` attribute being one of the FD codes
    /// (14 = Standard CAN-FD, 15 = Extended CAN-FD), or as a fallback
    /// when `expected_len` exceeds the classic max of 8 bytes.
    is_fd: bool,
    /// CAN-FD BRS (Bit Rate Switch) setting from the DBC's
    /// `GenMsgCANFDBRS` per-message attribute. `1` = on, `0` = off;
    /// when the attribute is absent on an FD message, default to
    /// `true` (the typical real-world setting). Always `false` for
    /// classic messages.
    brs: bool,
    /// `CM_ BO_ <id> "..."` free-text comment. Empty when absent.
    /// Captured during parse so the DBC panel's fuzzy search can
    /// match it without re-walking the AST.
    comment: String,
    /// `BA_ "<name>" BO_ <id> <value>` attribute values targeted at
    /// this message, sorted by attribute name. Values are stringified
    /// up front because the panel both displays them and searches
    /// them; sorting up front keeps the tree's per-node attribute
    /// list stable across runs.
    attributes: Vec<DbcAttribute>,
    signals: Vec<SignalEntry>,
}

struct SignalEntry {
    signal: Signal,
    /// Mirrors `SIG_VALTYPE_`. Defaults to integer when no entry is
    /// declared; `IEEEfloat32Bit` / `IEEEdouble64bit` switch the bit
    /// pattern from "scaled integer" to a real IEEE float.
    extended_type: SignalExtendedValueType,
    /// `VAL_` table for this signal: pairs of `(raw_value, label)`,
    /// sorted by raw value. Empty if the DBC defines no value table.
    /// Looked up by [`decode_signal`] to populate
    /// [`DecodedSignal::label`].
    value_table: Vec<ValueTableEntry>,
    /// `CM_ SG_ <id> <name> "..."` comment. Empty when absent.
    comment: String,
    /// `BA_ "<name>" SG_ <id> <name> <value>` attribute values
    /// targeted at this signal, sorted by attribute name.
    attributes: Vec<DbcAttribute>,
}

/// One row of a signal's `VAL_` value table: a raw value and its
/// symbolic label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValueTableEntry {
    /// Raw value (the same domain as
    /// [`DecodedSignal::raw_unsigned`] / [`DecodedSignal::raw_signed`]).
    /// Stored as `i64` to match `can-dbc`'s API; signed signals use
    /// negative entries, unsigned signals re-cast at the call site.
    pub raw: i64,
    /// Symbolic name for `raw`. Quoted in the DBC; stripped on parse.
    pub label: String,
}

impl Database {
    /// Parse a DBC file from text.
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

        let mut messages = HashMap::with_capacity(dbc.messages.len());
        for msg in &dbc.messages {
            let expected_len = usize::try_from(msg.size).unwrap_or(usize::MAX);
            let signals = msg
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
                    SignalEntry {
                        signal,
                        extended_type,
                        value_table,
                        comment,
                        attributes,
                    }
                })
                .collect();
            let name = long_message_names
                .get(&msg.id)
                .cloned()
                .unwrap_or_else(|| msg.name.clone());
            let is_fd = message_is_fd(&dbc, msg.id, expected_len);
            let brs = is_fd && message_brs(&dbc, msg.id);
            let comment = message_comments.get(&msg.id).cloned().unwrap_or_default();
            let attributes = message_attributes.remove(&msg.id).unwrap_or_default();
            messages.insert(msg.id, MessageEntry {
                name,
                expected_len,
                is_fd,
                brs,
                comment,
                attributes,
                signals,
            });
        }
        Ok(Self { messages })
    }

    /// Number of messages defined in this database.
    pub fn message_count(&self) -> usize {
        self.messages.len()
    }

    /// Every signal defined in the database, as `(message, signal)`
    /// descriptors suitable for a "pick a signal to plot" UI.
    ///
    /// The result is sorted by message name, then signal name, so the
    /// list is stable across calls regardless of `HashMap` iteration
    /// order. Multiplexed signals are listed unconditionally — whether a
    /// given frame actually carries one depends on its multiplexor value,
    /// which the sampler resolves per frame.
    #[must_use]
    pub fn signals(&self) -> Vec<SignalDescriptor> {
        let mut out: Vec<SignalDescriptor> = self
            .messages
            .iter()
            .flat_map(|(id, entry)| {
                let (message_id, extended) = message_id_parts(*id);
                entry.signals.iter().map(move |sig| SignalDescriptor {
                    message_id,
                    extended,
                    message_name: entry.name.clone(),
                    signal_name: sig.signal.name.clone(),
                    unit: sig.signal.unit.clone(),
                    has_value_table: !sig.value_table.is_empty(),
                })
            })
            .collect();
        out.sort_by(|a, b| {
            a.message_name
                .cmp(&b.message_name)
                .then_with(|| a.signal_name.cmp(&b.signal_name))
        });
        out
    }

    /// Look up the `VAL_` table for one `(message_id, extended,
    /// signal_name)`. Returns `None` if no such signal exists or it has
    /// no value table. Rows are sorted by raw value.
    ///
    /// Used by the plot panel's axis-tick rendering and the transmit
    /// panel's enum-signal dropdown — a separate call once per signal,
    /// because the same table doesn't have to ride along on every
    /// decoded frame.
    #[must_use]
    pub fn value_table_for_signal(
        &self,
        message_id: u32,
        extended: bool,
        signal_name: &str,
    ) -> Option<&[ValueTableEntry]> {
        let key = canid_to_message_id(if extended {
            cannet_core::CanId::extended(message_id).ok()?
        } else {
            cannet_core::CanId::standard(message_id).ok()?
        })?;
        let entry = self.messages.get(&key)?;
        let sig = entry.signals.iter().find(|s| s.signal.name == signal_name)?;
        if sig.value_table.is_empty() {
            None
        } else {
            Some(&sig.value_table)
        }
    }

    /// Decode `frame` against this database. Returns `None` if no message
    /// in the database matches the frame's id (and addressing mode).
    pub fn decode<'a>(&'a self, frame: &CanFrame) -> Option<DecodedMessage<'a>> {
        self.decode_raw(frame.id, frame.payload.data())
    }

    /// Decode by raw `(id, data)` without needing a `CanFrame`. The trace
    /// view uses this to retro-decode already-displayed frames when the
    /// user attaches a DBC after the fact.
    pub fn decode_raw<'a>(
        &'a self,
        id: cannet_core::CanId,
        data: &[u8],
    ) -> Option<DecodedMessage<'a>> {
        let key = canid_to_message_id(id)?;
        let entry = self.messages.get(&key)?;
        Some(decode_message(entry, data))
    }

    /// Rich descriptor for one message — everything the transmit
    /// panel's signal table needs to render rows (factor / offset /
    /// size / range / mux indicator / float kind) without
    /// reimplementing DBC-walking logic on the frontend. Returns
    /// `None` if no message matches `id`.
    ///
    /// The trace view's per-frame decode path is unchanged; this is a
    /// separate metadata view that pairs with [`Database::encode_frame`]
    /// and [`Database::decode_raw`].
    #[must_use]
    pub fn describe_message(&self, id: cannet_core::CanId) -> Option<MessageDescriptor> {
        let key = canid_to_message_id(id)?;
        let entry = self.messages.get(&key)?;
        let mut uses_extended_mux = false;
        let signals = entry
            .signals
            .iter()
            .map(|s| {
                let mux = match s.signal.multiplexer_indicator {
                    MultiplexIndicator::Plain => SignalMux::Plain,
                    MultiplexIndicator::Multiplexor => SignalMux::Multiplexor,
                    MultiplexIndicator::MultiplexedSignal(sel) => SignalMux::Multiplexed {
                        selector: sel,
                    },
                    MultiplexIndicator::MultiplexorAndMultiplexedSignal(sel) => {
                        uses_extended_mux = true;
                        SignalMux::MultiplexorAndMultiplexed { selector: sel }
                    }
                };
                let float_kind = match s.extended_type {
                    SignalExtendedValueType::IEEEfloat32Bit => FloatKind::Float32,
                    SignalExtendedValueType::IEEEdouble64bit => FloatKind::Float64,
                    SignalExtendedValueType::SignedOrUnsignedInteger => FloatKind::Integer,
                };
                SignalDescriptorRich {
                    name: s.signal.name.clone(),
                    unit: s.signal.unit.clone(),
                    factor: s.signal.factor,
                    offset: s.signal.offset,
                    min: numeric_to_f64(s.signal.min),
                    max: numeric_to_f64(s.signal.max),
                    size: u32::try_from(s.signal.size).unwrap_or(0),
                    signed: s.signal.value_type == ValueType::Signed,
                    mux,
                    float_kind,
                    has_value_table: !s.value_table.is_empty(),
                }
            })
            .collect();
        Some(MessageDescriptor {
            name: entry.name.clone(),
            expected_len: entry.expected_len,
            is_fd: entry.is_fd,
            brs: entry.brs,
            uses_extended_mux,
            signals,
        })
    }

    /// Tree-shaped snapshot of this database for the GUI's DBC panel
    /// (Phase 12 discovery surface). One entry per message, each
    /// carrying the text the panel's fuzzy search has to match:
    /// per-message comment + attributes, per-signal comment +
    /// attributes + unit + value-table labels.
    ///
    /// Distinct in shape from [`Database::signals`] (a flat
    /// per-signal list for the plot picker) and
    /// [`Database::describe_message`] (rich numeric metadata for the
    /// transmit encoder): `dbc_content` is the *tree* the discovery
    /// panel walks. Messages are sorted by
    /// `(extended, message_id)` for a stable display order; signals
    /// within a message are kept in `SG_` declared order so the tree
    /// reads the way the DBC author wrote it.
    ///
    /// `SystemMessageLongSymbol` / `SystemSignalLongSymbol`
    /// attributes are suppressed — they're an implementation detail
    /// of the long-name extension, not user-authored metadata. The
    /// resolved long name lands on `name`.
    #[must_use]
    pub fn dbc_content(&self) -> Vec<DbcMessageContent> {
        let mut out: Vec<DbcMessageContent> = self
            .messages
            .iter()
            .map(|(id, entry)| {
                let (message_id, extended) = message_id_parts(*id);
                DbcMessageContent {
                    message_id,
                    extended,
                    name: entry.name.clone(),
                    comment: entry.comment.clone(),
                    attributes: entry.attributes.clone(),
                    signals: entry
                        .signals
                        .iter()
                        .map(|s| DbcSignalContent {
                            name: s.signal.name.clone(),
                            unit: s.signal.unit.clone(),
                            comment: s.comment.clone(),
                            attributes: s.attributes.clone(),
                            value_table: s.value_table.clone(),
                        })
                        .collect(),
                }
            })
            .collect();
        out.sort_by(|a, b| {
            a.extended
                .cmp(&b.extended)
                .then_with(|| a.message_id.cmp(&b.message_id))
        });
        out
    }

    /// Partial-encode `signals` into `base`. For each `(name, physical)`
    /// pair, looks up the signal by name on the message addressed by
    /// `id`, converts the physical value back to its raw bit pattern
    /// (`(physical - offset) / factor`, rounded; IEEE float signals
    /// take the f32 / f64 bit pattern directly), and writes those bits
    /// into `base` at the signal's `start_bit / size / byte_order`. All
    /// other bits in `base` are preserved.
    ///
    /// The encoder is the inverse of [`Database::decode`] in the
    /// strong sense: for every signal in the database, encoding a
    /// decoded `physical` value back into a zeroed buffer (then
    /// decoding) round-trips to the same physical (modulo rounding and
    /// f32 precision for `SIG_VALTYPE_ 1` signals).
    ///
    /// Returns `None` if no message matches `id`. Otherwise returns an
    /// [`EncodeReport`] with one entry per signal — `written` for the
    /// successful encodes, `skipped` for the ones that couldn't fit
    /// the payload or whose name didn't resolve. Skipped signals leave
    /// `base` untouched.
    ///
    /// **Multiplexing.** The encoder is mux-agnostic: it writes the
    /// bits the caller names. If the caller wants the inactive arm's
    /// bits zeroed on a switch change, it passes the new switch value
    /// *and* each new-arm sub-signal set to `0.0` in the same call;
    /// the encoder writes them in order.
    ///
    /// Out-of-range physical values are saturated to the signal's
    /// representable range (`[0, 2^size - 1]` unsigned;
    /// `[-2^(size-1), 2^(size-1) - 1]` signed) before encoding, and
    /// the [`EncodedSignal::saturated`] flag is set.
    pub fn encode_frame(
        &self,
        id: cannet_core::CanId,
        signals: &[(&str, f64)],
        base: &mut [u8],
    ) -> Option<EncodeReport> {
        let key = canid_to_message_id(id)?;
        let entry = self.messages.get(&key)?;

        let mut report = EncodeReport::default();
        for &(name, physical) in signals {
            match encode_one_signal(entry, name, physical, base) {
                Ok(written) => report.written.push(written),
                Err(skipped) => report.skipped.push(skipped),
            }
        }
        Some(report)
    }
}

/// Encode one named signal's bits into `data`, leaving all other bits
/// untouched. Returns `Err(SkippedSignal)` and does not mutate `data`
/// if the signal is unknown or its bits don't fit `data`.
fn encode_one_signal(
    entry: &MessageEntry,
    name: &str,
    physical: f64,
    data: &mut [u8],
) -> Result<EncodedSignal, SkippedSignal> {
    let Some(sig_entry) = entry.signals.iter().find(|s| s.signal.name == name) else {
        return Err(SkippedSignal {
            name: name.to_string(),
            reason: SkipReason::SignalNotFound,
        });
    };
    let sig = &sig_entry.signal;
    let Ok(start_bit) = usize::try_from(sig.start_bit) else {
        return Err(SkippedSignal {
            name: name.to_string(),
            reason: SkipReason::SizeOutOfRange,
        });
    };
    let size_usize = match usize::try_from(sig.size) {
        Ok(s) if (1..=64).contains(&s) => s,
        _ => {
            return Err(SkippedSignal {
                name: name.to_string(),
                reason: SkipReason::SizeOutOfRange,
            });
        }
    };
    // Safe — checked above.
    #[allow(clippy::cast_possible_truncation)]
    let size_u32 = size_usize as u32;

    let (raw_unsigned, saturated) =
        physical_to_raw(physical, sig, size_u32, sig_entry.extended_type);

    if encode::encode_signal_bits(data, start_bit, size_usize, raw_unsigned, sig.byte_order)
        .is_none()
    {
        return Err(SkippedSignal {
            name: name.to_string(),
            reason: SkipReason::BaseTooShort,
        });
    }

    Ok(EncodedSignal {
        name: name.to_string(),
        raw_unsigned,
        saturated,
    })
}

/// Convert a physical value back to a raw bit pattern according to the
/// signal's type. For integer signals this is `round((physical - offset)
/// / factor)`, then saturated to the signal's signed / unsigned range.
/// For IEEE-typed signals (`SIG_VALTYPE_ … 1` / `2`) the result is the
/// `f32` / `f64` bit pattern of the same expression — matching the
/// shape `decode_signal` parses on the way back.
fn physical_to_raw(
    physical: f64,
    sig: &Signal,
    size_bits: u32,
    extended_type: SignalExtendedValueType,
) -> (u64, bool) {
    // Float branches first — they ignore the signed flag and don't
    // saturate via integer bounds; an out-of-range physical clamps at
    // f32 ±inf, which is still a representable f32 bit pattern.
    match extended_type {
        SignalExtendedValueType::IEEEfloat32Bit if size_bits == 32 => {
            let scaled = (physical - sig.offset) / sig.factor;
            // `as f32` saturates infinities to +/- inf and clamps
            // overflows toward the same — both are still well-defined
            // bit patterns, so we don't flag them as "saturated" here.
            #[allow(clippy::cast_possible_truncation)]
            let f32_val = scaled as f32;
            return (u64::from(f32_val.to_bits()), false);
        }
        SignalExtendedValueType::IEEEdouble64bit if size_bits == 64 => {
            let scaled = (physical - sig.offset) / sig.factor;
            return (scaled.to_bits(), false);
        }
        _ => {}
    }

    let raw_f = (physical - sig.offset) / sig.factor;
    let raw_rounded = raw_f.round();

    if sig.value_type == ValueType::Signed {
        // Signed: range [-2^(size-1), 2^(size-1) - 1]. At size==64 use
        // i64's bounds directly; otherwise compute them from `size`.
        let (min_i, max_i) = if size_bits == 64 {
            (i64::MIN, i64::MAX)
        } else {
            let high = 1_i64 << (size_bits - 1);
            (-high, high - 1)
        };
        // Cast to f64 for the comparison — for sizes <= 53 bits this is
        // exact; for larger signed sizes (rare) f64 mantissa loss can
        // push the boundary by 1 ulp, which we accept.
        #[allow(clippy::cast_precision_loss)]
        let (min_f, max_f) = (min_i as f64, max_i as f64);
        let (raw_i, saturated) = if !raw_rounded.is_finite() || raw_rounded > max_f {
            (max_i, true)
        } else if raw_rounded < min_f {
            (min_i, true)
        } else {
            // In-range cast: f64 → i64 is well-defined here.
            #[allow(clippy::cast_possible_truncation)]
            let v = raw_rounded as i64;
            (v, false)
        };
        let raw_u = if size_bits == 64 {
            raw_i.cast_unsigned()
        } else {
            (raw_i.cast_unsigned()) & ((1u64 << size_bits) - 1)
        };
        (raw_u, saturated)
    } else {
        let max_u = if size_bits == 64 {
            u64::MAX
        } else {
            (1u64 << size_bits) - 1
        };
        #[allow(clippy::cast_precision_loss)]
        let max_f = max_u as f64;
        let (raw_u, saturated) = if !raw_rounded.is_finite() || raw_rounded > max_f {
            (max_u, true)
        } else if raw_rounded < 0.0 {
            (0u64, true)
        } else {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let v = raw_rounded as u64;
            (v, false)
        };
        (raw_u, saturated)
    }
}

/// Result of a [`Database::encode_frame`] call: one entry per input
/// signal, partitioned into the ones whose bits were written and the
/// ones that couldn't be (unknown name, doesn't fit `base`, …).
#[derive(Debug, Default, Clone)]
pub struct EncodeReport {
    /// Successful per-signal writes, in input order.
    pub written: Vec<EncodedSignal>,
    /// Per-signal skips, in input order. Skipped signals do not mutate
    /// `base`.
    pub skipped: Vec<SkippedSignal>,
}

/// A signal whose bits were written into the payload.
#[derive(Debug, Clone, PartialEq)]
pub struct EncodedSignal {
    pub name: String,
    /// Raw bit pattern actually placed in the payload (post-saturation,
    /// post-rounding). Width matches the signal's declared `size`.
    pub raw_unsigned: u64,
    /// True if the requested physical value lay outside the signal's
    /// representable range and was clamped before encoding.
    pub saturated: bool,
}

/// A signal that couldn't be encoded.
#[derive(Debug, Clone, PartialEq)]
pub struct SkippedSignal {
    pub name: String,
    pub reason: SkipReason,
}

/// Why a signal was skipped by [`Database::encode_frame`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// No signal with this name on the resolved message.
    SignalNotFound,
    /// The signal's bits would have run past the end of `base`.
    BaseTooShort,
    /// The signal's `start_bit` / `size` are outside the encoder's
    /// supported range (`size` ∈ `1..=64`, `start_bit` fits `usize`).
    SizeOutOfRange,
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

/// Widen a DBC numeric value to `f64`. The `SG_` min / max fields use
/// this — even an integer DBC bound is most useful as f64 at the
/// transmit-panel layer where physical values are already f64.
fn numeric_to_f64(value: NumericValue) -> f64 {
    match value {
        #[allow(clippy::cast_precision_loss)]
        NumericValue::Uint(u) => u as f64,
        #[allow(clippy::cast_precision_loss)]
        NumericValue::Int(i) => i as f64,
        NumericValue::Double(d) => d,
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

/// Split a `can-dbc` [`MessageId`] back into the `(raw id, extended?)`
/// pair the rest of the codebase uses. The extended variant carries the
/// 31-bit-flagged form on the wire in some DBCs; mask it to the 29-bit
/// id so it round-trips with [`cannet_core::CanId::extended`].
fn message_id_parts(id: MessageId) -> (u32, bool) {
    match id {
        MessageId::Standard(s) => (u32::from(s), false),
        MessageId::Extended(e) => (e & 0x1FFF_FFFF, true),
    }
}

fn canid_to_message_id(id: cannet_core::CanId) -> Option<MessageId> {
    let raw = id.raw();
    if id.is_extended() {
        Some(MessageId::Extended(raw))
    } else {
        Some(MessageId::Standard(u16::try_from(raw).ok()?))
    }
}

fn decode_message<'a>(entry: &'a MessageEntry, data: &[u8]) -> DecodedMessage<'a> {
    // First pass: find the multiplexor signal value, if any, so we can
    // filter multiplexed signals to the matching selector.
    let multiplexor_value = entry
        .signals
        .iter()
        .find(|s| matches!(s.signal.multiplexer_indicator, MultiplexIndicator::Multiplexor))
        .and_then(|s| decode_signal(s, data).map(|d| d.raw_unsigned));

    let mut signals = Vec::with_capacity(entry.signals.len());
    for sig in &entry.signals {
        let include = match sig.signal.multiplexer_indicator {
            MultiplexIndicator::Plain | MultiplexIndicator::Multiplexor => true,
            MultiplexIndicator::MultiplexedSignal(selector)
            | MultiplexIndicator::MultiplexorAndMultiplexedSignal(selector) => {
                multiplexor_value == Some(selector)
            }
        };
        if !include {
            continue;
        }
        if let Some(decoded) = decode_signal(sig, data) {
            signals.push(decoded);
        }
    }

    DecodedMessage {
        name: &entry.name,
        expected_len: entry.expected_len,
        actual_len: data.len(),
        signals,
    }
}

fn decode_signal<'a>(entry: &'a SignalEntry, data: &[u8]) -> Option<DecodedSignal<'a>> {
    let sig = &entry.signal;
    let start_bit = usize::try_from(sig.start_bit).ok()?;
    let size = usize::try_from(sig.size).ok()?;
    let raw_unsigned = decode_signal_bits(data, start_bit, size, sig.byte_order)?;

    let raw_signed = if sig.value_type == ValueType::Signed {
        let bits = u32::try_from(sig.size).ok()?;
        sign_extend(raw_unsigned, bits)
    } else {
        // Unsigned signals never overflow i64 since size <= 64 and the
        // high bit will only be set for size == 64; the cast then wraps
        // intentionally — physical-value math uses raw_unsigned anyway.
        raw_unsigned.cast_signed()
    };

    // f64 has 52-bit mantissa: signal sizes up to 53 bits round-trip
    // exactly, larger ones lose precision but match the convention used
    // by every other DBC tool. Allow the cast explicitly here.
    #[allow(clippy::cast_precision_loss)]
    let physical = match entry.extended_type {
        SignalExtendedValueType::IEEEfloat32Bit if size == 32 => {
            let bits = u32::try_from(raw_unsigned).ok()?;
            f64::from(f32::from_bits(bits)).mul_add(sig.factor, sig.offset)
        }
        SignalExtendedValueType::IEEEdouble64bit if size == 64 => {
            f64::from_bits(raw_unsigned).mul_add(sig.factor, sig.offset)
        }
        _ if sig.value_type == ValueType::Signed => {
            (raw_signed as f64).mul_add(sig.factor, sig.offset)
        }
        _ => (raw_unsigned as f64).mul_add(sig.factor, sig.offset),
    };

    // Resolve the value-table label, if any. Signed signals compare
    // against `raw_signed`; unsigned against `raw_unsigned` widened to
    // `i64` (signal sizes are <=64 bits; values above `i64::MAX` would
    // never match a DBC `VAL_` row anyway since `can-dbc` parses them
    // as `i64`).
    let lookup_key: i64 = if sig.value_type == ValueType::Signed {
        raw_signed
    } else {
        i64::try_from(raw_unsigned).unwrap_or(i64::MAX)
    };
    let label = entry
        .value_table
        .iter()
        .find(|e| e.raw == lookup_key)
        .map(|e| e.label.as_str());

    Some(DecodedSignal {
        name: &sig.name,
        unit: &sig.unit,
        raw_unsigned,
        raw_signed,
        value: physical,
        label,
    })
}

/// A decoded CAN message: the message's name, its declared and observed
/// payload lengths, and one entry per signal that fit the payload.
#[derive(Debug, Clone)]
pub struct DecodedMessage<'a> {
    pub name: &'a str,
    pub expected_len: usize,
    pub actual_len: usize,
    pub signals: Vec<DecodedSignal<'a>>,
}

/// A decoded signal value with both its raw bit-pattern and its physical
/// value (raw * factor + offset).
///
/// `label` is `Some(&str)` only if the DBC's `VAL_` table for this
/// signal has a row matching the decoded raw value (signed vs.
/// unsigned chosen by the signal's `@…+` / `@…-` flag); otherwise
/// `None`. The trace view and transmit panel use `label` to render
/// enum signals symbolically.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedSignal<'a> {
    pub name: &'a str,
    pub unit: &'a str,
    pub raw_unsigned: u64,
    pub raw_signed: i64,
    pub value: f64,
    pub label: Option<&'a str>,
}

/// A `(message, signal)` pair available for plotting / picking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalDescriptor {
    /// Raw CAN id of the owning message (29-bit if `extended`).
    pub message_id: u32,
    /// Whether `message_id` is a 29-bit extended id.
    pub extended: bool,
    pub message_name: String,
    pub signal_name: String,
    pub unit: String,
    /// True if the DBC defines a `VAL_` table for this signal — i.e.
    /// it's an enum / state signal whose decoded value should be
    /// rendered symbolically. A picker / plotter can use this without a
    /// separate `value_table` round-trip to decide between numeric and
    /// symbolic rendering.
    pub has_value_table: bool,
}

/// One DBC message as the GUI's DBC panel (Phase 12) renders it: the
/// message's identity, its free-text comment, its per-message
/// attributes, and the tree of signals that belong to it. Built by
/// [`Database::dbc_content`].
///
/// Sibling types: [`SignalDescriptor`] (flat plot-picker rows) and
/// [`MessageDescriptor`] (encoder-shaped per-signal numeric detail).
/// This one is the *discovery* shape — everything the panel's
/// fuzzy search has to match against is inlined as plain owned
/// strings.
#[derive(Debug, Clone, PartialEq)]
pub struct DbcMessageContent {
    /// Raw CAN id of the message (29-bit if `extended`).
    pub message_id: u32,
    /// Whether `message_id` is a 29-bit extended id.
    pub extended: bool,
    /// Resolved name — the long-symbol name when one is set,
    /// otherwise the `BO_` declared name.
    pub name: String,
    /// `CM_ BO_ <id> "..."` free-text comment. Empty when the DBC
    /// defines none — empty (not `Option::None`) so the panel's
    /// search can match against it without a nil check.
    pub comment: String,
    /// `BA_ "<name>" BO_ <id> <value>` per-message attribute values
    /// (excluding the long-symbol attributes — see the rustdoc on
    /// [`Database::dbc_content`]). Sorted by attribute name.
    pub attributes: Vec<DbcAttribute>,
    /// Signals in `SG_` declared order — the same order the DBC
    /// author wrote them, which matches their mental model of the
    /// message's bit layout.
    pub signals: Vec<DbcSignalContent>,
}

/// One signal inside a [`DbcMessageContent`] — the per-signal half
/// of the DBC discovery tree. Decoding / encoding still go through
/// [`Database::decode`] / [`Database::encode_frame`] / the rich
/// [`Database::describe_message`] view; this one is search-shaped.
#[derive(Debug, Clone, PartialEq)]
pub struct DbcSignalContent {
    /// Resolved name (long-symbol applied).
    pub name: String,
    /// Engineering unit from the `SG_` line. Empty when absent.
    pub unit: String,
    /// `CM_ SG_ <id> <name> "..."` comment. Empty when absent.
    pub comment: String,
    /// `BA_ "<name>" SG_ <id> <name> <value>` attribute values.
    /// Sorted by attribute name.
    pub attributes: Vec<DbcAttribute>,
    /// `VAL_` table rows — same shape (and sort order) as
    /// [`Database::value_table_for_signal`]. Empty when the signal
    /// has no value table.
    pub value_table: Vec<ValueTableEntry>,
}

/// One `BA_ "<name>" … <value>` attribute pair, stringified for
/// both display and fuzzy search in the DBC panel.
///
/// Numeric attributes (`Uint` / `Int` / `Double` in the DBC AST)
/// are formatted in their natural source-text shape: integers
/// without trailing zeroes, floats using Rust's default `f64`
/// formatter. Round-tripping the textual form is not a goal —
/// callers that need the original numeric value should read the
/// underlying DBC AST.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbcAttribute {
    pub name: String,
    pub value: String,
}

/// Rich descriptor for one DBC message — its identity, its declared
/// payload length, whether it uses extended multiplexing (the panel
/// falls back to bytes-only editing when this is true), and a rich
/// per-signal view. Returned by [`Database::describe_message`].
#[derive(Debug, Clone, PartialEq)]
pub struct MessageDescriptor {
    pub name: String,
    /// Declared `BO_` size in bytes.
    pub expected_len: usize,
    /// `true` if the DBC marks this as a CAN-FD message
    /// (`VFrameFormat` = 14/15, or `expected_len > 8` as fallback).
    /// The transmit panel uses this to set the frame's `kind` when
    /// the id binds to a DBC message.
    pub is_fd: bool,
    /// CAN-FD BRS (Bit Rate Switch) from the DBC's `GenMsgCANFDBRS`
    /// attribute. Defaults to `true` for FD messages with no
    /// attribute. Always `false` for classic messages.
    pub brs: bool,
    /// `true` if any signal in this message is
    /// [`SignalMux::MultiplexorAndMultiplexed`] (a "sub-mux" /
    /// extended multiplexing arm). The transmit panel treats these as
    /// not-supported for signal-level editing.
    pub uses_extended_mux: bool,
    pub signals: Vec<SignalDescriptorRich>,
}

/// Per-signal rich descriptor — everything the transmit panel's
/// signals table needs to render and validate a row without
/// reimplementing DBC walking.
#[derive(Debug, Clone, PartialEq)]
pub struct SignalDescriptorRich {
    pub name: String,
    pub unit: String,
    pub factor: f64,
    pub offset: f64,
    /// `SG_` declared minimum (physical units). Note that DBCs
    /// commonly declare `[0|0]` to mean "no constraint"; callers
    /// inspecting this should check for `min == max`.
    pub min: f64,
    pub max: f64,
    /// Signal width in bits (1..=64).
    pub size: u32,
    pub signed: bool,
    pub mux: SignalMux,
    pub float_kind: FloatKind,
    pub has_value_table: bool,
}

/// Mux indicator on a DBC signal. Mirrors `can_dbc::MultiplexIndicator`
/// but renamed for clarity and serialised with stable, lowercase
/// discriminants for the IPC layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalMux {
    /// Not part of any multiplexed group; always present in the
    /// decoded frame.
    Plain,
    /// The switch (`M`) signal whose value selects which arm of the
    /// multiplexed group is active.
    Multiplexor,
    /// A multiplexed sub-signal (`m<selector>`) — present only when
    /// the switch decodes to `selector`.
    Multiplexed { selector: u64 },
    /// A sub-switch — a multiplexed signal that *itself* multiplexes
    /// further sub-signals. The transmit panel treats this as
    /// "extended mux" and falls back to bytes-only.
    MultiplexorAndMultiplexed { selector: u64 },
}

/// How a signal's raw bits should be interpreted by encode / decode:
/// as a scaled integer (the DBC default), or as the bit pattern of
/// an IEEE-754 `f32` / `f64` (declared via `SIG_VALTYPE_`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FloatKind {
    Integer,
    Float32,
    Float64,
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

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_core::{CanId, Direction, CanFrame};

    const SAMPLE_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU1 ECU2

BO_ 256 EngineData: 8 ECU1
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16383.75] "rpm" ECU2
 SG_ EngineTemp : 16|8@1+ (1,-40) [-40|215] "degC" ECU2
 SG_ ThrottlePos : 24|8@1+ (0.392157,0) [0|100] "%" ECU2

BO_ 257 BigEndianMsg: 8 ECU1
 SG_ BeUnsigned : 7|16@0+ (1,0) [0|0] "" ECU2
 SG_ BeSigned : 23|16@0- (1,0) [0|0] "" ECU2

BO_ 258 SignedMsg: 8 ECU1
 SG_ LeSigned : 0|16@1- (1,0) [0|0] "" ECU2

BO_ 2566849794 ExtendedMsg: 8 ECU1
 SG_ ExtSig : 0|8@1+ (1,0) [0|0] "" ECU2

BO_ 512 MuxedMsg: 8 ECU1
 SG_ Mux M : 0|8@1+ (1,0) [0|0] "" ECU2
 SG_ Mode0Field m0 : 8|16@1+ (1,0) [0|0] "" ECU2
 SG_ Mode1Field m1 : 8|16@1+ (1,0) [0|0] "" ECU2
 SG_ Always : 24|8@1+ (1,0) [0|0] "" ECU2

BO_ 513 FloatMsg: 8 ECU1
 SG_ Lat : 0|32@1+ (1,0) [-90|90] "deg" ECU2
 SG_ Alt : 32|32@1- (0.01,0) [0|0] "m" ECU2

SIG_VALTYPE_ 513 Lat : 1;
"#;

    fn make_frame(raw_id: u32, extended: bool, data: Vec<u8>) -> CanFrame {
        let id = if extended {
            CanId::extended(raw_id).unwrap()
        } else {
            CanId::standard(raw_id).unwrap()
        };
        CanFrame::classic(0, 0, id, Direction::Rx, data).unwrap()
    }

    fn signal_by_name<'a>(msg: &'a DecodedMessage<'_>, name: &str) -> &'a DecodedSignal<'a> {
        msg.signals.iter().find(|s| s.name == name).unwrap_or_else(|| {
            panic!(
                "signal {name} not found, got: {:?}",
                msg.signals.iter().map(|s| s.name).collect::<Vec<_>>()
            )
        })
    }

    #[test]
    fn parses_sample_dbc() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        assert_eq!(db.message_count(), 6);
    }

    #[test]
    fn signals_lists_every_signal_sorted() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let sigs = db.signals();
        // 3 + 2 + 1 + 1 + 4 + 2 = 13 signals across the six messages.
        assert_eq!(sigs.len(), 13);
        // Sorted by (message_name, signal_name).
        let mut sorted = sigs.clone();
        sorted.sort_by(|a, b| {
            a.message_name
                .cmp(&b.message_name)
                .then_with(|| a.signal_name.cmp(&b.signal_name))
        });
        assert_eq!(sigs, sorted);

        let speed = sigs
            .iter()
            .find(|s| s.signal_name == "EngineSpeed")
            .unwrap();
        assert_eq!(speed.message_name, "EngineData");
        assert_eq!(speed.message_id, 256);
        assert!(!speed.extended);
        assert_eq!(speed.unit, "rpm");

        let ext = sigs.iter().find(|s| s.signal_name == "ExtSig").unwrap();
        assert!(ext.extended);
        assert_eq!(ext.message_id, 0x98FF_0502 & 0x1FFF_FFFF);
    }

    #[test]
    fn decode_returns_none_for_unknown_id() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let frame = make_frame(0x600, false, vec![0; 8]);
        assert!(db.decode(&frame).is_none());
    }

    #[test]
    fn decodes_little_endian_unsigned_with_factor_and_offset() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // EngineSpeed: 16 LE bits at offset 0, factor 0.25.
        // Raw 0x1234 (little-endian: bytes [0x34, 0x12]) → 4660 * 0.25 = 1165.0
        // EngineTemp: byte 2 = 100, factor 1, offset -40 → 60 degC
        let data = vec![0x34, 0x12, 100, 50, 0, 0, 0, 0];
        let frame = make_frame(256, false, data);
        let decoded = db.decode(&frame).unwrap();
        assert_eq!(decoded.name, "EngineData");

        let speed = signal_by_name(&decoded, "EngineSpeed");
        assert!((speed.value - 1165.0).abs() < 1e-9, "got {}", speed.value);
        assert_eq!(speed.unit, "rpm");

        let temp = signal_by_name(&decoded, "EngineTemp");
        assert!((temp.value - 60.0).abs() < 1e-9, "got {}", temp.value);
    }

    #[test]
    fn decodes_big_endian_unsigned() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // BeUnsigned: 16 BE bits starting at byte 0 MSB. Bytes [0x12, 0x34] → 0x1234 = 4660
        let data = vec![0x12, 0x34, 0, 0, 0, 0, 0, 0];
        let frame = make_frame(257, false, data);
        let decoded = db.decode(&frame).unwrap();
        let s = signal_by_name(&decoded, "BeUnsigned");
        assert_eq!(s.raw_unsigned, 0x1234);
        assert!((s.value - 4660.0).abs() < 1e-9);
    }

    #[test]
    fn decodes_big_endian_signed_negative() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // BeSigned: 16 BE bits starting at byte 2 MSB. Bytes [_,_,0xFF,0xFE,...]
        // → 0xFFFE = -2 in two's complement (16 bit signed).
        let data = vec![0, 0, 0xFF, 0xFE, 0, 0, 0, 0];
        let frame = make_frame(257, false, data);
        let decoded = db.decode(&frame).unwrap();
        let s = signal_by_name(&decoded, "BeSigned");
        assert_eq!(s.raw_signed, -2);
        assert!((s.value - -2.0).abs() < 1e-9);
    }

    #[test]
    fn decodes_little_endian_signed_negative() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // LeSigned: 16 LE bits at offset 0 signed.
        // Bytes [0xFF, 0xFF, ...] = 0xFFFF unsigned = -1 signed.
        let data = vec![0xFF, 0xFF, 0, 0, 0, 0, 0, 0];
        let frame = make_frame(258, false, data);
        let decoded = db.decode(&frame).unwrap();
        let s = signal_by_name(&decoded, "LeSigned");
        assert_eq!(s.raw_signed, -1);
        assert!((s.value - -1.0).abs() < 1e-9);
    }

    #[test]
    fn decodes_extended_id_message() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // BO_ 2566849794 (= 0x98FF0502) has the extended-id flag (bit 31)
        // set; the underlying 29-bit id is 0x18FF0502.
        let raw_id = 0x98FF_0502_u32 & 0x1FFF_FFFF;
        let data = vec![0x42, 0, 0, 0, 0, 0, 0, 0];
        let frame = make_frame(raw_id, true, data);
        let decoded = db.decode(&frame).unwrap();
        let s = signal_by_name(&decoded, "ExtSig");
        assert_eq!(s.raw_unsigned, 0x42);
    }

    #[test]
    fn standard_and_extended_ids_with_same_raw_dont_collide() {
        // Sanity: EngineData lives at standard 256. A frame at extended 256
        // should not match it.
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let frame = make_frame(256, true, vec![0; 8]);
        assert!(db.decode(&frame).is_none());
    }

    #[test]
    fn multiplexed_signal_only_decoded_for_matching_selector() {
        let db = Database::parse(SAMPLE_DBC).unwrap();

        // Mux=0, Mode0Field bytes 1..3 = 0xAA 0xBB → 0xBBAA
        let frame = make_frame(512, false, vec![0, 0xAA, 0xBB, 0x77, 0, 0, 0, 0]);
        let decoded = db.decode(&frame).unwrap();
        let names: Vec<&str> = decoded.signals.iter().map(|s| s.name).collect();
        assert!(names.contains(&"Mux"));
        assert!(names.contains(&"Mode0Field"));
        assert!(names.contains(&"Always"));
        assert!(!names.contains(&"Mode1Field"));

        let m0 = signal_by_name(&decoded, "Mode0Field");
        assert_eq!(m0.raw_unsigned, 0xBBAA);

        // Mux=1 → Mode1Field decoded, Mode0Field skipped.
        let frame = make_frame(512, false, vec![1, 0x12, 0x34, 0xEE, 0, 0, 0, 0]);
        let decoded = db.decode(&frame).unwrap();
        let names: Vec<&str> = decoded.signals.iter().map(|s| s.name).collect();
        assert!(!names.contains(&"Mode0Field"));
        assert!(names.contains(&"Mode1Field"));
        let m1 = signal_by_name(&decoded, "Mode1Field");
        assert_eq!(m1.raw_unsigned, 0x3412);
    }

    #[test]
    fn decodes_ieee_float_signal_via_sig_valtype() {
        // Lat is declared as a 32-bit signal with `SIG_VALTYPE_ ... 1;`
        // — the bits should be interpreted as IEEE 754 f32, not as a
        // scaled integer. Alt has no SIG_VALTYPE_ entry, so it falls
        // through to the signed-int path and exercises the regression
        // case for the rest of the message.
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let lat: f32 = 37.7749;
        let alt_raw_i32: i32 = -1234;
        let mut data = vec![0u8; 8];
        data[0..4].copy_from_slice(&lat.to_le_bytes());
        data[4..8].copy_from_slice(&alt_raw_i32.to_le_bytes());

        let frame = make_frame(513, false, data);
        let decoded = db.decode(&frame).unwrap();

        let lat_sig = signal_by_name(&decoded, "Lat");
        assert!((lat_sig.value - f64::from(lat)).abs() < 1e-5, "got {}", lat_sig.value);
        assert_eq!(lat_sig.unit, "deg");

        let alt_sig = signal_by_name(&decoded, "Alt");
        assert!((alt_sig.value - (f64::from(alt_raw_i32) * 0.01)).abs() < 1e-9);
    }

    // The long-name extension: a truncated name on the `BO_` / `SG_`
    // line plus a `BA_ "System…LongSymbol"` attribute with the real one.
    const LONG_SYMBOL_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU1 ECU2

BO_ 256 ShortMsg: 8 ECU1
 SG_ ShortSig : 0|8@1+ (1,0) [0|0] "" ECU2

BA_DEF_ BO_ "SystemMessageLongSymbol" STRING ;
BA_DEF_ SG_ "SystemSignalLongSymbol" STRING ;
BA_DEF_DEF_ "SystemMessageLongSymbol" "";
BA_DEF_DEF_ "SystemSignalLongSymbol" "";
BA_ "SystemMessageLongSymbol" BO_ 256 "AVeryLongMessageNameThatExceedsThirtyTwoChars";
BA_ "SystemSignalLongSymbol" SG_ 256 ShortSig "AVeryLongSignalNameThatExceedsThirtyTwoChars";
"#;

    #[test]
    fn resolves_long_symbol_message_and_signal_names() {
        let db = Database::parse(LONG_SYMBOL_DBC).unwrap();
        let decoded = db.decode(&make_frame(256, false, vec![7u8; 8])).unwrap();
        assert_eq!(decoded.name, "AVeryLongMessageNameThatExceedsThirtyTwoChars");
        assert_eq!(
            decoded.signals.iter().map(|s| s.name).collect::<Vec<_>>(),
            vec!["AVeryLongSignalNameThatExceedsThirtyTwoChars"],
        );
    }

    const VAL_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU1

BO_ 256 Gear: 8 ECU1
 SG_ Mode : 0|8@1+ (1,0) [0|0] "" ECU1
 SG_ Direction : 8|8@1- (1,0) [-1|1] "" ECU1
 SG_ Rpm : 16|16@1+ (1,0) [0|0] "rpm" ECU1

VAL_ 256 Mode 0 "Park" 1 "Reverse" 2 "Neutral" 3 "Drive" ;
VAL_ 256 Direction -1 "Backward" 0 "Stopped" 1 "Forward" ;
"#;

    #[test]
    fn decoded_signal_carries_value_table_label_for_unsigned() {
        let db = Database::parse(VAL_DBC).unwrap();
        // Mode = byte 0 = 3 -> "Drive"
        let frame = make_frame(256, false, vec![3, 0, 0, 0, 0, 0, 0, 0]);
        let decoded = db.decode(&frame).unwrap();
        let mode = signal_by_name(&decoded, "Mode");
        assert_eq!(mode.label, Some("Drive"));
        let rpm = signal_by_name(&decoded, "Rpm");
        assert_eq!(rpm.label, None, "no value table -> no label");
    }

    #[test]
    fn decoded_signal_carries_value_table_label_for_signed_negative() {
        let db = Database::parse(VAL_DBC).unwrap();
        // Direction = byte 1 = 0xFF -> -1 -> "Backward"
        let frame = make_frame(256, false, vec![0, 0xFF, 0, 0, 0, 0, 0, 0]);
        let decoded = db.decode(&frame).unwrap();
        let dir = signal_by_name(&decoded, "Direction");
        assert_eq!(dir.label, Some("Backward"));
    }

    #[test]
    fn decoded_signal_label_is_none_for_unmapped_value() {
        let db = Database::parse(VAL_DBC).unwrap();
        // Mode = 99 -> no VAL_ row -> no label
        let frame = make_frame(256, false, vec![99, 0, 0, 0, 0, 0, 0, 0]);
        let decoded = db.decode(&frame).unwrap();
        assert_eq!(signal_by_name(&decoded, "Mode").label, None);
    }

    #[test]
    fn signals_descriptor_marks_value_table_presence() {
        let db = Database::parse(VAL_DBC).unwrap();
        let sigs = db.signals();
        let mode = sigs.iter().find(|s| s.signal_name == "Mode").unwrap();
        assert!(mode.has_value_table);
        let rpm = sigs.iter().find(|s| s.signal_name == "Rpm").unwrap();
        assert!(!rpm.has_value_table);
    }

    #[test]
    fn value_table_for_signal_returns_sorted_rows() {
        let db = Database::parse(VAL_DBC).unwrap();
        let rows = db.value_table_for_signal(256, false, "Mode").unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].raw, 0);
        assert_eq!(rows[0].label, "Park");
        assert_eq!(rows[3].raw, 3);
        assert_eq!(rows[3].label, "Drive");
        // Signed table: rows sorted ascending, including the negative one.
        let signed = db.value_table_for_signal(256, false, "Direction").unwrap();
        assert_eq!(signed.iter().map(|e| e.raw).collect::<Vec<_>>(), vec![-1, 0, 1]);
        // No table -> None.
        assert!(db.value_table_for_signal(256, false, "Rpm").is_none());
        assert!(db.value_table_for_signal(999, false, "Mode").is_none());
    }

    #[test]
    fn signal_outside_payload_is_skipped() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // EngineData expects 8 bytes; if we pass only 1, every signal that
        // reaches past byte 0 should be skipped, not panic.
        let frame = make_frame(256, false, vec![0xAA]);
        let decoded = db.decode(&frame).unwrap();
        // EngineSpeed needs bits 0..16 (bytes 0..2) — won't fit, dropped.
        assert!(decoded
            .signals
            .iter()
            .all(|s| s.name != "EngineSpeed" && s.name != "EngineTemp"));
        assert_eq!(decoded.actual_len, 1);
        assert_eq!(decoded.expected_len, 8);
    }

    // --- encode_frame ---

    fn std_id(raw: u32) -> CanId {
        CanId::standard(raw).unwrap()
    }

    /// Look up a signal's decoded physical value, asserting it exists.
    fn physical_of(msg: &DecodedMessage<'_>, name: &str) -> f64 {
        signal_by_name(msg, name).value
    }

    #[test]
    fn encode_returns_none_for_unknown_id() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        assert!(db.encode_frame(std_id(0x600), &[("Whatever", 0.0)], &mut base).is_none());
    }

    #[test]
    fn encode_flags_unknown_signals_but_still_reports() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        let report = db
            .encode_frame(
                std_id(256),
                &[("EngineSpeed", 1165.0), ("NotASignal", 0.0)],
                &mut base,
            )
            .unwrap();
        assert_eq!(report.written.len(), 1);
        assert_eq!(report.written[0].name, "EngineSpeed");
        assert_eq!(report.skipped.len(), 1);
        assert_eq!(report.skipped[0].name, "NotASignal");
        assert_eq!(report.skipped[0].reason, SkipReason::SignalNotFound);
    }

    #[test]
    fn encode_round_trips_little_endian_unsigned_with_factor() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        // EngineSpeed: 16 LE bits factor 0.25.
        db.encode_frame(std_id(256), &[("EngineSpeed", 1165.0)], &mut base)
            .unwrap();
        let decoded = db.decode(&make_frame(256, false, base.clone())).unwrap();
        assert!((physical_of(&decoded, "EngineSpeed") - 1165.0).abs() < 1e-9);
        // Bytes 0..2 are the encoded raw 0x1234; bytes 2..8 untouched.
        assert_eq!(&base[0..2], &[0x34, 0x12]);
        assert_eq!(&base[2..], &[0u8; 6]);
    }

    #[test]
    fn encode_round_trips_little_endian_signed_negative() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        // LeSigned: 16 LE bits signed, factor 1 offset 0.
        db.encode_frame(std_id(258), &[("LeSigned", -1.0)], &mut base)
            .unwrap();
        assert_eq!(&base[0..2], &[0xFF, 0xFF]);
        let decoded = db.decode(&make_frame(258, false, base.clone())).unwrap();
        let s = signal_by_name(&decoded, "LeSigned");
        assert_eq!(s.raw_signed, -1);
        assert!((s.value + 1.0).abs() < 1e-9);
    }

    #[test]
    fn encode_round_trips_big_endian_signed_negative() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        // BeSigned lives at start_bit 23, 16 BE bits; bytes [2] then [3].
        db.encode_frame(std_id(257), &[("BeSigned", -2.0)], &mut base)
            .unwrap();
        assert_eq!(base[2], 0xFF);
        assert_eq!(base[3], 0xFE);
        let decoded = db.decode(&make_frame(257, false, base.clone())).unwrap();
        let s = signal_by_name(&decoded, "BeSigned");
        assert_eq!(s.raw_signed, -2);
    }

    #[test]
    fn encode_round_trips_offset_signal() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        // EngineTemp: 8 bits factor 1 offset -40 → physical 60 → raw 100.
        db.encode_frame(std_id(256), &[("EngineTemp", 60.0)], &mut base)
            .unwrap();
        assert_eq!(base[2], 100);
        let decoded = db.decode(&make_frame(256, false, base.clone())).unwrap();
        assert!((physical_of(&decoded, "EngineTemp") - 60.0).abs() < 1e-9);
    }

    #[test]
    fn encode_round_trips_ieee_float32_signal() {
        // Lat has `SIG_VALTYPE_ … 1;`, factor 1 offset 0.
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        let physical = 37.7749_f64;
        db.encode_frame(std_id(513), &[("Lat", physical)], &mut base)
            .unwrap();
        let decoded = db.decode(&make_frame(513, false, base.clone())).unwrap();
        let lat = signal_by_name(&decoded, "Lat");
        // f32 precision: agree to ~1e-5.
        assert!((lat.value - physical).abs() < 1e-4);
    }

    #[test]
    fn encode_preserves_neighbouring_bytes() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // Pre-populate the payload with a pattern that doesn't overlap
        // EngineSpeed's bytes — bytes 2..8 are EngineTemp/ThrottlePos/pad.
        let mut base = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x12, 0x34, 0x56, 0x78];
        db.encode_frame(std_id(256), &[("EngineSpeed", 1165.0)], &mut base)
            .unwrap();
        // Bytes 0..2 are EngineSpeed's; bytes 2..8 must survive intact.
        assert_eq!(&base[2..], &[0xBE, 0xEF, 0x12, 0x34, 0x56, 0x78]);
    }

    #[test]
    fn encode_saturates_out_of_range_unsigned() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        // EngineSpeed: 16-bit unsigned, factor 0.25. Max raw = 65535,
        // max physical = 65535 * 0.25 = 16383.75. Asking for 20000 should
        // saturate to raw=65535.
        let report = db
            .encode_frame(std_id(256), &[("EngineSpeed", 20000.0)], &mut base)
            .unwrap();
        assert_eq!(report.written.len(), 1);
        assert!(report.written[0].saturated, "expected saturation flag");
        assert_eq!(report.written[0].raw_unsigned, 0xFFFF);
        assert_eq!(&base[0..2], &[0xFF, 0xFF]);

        // Negative value on an unsigned signal saturates to 0.
        let mut base = vec![0xAAu8; 8];
        let report = db
            .encode_frame(std_id(256), &[("EngineSpeed", -1.0)], &mut base)
            .unwrap();
        assert!(report.written[0].saturated);
        assert_eq!(report.written[0].raw_unsigned, 0);
        assert_eq!(&base[0..2], &[0x00, 0x00]);
        // Bytes outside EngineSpeed's window preserved.
        assert_eq!(&base[2..], &[0xAA; 6]);
    }

    #[test]
    fn encode_saturates_out_of_range_signed() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        // LeSigned: 16-bit signed; max +32767, min -32768.
        let report = db
            .encode_frame(std_id(258), &[("LeSigned", 1e9)], &mut base)
            .unwrap();
        assert!(report.written[0].saturated);
        // Raw bits should be the unsigned representation of 32767.
        assert_eq!(report.written[0].raw_unsigned, 0x7FFF);

        let report = db
            .encode_frame(std_id(258), &[("LeSigned", -1e9)], &mut base)
            .unwrap();
        assert!(report.written[0].saturated);
        // i16::MIN = -32768 = 0x8000 (low 16 bits).
        assert_eq!(report.written[0].raw_unsigned, 0x8000);
    }

    #[test]
    fn encode_skips_signals_that_dont_fit_base() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // Only 1 byte of base; EngineSpeed needs 2.
        let mut base = vec![0xAAu8; 1];
        let before = base.clone();
        let report = db
            .encode_frame(std_id(256), &[("EngineSpeed", 1165.0)], &mut base)
            .unwrap();
        assert_eq!(report.written.len(), 0);
        assert_eq!(report.skipped.len(), 1);
        assert_eq!(report.skipped[0].reason, SkipReason::BaseTooShort);
        // Base must be unchanged when the only signal was skipped.
        assert_eq!(base, before);
    }

    #[test]
    fn encode_round_trips_muxed_signals_for_each_arm() {
        // MuxedMsg has Mux (selector), Mode0Field m0, Mode1Field m1,
        // Always (plain). Encoding switch + the active arm's sub-signal
        // should round-trip through decode.
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];

        // Arm 0: M=0, Mode0Field=0xAABB, Always=0x77.
        db.encode_frame(
            std_id(512),
            &[
                ("Mux", 0.0),
                ("Mode0Field", 0xAABB_u32.into()),
                ("Always", 0x77_u32.into()),
            ],
            &mut base,
        )
        .unwrap();
        let decoded = db.decode(&make_frame(512, false, base.clone())).unwrap();
        let names: Vec<&str> = decoded.signals.iter().map(|s| s.name).collect();
        assert!(names.contains(&"Mode0Field"));
        assert!(!names.contains(&"Mode1Field"));
        assert_eq!(signal_by_name(&decoded, "Mode0Field").raw_unsigned, 0xAABB);
        assert_eq!(signal_by_name(&decoded, "Always").raw_unsigned, 0x77);

        // Arm 1: M=1, Mode1Field=0x1234 — write switch + new sub-signal
        // in the same call. The bits for Mode0Field overlap Mode1Field
        // in the payload, so Mode0Field bits get overwritten by the new
        // sub-signal write. Always (a non-mux signal) survives.
        db.encode_frame(
            std_id(512),
            &[("Mux", 1.0), ("Mode1Field", 0x1234_u32.into())],
            &mut base,
        )
        .unwrap();
        let decoded = db.decode(&make_frame(512, false, base.clone())).unwrap();
        let names: Vec<&str> = decoded.signals.iter().map(|s| s.name).collect();
        assert!(!names.contains(&"Mode0Field"));
        assert!(names.contains(&"Mode1Field"));
        assert_eq!(signal_by_name(&decoded, "Mode1Field").raw_unsigned, 0x1234);
        // Always (byte 3, not part of mux) preserved through the switch.
        assert_eq!(signal_by_name(&decoded, "Always").raw_unsigned, 0x77);
    }

    #[test]
    fn describe_message_returns_rich_descriptor_with_range_and_mux() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // MuxedMsg: switch + two mux arms + Always.
        let desc = db.describe_message(std_id(512)).unwrap();
        assert_eq!(desc.name, "MuxedMsg");
        assert_eq!(desc.expected_len, 8);
        assert!(!desc.uses_extended_mux);

        let by_name: HashMap<&str, &SignalDescriptorRich> =
            desc.signals.iter().map(|s| (s.name.as_str(), s)).collect();
        assert!(matches!(by_name["Mux"].mux, SignalMux::Multiplexor));
        assert!(matches!(
            by_name["Mode0Field"].mux,
            SignalMux::Multiplexed { selector: 0 },
        ));
        assert!(matches!(
            by_name["Mode1Field"].mux,
            SignalMux::Multiplexed { selector: 1 },
        ));
        assert!(matches!(by_name["Always"].mux, SignalMux::Plain));

        // EngineSpeed declares [0|16383.75] — non-default range.
        let speed = db
            .describe_message(std_id(256))
            .unwrap()
            .signals
            .into_iter()
            .find(|s| s.name == "EngineSpeed")
            .unwrap();
        assert!((speed.min - 0.0).abs() < 1e-9);
        assert!((speed.max - 16383.75).abs() < 1e-9);
        assert_eq!(speed.size, 16);
        assert!(!speed.signed);
        assert!(matches!(speed.float_kind, FloatKind::Integer));
        assert!((speed.factor - 0.25).abs() < 1e-9);
    }

    #[test]
    fn describe_message_marks_ieee_float_signals() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let desc = db.describe_message(std_id(513)).unwrap();
        let lat = desc.signals.iter().find(|s| s.name == "Lat").unwrap();
        assert!(matches!(lat.float_kind, FloatKind::Float32));
        // Alt has no SIG_VALTYPE_ entry — stays Integer despite being
        // a signed 32-bit signal with a fractional factor.
        let alt = desc.signals.iter().find(|s| s.name == "Alt").unwrap();
        assert!(matches!(alt.float_kind, FloatKind::Integer));
        assert!(alt.signed);
    }

    #[test]
    fn describe_message_returns_none_for_unknown_id() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        assert!(db.describe_message(std_id(0x600)).is_none());
    }

    const FD_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU

BO_ 100 ClassicByDefault: 8 ECU
 SG_ Sig : 0|8@1+ (1,0) [0|0] "" ECU

BO_ 200 FdByVFrameFormat: 8 ECU
 SG_ Sig : 0|8@1+ (1,0) [0|0] "" ECU

BO_ 300 FdBySize: 16 ECU
 SG_ Sig : 0|8@1+ (1,0) [0|0] "" ECU

BO_ 400 FdBrsOff: 8 ECU
 SG_ Sig : 0|8@1+ (1,0) [0|0] "" ECU

BA_DEF_ BO_ "VFrameFormat" INT 0 16;
BA_DEF_ BO_ "GenMsgCANFDBRS" INT 0 1;
BA_DEF_DEF_ "VFrameFormat" 0;
BA_DEF_DEF_ "GenMsgCANFDBRS" 1;
BA_ "VFrameFormat" BO_ 200 14;
BA_ "VFrameFormat" BO_ 400 14;
BA_ "GenMsgCANFDBRS" BO_ 400 0;
"#;

    #[test]
    fn describe_message_derives_fd_from_vframeformat_or_size() {
        let db = Database::parse(FD_DBC).unwrap();
        let classic = db.describe_message(std_id(100)).unwrap();
        assert!(!classic.is_fd, "size==8 with no VFrameFormat → classic");
        assert!(!classic.brs);

        let by_attr = db.describe_message(std_id(200)).unwrap();
        assert!(by_attr.is_fd, "VFrameFormat=14 → FD");
        assert!(by_attr.brs, "no GenMsgCANFDBRS → default true on FD");

        let by_size = db.describe_message(std_id(300)).unwrap();
        assert!(by_size.is_fd, "size>8 → FD fallback");
        assert!(by_size.brs);

        let brs_off = db.describe_message(std_id(400)).unwrap();
        assert!(brs_off.is_fd);
        assert!(!brs_off.brs, "GenMsgCANFDBRS=0 → BRS off");
    }

    #[test]
    fn encode_round_trips_every_signal_in_demo_fixture() {
        // Property test: for every (message, signal) pair, encoding the
        // physical value `factor + offset` (which maps to raw = 1 for
        // any integer signal, exactly representable for any signal
        // size ≥ 1 bit, signed or unsigned) round-trips through decode
        // to the same physical value. IEEE-typed signals just need a
        // finite physical f32 / f64 can hold.
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // Walk the signals via the parsed entries so we can look up
        // factor / offset per signal. `db.signals()` returns a
        // descriptor view that doesn't carry these.
        for (key, entry) in &db.messages {
            let (raw_id, extended) = message_id_parts(*key);
            let id = if extended {
                CanId::extended(raw_id).unwrap()
            } else {
                CanId::standard(raw_id).unwrap()
            };
            for sig in &entry.signals {
                let physical: f64 = sig.signal.factor + sig.signal.offset;
                let mut base = vec![0u8; entry.expected_len.max(8)];
                let report = db
                    .encode_frame(id, &[(sig.signal.name.as_str(), physical)], &mut base)
                    .unwrap_or_else(|| panic!("encode_frame returned None for {}", entry.name));
                assert_eq!(
                    report.written.len(),
                    1,
                    "no successful write for {}::{} (skipped: {:?})",
                    entry.name,
                    sig.signal.name,
                    report.skipped,
                );

                let decoded = db
                    .decode(&make_frame(raw_id, extended, base.clone()))
                    .unwrap();
                // Muxed sub-signals are filtered by decode when the
                // mux switch's encoded raw value doesn't match this
                // arm; in that case there's nothing to compare against
                // and we move on. The non-muxed and switch signals are
                // always present.
                if let Some(s) = decoded
                    .signals
                    .iter()
                    .find(|s| s.name == sig.signal.name)
                {
                    // f32 IEEE signals lose precision in the bottom
                    // few bits; everything else is exact.
                    let tol = if matches!(
                        sig.extended_type,
                        SignalExtendedValueType::IEEEfloat32Bit
                    ) {
                        1e-5
                    } else {
                        1e-9
                    };
                    assert!(
                        (s.value - physical).abs() < tol,
                        "{}::{}: encoded {physical}, decoded back as {} (raw_unsigned={})",
                        entry.name,
                        sig.signal.name,
                        s.value,
                        s.raw_unsigned,
                    );
                }
            }
        }
    }

    // --- dbc_content (Phase 12 DBC panel) ---

    /// Fixture covering the kinds of text the discovery panel's fuzzy
    /// search has to match: per-message comments + attributes, per-signal
    /// comments + attributes, units, and value tables.
    const COMMENTED_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU1

BO_ 256 Gear: 8 ECU1
 SG_ Mode : 0|8@1+ (1,0) [0|0] "" ECU1
 SG_ Rpm : 16|16@1+ (1,0) [0|0] "rpm" ECU1

BO_ 257 Coolant: 8 ECU1
 SG_ Temperature : 0|8@1+ (1,-40) [-40|215] "degC" ECU1

CM_ BO_ 256 "Gear shifter state.";
CM_ SG_ 256 Mode "Selected gear mode.";
CM_ SG_ 257 Temperature "Engine coolant temperature.";

BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;
BA_DEF_ SG_ "GenSigStartValue" FLOAT 0 1000;
BA_DEF_DEF_ "GenMsgCycleTime" 0;
BA_ "GenMsgCycleTime" BO_ 256 100;
BA_ "GenMsgCycleTime" BO_ 257 20;
BA_ "GenSigStartValue" SG_ 256 Mode 1;

VAL_ 256 Mode 0 "Park" 1 "Reverse" 2 "Neutral" 3 "Drive" ;
"#;

    #[test]
    fn dbc_content_sorts_messages_by_id_and_preserves_signal_order() {
        let db = Database::parse(COMMENTED_DBC).unwrap();
        let content = db.dbc_content();
        assert_eq!(content.len(), 2);
        // Message 256 (Gear) comes before 257 (Coolant) by id.
        assert_eq!(content[0].message_id, 256);
        assert!(!content[0].extended);
        assert_eq!(content[0].name, "Gear");
        assert_eq!(content[1].message_id, 257);
        assert_eq!(content[1].name, "Coolant");

        // Signals in source order (Mode before Rpm — they appear that way
        // in the fixture).
        assert_eq!(
            content[0]
                .signals
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Mode", "Rpm"],
        );
    }

    #[test]
    fn dbc_content_carries_message_and_signal_comments() {
        let db = Database::parse(COMMENTED_DBC).unwrap();
        let content = db.dbc_content();
        let gear = content.iter().find(|m| m.name == "Gear").unwrap();
        assert_eq!(gear.comment, "Gear shifter state.");
        let mode = gear.signals.iter().find(|s| s.name == "Mode").unwrap();
        assert_eq!(mode.comment, "Selected gear mode.");
        // Rpm has no signal comment — empty string, not absent.
        let rpm = gear.signals.iter().find(|s| s.name == "Rpm").unwrap();
        assert_eq!(rpm.comment, "");
    }

    #[test]
    fn dbc_content_carries_message_attributes_stringified() {
        let db = Database::parse(COMMENTED_DBC).unwrap();
        let content = db.dbc_content();
        let gear = content.iter().find(|m| m.message_id == 256).unwrap();
        let cycle = gear
            .attributes
            .iter()
            .find(|a| a.name == "GenMsgCycleTime")
            .unwrap();
        assert_eq!(cycle.value, "100");
        // Attributes are sorted by name for a stable display order.
        assert!(gear.attributes.windows(2).all(|w| w[0].name <= w[1].name));
    }

    #[test]
    fn dbc_content_carries_signal_attributes() {
        let db = Database::parse(COMMENTED_DBC).unwrap();
        let content = db.dbc_content();
        let gear = content.iter().find(|m| m.name == "Gear").unwrap();
        let mode = gear.signals.iter().find(|s| s.name == "Mode").unwrap();
        let start = mode
            .attributes
            .iter()
            .find(|a| a.name == "GenSigStartValue")
            .unwrap();
        // The attribute value was `1` (parsed as Uint), so it serialises
        // back as "1" (no float formatting).
        assert_eq!(start.value, "1");
    }

    #[test]
    fn dbc_content_carries_signal_value_table() {
        let db = Database::parse(COMMENTED_DBC).unwrap();
        let content = db.dbc_content();
        let gear = content.iter().find(|m| m.name == "Gear").unwrap();
        let mode = gear.signals.iter().find(|s| s.name == "Mode").unwrap();
        let labels: Vec<&str> = mode.value_table.iter().map(|e| e.label.as_str()).collect();
        assert_eq!(labels, vec!["Park", "Reverse", "Neutral", "Drive"]);
        // Signals without a VAL_ table get an empty (not absent) list.
        let rpm = gear.signals.iter().find(|s| s.name == "Rpm").unwrap();
        assert!(rpm.value_table.is_empty());
    }

    #[test]
    fn dbc_content_includes_extended_id_messages() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let content = db.dbc_content();
        let ext = content.iter().find(|m| m.name == "ExtendedMsg").unwrap();
        assert!(ext.extended);
        assert_eq!(ext.message_id, 0x98FF_0502 & 0x1FFF_FFFF);
    }

    #[test]
    fn dbc_content_uses_long_symbol_names() {
        // LONG_SYMBOL_DBC is defined for the existing
        // `resolves_long_symbol_message_and_signal_names` test.
        let db = Database::parse(LONG_SYMBOL_DBC).unwrap();
        let content = db.dbc_content();
        assert_eq!(content.len(), 1);
        assert_eq!(
            content[0].name,
            "AVeryLongMessageNameThatExceedsThirtyTwoChars",
        );
        assert_eq!(content[0].signals.len(), 1);
        assert_eq!(
            content[0].signals[0].name,
            "AVeryLongSignalNameThatExceedsThirtyTwoChars",
        );
    }
}
