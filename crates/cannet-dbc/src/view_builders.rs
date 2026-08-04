//! View builders: the rich / wire-facing descriptor shapes the GUI
//! renders, built from the [`Database`] model. Three distinct views —
//! the flat plot-picker rows ([`SignalDescriptor`]), the encoder-shaped
//! numeric detail ([`MessageDescriptor`] / [`SignalDescriptorRich`]),
//! and the discovery tree ([`DbcMessageContent`] / [`DbcSignalContent`])
//! — plus the cheap borrowing id/name sweeps. Decode / encode still go
//! through the dedicated modules; these are metadata views.

use can_dbc::{
    ByteOrder as CanDbcByteOrder, MultiplexIndicator, NumericValue, SignalExtendedValueType,
    ValueType,
};

use crate::calc::CalculatedFieldsConfig;
use crate::model::{
    canid_to_message_id, is_enum, message_id_parts, value_is_raw_integer, Database, DbcAttribute,
    ValueTableEntry,
};

/// Map can-dbc's `MultiplexIndicator` to this crate's [`SignalMux`].
/// Shared by [`Database::describe_message`] and [`Database::dbc_content`],
/// which build different descriptor shapes over the same mux facts.
fn signal_mux_from_indicator(indicator: MultiplexIndicator) -> SignalMux {
    match indicator {
        MultiplexIndicator::Plain => SignalMux::Plain,
        MultiplexIndicator::Multiplexor => SignalMux::Multiplexor,
        MultiplexIndicator::MultiplexedSignal(sel) => SignalMux::Multiplexed { selector: sel },
        MultiplexIndicator::MultiplexorAndMultiplexedSignal(sel) => {
            SignalMux::MultiplexorAndMultiplexed { selector: sel }
        }
    }
}

/// Map can-dbc's `SignalExtendedValueType` to this crate's [`FloatKind`].
/// Shared by the two descriptor builders (see [`signal_mux_from_indicator`]).
fn float_kind_from_extended(extended: SignalExtendedValueType) -> FloatKind {
    match extended {
        SignalExtendedValueType::IEEEfloat32Bit => FloatKind::Float32,
        SignalExtendedValueType::IEEEdouble64bit => FloatKind::Float64,
        SignalExtendedValueType::SignedOrUnsignedInteger => FloatKind::Integer,
    }
}

impl Database {
    /// Every message as `(message_id, extended, name)` — the 29/11-bit
    /// arbitration id with the extended-id flag split out, plus the
    /// resolved message name. Borrowing and unsorted: a cheap identity
    /// sweep for callers that only need to know *which ids* a name can
    /// decode under (e.g. resolving a name filter to an id set before
    /// a bulk scan), without paying for full descriptors.
    pub fn message_names(&self) -> impl Iterator<Item = (u32, bool, &str)> + '_ {
        self.messages.iter().map(|(id, entry)| {
            let (message_id, extended) = message_id_parts(*id);
            (message_id, extended, entry.name.as_str())
        })
    }

    /// Every signal as `(message_id, extended, signal_name)`. The
    /// borrowing, unsorted counterpart of [`Database::signals`] for
    /// callers that only need the signal→message-id relation (e.g.
    /// resolving a signal filter to an id set before a bulk scan).
    pub fn signal_names(&self) -> impl Iterator<Item = (u32, bool, &str)> + '_ {
        self.messages.iter().flat_map(|(id, entry)| {
            let (message_id, extended) = message_id_parts(*id);
            entry
                .signals
                .iter()
                .map(move |s| (message_id, extended, s.signal.name.as_str()))
        })
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
                    transmitter: entry.transmitter.clone(),
                    signal_name: sig.signal.name.clone(),
                    unit: sig.signal.unit.clone(),
                    is_enum: is_enum(&sig.value_table),
                    value_is_raw_integer: value_is_raw_integer(sig),
                    mux_selector: match sig.signal.multiplexer_indicator {
                        MultiplexIndicator::MultiplexedSignal(s)
                        | MultiplexIndicator::MultiplexorAndMultiplexedSignal(s) => Some(s),
                        MultiplexIndicator::Plain | MultiplexIndicator::Multiplexor => None,
                    },
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
        let sig = entry
            .signals
            .iter()
            .find(|s| s.signal.name == signal_name)?;
        if sig.value_table.is_empty() {
            None
        } else {
            Some(&sig.value_table)
        }
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
                let mux = signal_mux_from_indicator(s.signal.multiplexer_indicator);
                uses_extended_mux |= matches!(mux, SignalMux::MultiplexorAndMultiplexed { .. });
                let float_kind = float_kind_from_extended(s.extended_type);
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
                    start_value_raw: s.start_value_raw,
                }
            })
            .collect();
        Some(MessageDescriptor {
            name: entry.name.clone(),
            expected_len: entry.expected_len,
            is_fd: entry.is_fd,
            brs: entry.brs,
            gen_msg_cycle_time_ms: entry.gen_msg_cycle_time_ms,
            gen_msg_send_type: entry.gen_msg_send_type.clone(),
            transmitter: entry.transmitter.clone(),
            uses_extended_mux,
            calc_fields: entry.calc_fields.clone(),
            signals,
        })
    }

    /// Tree-shaped snapshot of this database for the GUI's DBC panel
    /// (discovery surface). One entry per message, each
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
                let mut uses_extended_mux = false;
                let signals: Vec<DbcSignalContent> = entry
                    .signals
                    .iter()
                    .map(|s| {
                        let mux = signal_mux_from_indicator(s.signal.multiplexer_indicator);
                        uses_extended_mux |=
                            matches!(mux, SignalMux::MultiplexorAndMultiplexed { .. });
                        let float_kind = float_kind_from_extended(s.extended_type);
                        let byte_order = match s.signal.byte_order {
                            CanDbcByteOrder::LittleEndian => ByteOrder::Little,
                            CanDbcByteOrder::BigEndian => ByteOrder::Big,
                        };
                        DbcSignalContent {
                            name: s.signal.name.clone(),
                            unit: s.signal.unit.clone(),
                            comment: s.comment.clone(),
                            start_bit: u32::try_from(s.signal.start_bit).unwrap_or(0),
                            length: u32::try_from(s.signal.size).unwrap_or(0),
                            byte_order,
                            signed: s.signal.value_type == ValueType::Signed,
                            factor: s.signal.factor,
                            offset: s.signal.offset,
                            min: numeric_to_f64(s.signal.min),
                            max: numeric_to_f64(s.signal.max),
                            mux,
                            float_kind,
                            attributes: s.attributes.clone(),
                            value_table: s.value_table.clone(),
                        }
                    })
                    .collect();
                DbcMessageContent {
                    message_id,
                    extended,
                    name: entry.name.clone(),
                    comment: entry.comment.clone(),
                    expected_len: entry.expected_len,
                    is_fd: entry.is_fd,
                    brs: entry.brs,
                    uses_extended_mux,
                    attributes: entry.attributes.clone(),
                    transmitter: entry.transmitter.clone(),
                    signals,
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

/// A `(message, signal)` pair available for plotting / picking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalDescriptor {
    /// Raw CAN id of the owning message (29-bit if `extended`).
    pub message_id: u32,
    /// Whether `message_id` is a 29-bit extended id.
    pub extended: bool,
    pub message_name: String,
    /// The owning message's `BO_` transmitting node, or `None` for the
    /// `Vector__XXX` "no sender" placeholder. Lets a picker group its
    /// options per ECU without a second lookup.
    pub transmitter: Option<String>,
    pub signal_name: String,
    pub unit: String,
    /// True if the signal's `VAL_` table makes it an enum / state
    /// signal whose decoded value should be rendered symbolically —
    /// per [`is_enum`], the table needs at least two members. A
    /// single-member table (an SNA sentinel) leaves this false: the
    /// signal renders numerically, and the lone label only shows on
    /// an exact raw match. A picker / plotter can use this without a
    /// separate `value_table` round-trip to decide between numeric and
    /// symbolic rendering.
    pub is_enum: bool,
    /// True when the signal's physical value is exactly its raw integer
    /// — integer-typed (no `SIG_VALTYPE_` float override for its width),
    /// `factor == 1`, `offset == 0`. The catalog-side twin of
    /// [`DecodedSignal::value_is_raw_integer`], from the same internal
    /// predicate, so a view that has only a descriptor (the signal
    /// view's snapshot rows) classifies a signal the same way a decoded
    /// frame does. Combine with `unit` and `is_enum` through
    /// [`crate::is_raw_field`] for the "opaque bit pattern" verdict.
    ///
    /// [`DecodedSignal::value_is_raw_integer`]: crate::DecodedSignal::value_is_raw_integer
    pub value_is_raw_integer: bool,
    /// The multiplexor-selector group this signal belongs to, or `None`
    /// for plain signals and the multiplexor itself. A frame carries
    /// this signal only when the message's multiplexor decodes to this
    /// value ([`Database::decode_mux_selector`]) — latest-value queries
    /// must track "latest frame whose selector matched", not the
    /// message's latest frame.
    pub mux_selector: Option<u64>,
}

/// One DBC message as the GUI's DBC panel renders it: the
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
// `extended`, `is_fd`, `brs`, and `uses_extended_mux` are independent
// DBC-declared flags; collapsing them into an enum would erase the
// fact that each comes from a different DBC attribute.
#[allow(clippy::struct_excessive_bools)]
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
    /// Declared `BO_` payload length in bytes (`is_fd` is true for
    /// CAN-FD messages whose declared length exceeds 8).
    pub expected_len: usize,
    /// `true` if the DBC marks this as a CAN-FD message
    /// (`VFrameFormat` 14/15, or `expected_len > 8` as fallback).
    /// The discovery panel surfaces this as a small "FD" badge.
    pub is_fd: bool,
    /// CAN-FD BRS (Bit Rate Switch) from the `GenMsgCANFDBRS`
    /// attribute. Defaults to `true` for FD messages with no
    /// attribute; always `false` for classic messages.
    pub brs: bool,
    /// `true` if any signal in this message uses nested / extended
    /// multiplexing (`m<N>M`). The transmit panel falls back to
    /// bytes-only editing for messages with this flag; the
    /// discovery panel surfaces it as a hint next to the message id.
    pub uses_extended_mux: bool,
    /// `BA_ "<name>" BO_ <id> <value>` per-message attribute values
    /// (excluding the long-symbol attributes — see the rustdoc on
    /// [`Database::dbc_content`]). Sorted by attribute name.
    pub attributes: Vec<DbcAttribute>,
    /// The `BO_` line's transmitting node, or `None` for the
    /// `Vector__XXX` "no sender" placeholder. The discovery tree
    /// groups messages per ECU by this.
    pub transmitter: Option<String>,
    /// Signals in `SG_` declared order — the same order the DBC
    /// author wrote them, which matches their mental model of the
    /// message's bit layout.
    pub signals: Vec<DbcSignalContent>,
}

/// One signal inside a [`DbcMessageContent`] — the per-signal half
/// of the DBC discovery tree. Decoding / encoding still go through
/// [`Database::decode`] / [`Database::encode_frame`] / the rich
/// [`Database::describe_message`] view; this one is search-shaped.
///
/// Surfaces every per-signal field the DBC declares
/// so the discovery panel can show bit positions, scale, range, mux
/// indicator, float kind, and signedness alongside the comments /
/// attributes / value-table entries. The fields mirror
/// [`SignalDescriptorRich`] (which serves the encoder / transmit
/// path) plus the discovery-only extras.
#[derive(Debug, Clone, PartialEq)]
pub struct DbcSignalContent {
    /// Resolved name (long-symbol applied).
    pub name: String,
    /// Engineering unit from the `SG_` line. Empty when absent.
    pub unit: String,
    /// `CM_ SG_ <id> <name> "..."` comment. Empty when absent.
    pub comment: String,
    /// `SG_` start bit (the first bit of the signal within the
    /// payload). Combined with `length` and `byte_order` this fully
    /// places the signal.
    pub start_bit: u32,
    /// Signal width in bits, `1..=64`.
    pub length: u32,
    /// `little` (Intel / `@1`) vs `big` (Motorola / `@0`).
    pub byte_order: ByteOrder,
    /// `+` (`unsigned`) vs `-` (`signed`) on the `SG_` line.
    pub signed: bool,
    /// Multiplier applied during decode: `raw * factor + offset`.
    pub factor: f64,
    /// Offset applied during decode (see `factor`).
    pub offset: f64,
    /// `SG_` declared minimum (physical units). DBCs frequently
    /// declare `[0|0]` to mean "no constraint" — when `min == max`
    /// the panel should derive a fallback from `factor/offset`.
    pub min: f64,
    /// `SG_` declared maximum (physical units). See `min`.
    pub max: f64,
    /// Multiplexor / multiplexed-arm marker.
    pub mux: SignalMux,
    /// `integer` / `float32` / `float64` — from `SIG_VALTYPE_`.
    pub float_kind: FloatKind,
    /// `BA_ "<name>" SG_ <id> <name> <value>` attribute values.
    /// Sorted by attribute name.
    pub attributes: Vec<DbcAttribute>,
    /// `VAL_` table rows — same shape (and sort order) as
    /// [`Database::value_table_for_signal`]. Empty when the signal
    /// has no value table.
    pub value_table: Vec<ValueTableEntry>,
}

/// Byte order on the wire for a single signal — Intel (little-endian)
/// or Motorola (big-endian). Mirrors `can_dbc::ByteOrder` but lives
/// in this crate so the discovery API doesn't leak the parser type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByteOrder {
    Little,
    Big,
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
    /// The DBC's `GenMsgCycleTime` attribute in milliseconds (the
    /// message's intended cyclic send period), or `None` when absent.
    /// The transmit panel pre-fills a newly-added message's cycle
    /// period from this.
    pub gen_msg_cycle_time_ms: Option<u32>,
    /// The DBC's `GenMsgSendType` attribute resolved to its label
    /// (ENUM values mapped through the `BA_DEF_` label list, STRING
    /// values verbatim), or `None` when absent.
    pub gen_msg_send_type: Option<String>,
    /// The `BO_` line's transmitting node, or `None` for the
    /// `Vector__XXX` "no sender" placeholder.
    pub transmitter: Option<String>,
    /// `true` if any signal in this message is
    /// [`SignalMux::MultiplexorAndMultiplexed`] (a "sub-mux" /
    /// extended multiplexing arm). The transmit panel treats these as
    /// not-supported for signal-level editing.
    pub uses_extended_mux: bool,
    /// Calculated-field designation declared by the DBC's
    /// `CannetCounter` / `CannetCrc` attributes (ADR 0027) — the
    /// default layer overrides replace wholesale. Empty when the
    /// message declares none.
    pub calc_fields: CalculatedFieldsConfig,
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
    /// True if the signal has a non-empty `VAL_` table — "has
    /// labels", deliberately *not* [`is_enum`]: the transmit panel's
    /// value-label dropdown should offer even a single-member table's
    /// lone label. Enum-ness (>= 2 members) is a separate question,
    /// answered by [`SignalDescriptor::is_enum`] / [`is_enum`].
    pub has_value_table: bool,
    /// The DBC's `GenSigStartValue` attribute, verbatim — the
    /// signal's initial value in *raw* (pre-scale) units. Consumers
    /// reconstructing a default payload convert with
    /// `raw * factor + offset` before encoding. `None` when absent.
    pub start_value_raw: Option<f64>,
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
