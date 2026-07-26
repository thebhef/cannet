//! DBC database loading and runtime signal decoding.
//!
//! Parsing is delegated to the `can-dbc` crate, which produces an AST.
//! This crate builds an indexed, decode-friendly view on top of that AST
//! and runs the bit-extraction maths against `cannet_core::CanFrame` payloads.

mod bitwalk;
mod calc;
mod crc_named;
mod decode;
mod encode;
mod model;
mod parse;
mod view_builders;

pub use calc::{
    named_crc_algorithms, parse_counter_attribute, parse_crc_attribute, CalcFieldError,
    CalculatedFieldsConfig, CounterConfig, CrcAlgorithm, CrcConfig, FieldViolation,
    PayloadTooShort, RawCrcParams, ResolvedCalculatedFields, VerifyOutcome,
};
pub use decode::{decode_signal_bits, sign_extend, DecodedMessage, DecodedSignal};
pub use encode::{encode_signal_bits, EncodeReport, EncodedSignal, SkipReason, SkippedSignal};
pub use model::{is_enum, Database, DbcAttribute, ValueTableEntry};
pub use parse::DbcError;
pub use view_builders::{
    ByteOrder, DbcMessageContent, DbcSignalContent, FloatKind, MessageDescriptor, SignalDescriptor,
    SignalDescriptorRich, SignalMux,
};

#[cfg(test)]
mod tests;
