//! BLF capture-integrity / diagnostic objects.
//!
//! Tranche 4 covers:
//!
//! - `CAN_STATISTIC` (type 4) — periodic CAN driver statistics
//!   (bus load, per-channel frame counts). Vector tools emit these
//!   roughly once a second; reading them back lets cannet surface
//!   bus-load info on third-party captures.
//! - `DATA_LOST_BEGIN` (type 125) — sentinel marking the start of
//!   a region where the recorder dropped frames (the input queue
//!   leaked).
//! - `DATA_LOST_END` (type 126) — paired sentinel marking the end
//!   of the lost-data region, with the timestamp of the first
//!   lost object and a count of how many were dropped.
//!
//! All three share the same outer framing as the CAN-class events
//! (32-byte base + `ObjectHeader` v1) with a fixed-size body.

use super::object::{
    object_type, ObjectHeaderBase, ObjectHeaderError, ObjectHeaderV1, OBJECT_FLAG_TIME_ONE_NANS,
    OBJECT_HEADER_BASE_BYTES, OBJECT_HEADER_V1_BYTES,
};

/// Width of the per-event header (base + v1) that prefixes the
/// three diagnostic types: 32 bytes.
pub const DIAG_EVENT_HEADER_BYTES: usize = OBJECT_HEADER_BASE_BYTES + OBJECT_HEADER_V1_BYTES;

/// Fixed body size of `CAN_STATISTIC`: channel(2) + busLoad(2) +
/// 6 × u32 counters + reserved(4) = 32 bytes.
pub const CAN_STATISTIC_BODY_BYTES: usize = 32;

/// Fixed body size of `DATA_LOST_BEGIN`: `queue_identifier` (4).
pub const DATA_LOST_BEGIN_BODY_BYTES: usize = 4;

/// Fixed body size of `DATA_LOST_END`: `queue_identifier` (4) +
/// `first_object_lost_timestamp` (8) + `number_of_lost_events` (4).
pub const DATA_LOST_END_BODY_BYTES: usize = 16;

/// `queue_identifier` enumerand: real-time queue.
pub const QUEUE_RT: u32 = 0;
/// `queue_identifier` enumerand: analyser queue.
pub const QUEUE_ANALYZER: u32 = 1;
/// `queue_identifier` enumerand: both real-time and analyser queues.
pub const QUEUE_RT_AND_ANALYZER: u32 = 2;

/// Errors specific to the diagnostic decoders.
#[derive(Debug)]
pub enum DiagnosticError {
    /// The object's `ObjectHeaderBase.object_type` didn't match
    /// the type the decoder was asked for. Carries `(expected, got)`.
    WrongObjectType(u32, u32),
    /// `ObjectHeaderBase` parse failed.
    BaseHeader(ObjectHeaderError),
    /// `ObjectHeader` v1 parse failed.
    EventHeader(ObjectHeaderError),
    /// `object_size` was smaller than the per-type minimum.
    /// Carries `(object_size, required)`.
    TooSmall(u32, usize),
    /// Buffer length was less than `object_size`.
    Truncated(usize, u32),
}

impl std::fmt::Display for DiagnosticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongObjectType(expected, got) => write!(
                f,
                "expected diagnostic object_type={expected}, got object_type={got}",
            ),
            Self::BaseHeader(e) => write!(f, "diagnostic base header invalid: {e}"),
            Self::EventHeader(e) => write!(f, "diagnostic event header invalid: {e}"),
            Self::TooSmall(got, required) => write!(
                f,
                "diagnostic object_size={got} below required {required} bytes",
            ),
            Self::Truncated(got, required) => write!(
                f,
                "diagnostic buffer = {got} bytes, object_size declares {required}",
            ),
        }
    }
}

impl std::error::Error for DiagnosticError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::BaseHeader(e) | Self::EventHeader(e) => Some(e),
            _ => None,
        }
    }
}

// =================================================================
// CAN_STATISTIC (object type 4)
// =================================================================

/// Decoded `CAN_STATISTIC`. Per-channel frame counters Vector
/// drivers emit roughly once a second.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanStatistic {
    pub base: ObjectHeaderBase,
    pub event: ObjectHeaderV1,
    pub channel: u16,
    /// CAN bus load in 1/100 percent (`100` = 1.00 %).
    pub bus_load: u16,
    pub standard_data_frames: u32,
    pub extended_data_frames: u32,
    pub standard_remote_frames: u32,
    pub extended_remote_frames: u32,
    pub error_frames: u32,
    pub overload_frames: u32,
}

impl CanStatistic {
    /// `bus_load` expressed as a `f32` percentage (0.0 – 100.0).
    pub fn bus_load_percent(&self) -> f32 {
        f32::from(self.bus_load) / 100.0
    }
}

/// Decode one `CAN_STATISTIC`.
// `try_into().unwrap()` is unreachable: every slice is length-checked.
#[allow(clippy::missing_panics_doc)]
pub fn decode_can_statistic(object_bytes: &[u8]) -> Result<CanStatistic, DiagnosticError> {
    let base = ObjectHeaderBase::parse(object_bytes).map_err(DiagnosticError::BaseHeader)?;
    if base.object_type != object_type::CAN_STATISTIC {
        return Err(DiagnosticError::WrongObjectType(
            object_type::CAN_STATISTIC,
            base.object_type,
        ));
    }
    let required = DIAG_EVENT_HEADER_BYTES + CAN_STATISTIC_BODY_BYTES;
    if (base.object_size as usize) < required {
        return Err(DiagnosticError::TooSmall(base.object_size, required));
    }
    if object_bytes.len() < base.object_size as usize {
        return Err(DiagnosticError::Truncated(
            object_bytes.len(),
            base.object_size,
        ));
    }
    let event = ObjectHeaderV1::parse(
        &object_bytes[OBJECT_HEADER_BASE_BYTES..OBJECT_HEADER_BASE_BYTES + OBJECT_HEADER_V1_BYTES],
    )
    .map_err(DiagnosticError::EventHeader)?;
    let body = &object_bytes[DIAG_EVENT_HEADER_BYTES..DIAG_EVENT_HEADER_BYTES + CAN_STATISTIC_BODY_BYTES];
    Ok(CanStatistic {
        base,
        event,
        channel: u16::from_le_bytes(body[0..2].try_into().unwrap()),
        bus_load: u16::from_le_bytes(body[2..4].try_into().unwrap()),
        standard_data_frames: u32::from_le_bytes(body[4..8].try_into().unwrap()),
        extended_data_frames: u32::from_le_bytes(body[8..12].try_into().unwrap()),
        standard_remote_frames: u32::from_le_bytes(body[12..16].try_into().unwrap()),
        extended_remote_frames: u32::from_le_bytes(body[16..20].try_into().unwrap()),
        error_frames: u32::from_le_bytes(body[20..24].try_into().unwrap()),
        overload_frames: u32::from_le_bytes(body[24..28].try_into().unwrap()),
        // body[28..32] = reservedCanDriverStatistic
    })
}

/// Convenience constructor: build a `CAN_STATISTIC` from the
/// commonly-set fields. Reserved field is zeroed.
// `expect` is unreachable: the fixed object_size of 64 fits in u32.
#[allow(clippy::missing_panics_doc)]
#[must_use]
pub fn build_can_statistic(
    timestamp_ns: u64,
    channel: u16,
    bus_load_hundredths_percent: u16,
) -> CanStatistic {
    CanStatistic {
        base: ObjectHeaderBase {
            header_size: 32,
            header_version: 1,
            object_size: u32::try_from(DIAG_EVENT_HEADER_BYTES + CAN_STATISTIC_BODY_BYTES)
                .expect("CAN_STATISTIC object_size is 64 — fits in u32"),
            object_type: object_type::CAN_STATISTIC,
        },
        event: ObjectHeaderV1 {
            object_flags: OBJECT_FLAG_TIME_ONE_NANS,
            client_index: 0,
            object_version: 0,
            object_timestamp: timestamp_ns,
        },
        channel,
        bus_load: bus_load_hundredths_percent,
        standard_data_frames: 0,
        extended_data_frames: 0,
        standard_remote_frames: 0,
        extended_remote_frames: 0,
        error_frames: 0,
        overload_frames: 0,
    }
}

/// Encode a `CAN_STATISTIC` to its on-disk bytes.
#[must_use]
pub fn encode_can_statistic(s: &CanStatistic) -> Vec<u8> {
    let mut out = Vec::with_capacity(DIAG_EVENT_HEADER_BYTES + CAN_STATISTIC_BODY_BYTES);
    out.extend_from_slice(&s.base.encode());
    out.extend_from_slice(&s.event.encode());
    out.extend_from_slice(&s.channel.to_le_bytes());
    out.extend_from_slice(&s.bus_load.to_le_bytes());
    out.extend_from_slice(&s.standard_data_frames.to_le_bytes());
    out.extend_from_slice(&s.extended_data_frames.to_le_bytes());
    out.extend_from_slice(&s.standard_remote_frames.to_le_bytes());
    out.extend_from_slice(&s.extended_remote_frames.to_le_bytes());
    out.extend_from_slice(&s.error_frames.to_le_bytes());
    out.extend_from_slice(&s.overload_frames.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved
    out
}

// =================================================================
// DATA_LOST_BEGIN (object type 125)
// =================================================================

/// Decoded `DATA_LOST_BEGIN`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataLostBegin {
    pub base: ObjectHeaderBase,
    pub event: ObjectHeaderV1,
    /// One of [`QUEUE_RT`] / [`QUEUE_ANALYZER`] / [`QUEUE_RT_AND_ANALYZER`].
    pub queue_identifier: u32,
}

/// Decode one `DATA_LOST_BEGIN`.
// `try_into().unwrap()` is unreachable: every slice is length-checked.
#[allow(clippy::missing_panics_doc)]
pub fn decode_data_lost_begin(object_bytes: &[u8]) -> Result<DataLostBegin, DiagnosticError> {
    let base = ObjectHeaderBase::parse(object_bytes).map_err(DiagnosticError::BaseHeader)?;
    if base.object_type != object_type::DATA_LOST_BEGIN {
        return Err(DiagnosticError::WrongObjectType(
            object_type::DATA_LOST_BEGIN,
            base.object_type,
        ));
    }
    let required = DIAG_EVENT_HEADER_BYTES + DATA_LOST_BEGIN_BODY_BYTES;
    if (base.object_size as usize) < required {
        return Err(DiagnosticError::TooSmall(base.object_size, required));
    }
    if object_bytes.len() < base.object_size as usize {
        return Err(DiagnosticError::Truncated(
            object_bytes.len(),
            base.object_size,
        ));
    }
    let event = ObjectHeaderV1::parse(
        &object_bytes[OBJECT_HEADER_BASE_BYTES..OBJECT_HEADER_BASE_BYTES + OBJECT_HEADER_V1_BYTES],
    )
    .map_err(DiagnosticError::EventHeader)?;
    let body = &object_bytes[DIAG_EVENT_HEADER_BYTES..DIAG_EVENT_HEADER_BYTES + DATA_LOST_BEGIN_BODY_BYTES];
    Ok(DataLostBegin {
        base,
        event,
        queue_identifier: u32::from_le_bytes(body[0..4].try_into().unwrap()),
    })
}

/// Convenience constructor.
// `expect` is unreachable: the fixed object_size of 36 fits in u32.
#[allow(clippy::missing_panics_doc)]
#[must_use]
pub fn build_data_lost_begin(timestamp_ns: u64, queue_identifier: u32) -> DataLostBegin {
    DataLostBegin {
        base: ObjectHeaderBase {
            header_size: 32,
            header_version: 1,
            object_size: u32::try_from(DIAG_EVENT_HEADER_BYTES + DATA_LOST_BEGIN_BODY_BYTES)
                .expect("DATA_LOST_BEGIN object_size is 36 — fits in u32"),
            object_type: object_type::DATA_LOST_BEGIN,
        },
        event: ObjectHeaderV1 {
            object_flags: OBJECT_FLAG_TIME_ONE_NANS,
            client_index: 0,
            object_version: 0,
            object_timestamp: timestamp_ns,
        },
        queue_identifier,
    }
}

/// Encode a `DATA_LOST_BEGIN` to its on-disk bytes.
#[must_use]
pub fn encode_data_lost_begin(b: &DataLostBegin) -> Vec<u8> {
    let mut out = Vec::with_capacity(DIAG_EVENT_HEADER_BYTES + DATA_LOST_BEGIN_BODY_BYTES);
    out.extend_from_slice(&b.base.encode());
    out.extend_from_slice(&b.event.encode());
    out.extend_from_slice(&b.queue_identifier.to_le_bytes());
    out
}

// =================================================================
// DATA_LOST_END (object type 126)
// =================================================================

/// Decoded `DATA_LOST_END`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataLostEnd {
    pub base: ObjectHeaderBase,
    pub event: ObjectHeaderV1,
    pub queue_identifier: u32,
    /// Timestamp of the first object lost (ns since file start —
    /// in the same relative units as every other event's
    /// `object_timestamp`).
    pub first_object_lost_timestamp_ns: u64,
    pub number_of_lost_events: u32,
}

/// Decode one `DATA_LOST_END`.
// `try_into().unwrap()` is unreachable: every slice is length-checked.
#[allow(clippy::missing_panics_doc)]
pub fn decode_data_lost_end(object_bytes: &[u8]) -> Result<DataLostEnd, DiagnosticError> {
    let base = ObjectHeaderBase::parse(object_bytes).map_err(DiagnosticError::BaseHeader)?;
    if base.object_type != object_type::DATA_LOST_END {
        return Err(DiagnosticError::WrongObjectType(
            object_type::DATA_LOST_END,
            base.object_type,
        ));
    }
    let required = DIAG_EVENT_HEADER_BYTES + DATA_LOST_END_BODY_BYTES;
    if (base.object_size as usize) < required {
        return Err(DiagnosticError::TooSmall(base.object_size, required));
    }
    if object_bytes.len() < base.object_size as usize {
        return Err(DiagnosticError::Truncated(
            object_bytes.len(),
            base.object_size,
        ));
    }
    let event = ObjectHeaderV1::parse(
        &object_bytes[OBJECT_HEADER_BASE_BYTES..OBJECT_HEADER_BASE_BYTES + OBJECT_HEADER_V1_BYTES],
    )
    .map_err(DiagnosticError::EventHeader)?;
    let body = &object_bytes[DIAG_EVENT_HEADER_BYTES..DIAG_EVENT_HEADER_BYTES + DATA_LOST_END_BODY_BYTES];
    Ok(DataLostEnd {
        base,
        event,
        queue_identifier: u32::from_le_bytes(body[0..4].try_into().unwrap()),
        first_object_lost_timestamp_ns: u64::from_le_bytes(body[4..12].try_into().unwrap()),
        number_of_lost_events: u32::from_le_bytes(body[12..16].try_into().unwrap()),
    })
}

/// Convenience constructor.
// `expect` is unreachable: the fixed object_size of 48 fits in u32.
#[allow(clippy::missing_panics_doc)]
#[must_use]
pub fn build_data_lost_end(
    timestamp_ns: u64,
    queue_identifier: u32,
    first_object_lost_timestamp_ns: u64,
    number_of_lost_events: u32,
) -> DataLostEnd {
    DataLostEnd {
        base: ObjectHeaderBase {
            header_size: 32,
            header_version: 1,
            object_size: u32::try_from(DIAG_EVENT_HEADER_BYTES + DATA_LOST_END_BODY_BYTES)
                .expect("DATA_LOST_END object_size is 48 — fits in u32"),
            object_type: object_type::DATA_LOST_END,
        },
        event: ObjectHeaderV1 {
            object_flags: OBJECT_FLAG_TIME_ONE_NANS,
            client_index: 0,
            object_version: 0,
            object_timestamp: timestamp_ns,
        },
        queue_identifier,
        first_object_lost_timestamp_ns,
        number_of_lost_events,
    }
}

/// Encode a `DATA_LOST_END` to its on-disk bytes.
#[must_use]
pub fn encode_data_lost_end(e: &DataLostEnd) -> Vec<u8> {
    let mut out = Vec::with_capacity(DIAG_EVENT_HEADER_BYTES + DATA_LOST_END_BODY_BYTES);
    out.extend_from_slice(&e.base.encode());
    out.extend_from_slice(&e.event.encode());
    out.extend_from_slice(&e.queue_identifier.to_le_bytes());
    out.extend_from_slice(&e.first_object_lost_timestamp_ns.to_le_bytes());
    out.extend_from_slice(&e.number_of_lost_events.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::reader::{BlfObject, BlfReader};
    use crate::format::writer::BlfFileWriter;

    // ----- CAN_STATISTIC ----------------------------------------

    #[test]
    fn can_statistic_round_trips() {
        let mut s = build_can_statistic(/*ts*/ 12_345_678, /*channel*/ 1, /*busload*/ 1_234);
        s.standard_data_frames = 100;
        s.extended_data_frames = 25;
        s.standard_remote_frames = 3;
        s.extended_remote_frames = 1;
        s.error_frames = 2;
        s.overload_frames = 0;

        let bytes = encode_can_statistic(&s);
        let parsed = decode_can_statistic(&bytes).unwrap();
        assert_eq!(parsed, s);
        // 1234 hundredths = 12.34 %
        assert!((parsed.bus_load_percent() - 12.34).abs() < 1e-3);
    }

    #[test]
    fn can_statistic_rejects_wrong_object_type() {
        let s = build_can_statistic(0, 0, 0);
        let mut bytes = encode_can_statistic(&s);
        bytes[12..16].copy_from_slice(&object_type::CAN_MESSAGE2.to_le_bytes());
        let err = decode_can_statistic(&bytes).unwrap_err();
        assert!(matches!(
            err,
            DiagnosticError::WrongObjectType(expected, _) if expected == object_type::CAN_STATISTIC,
        ));
    }

    // ----- DATA_LOST_BEGIN / DATA_LOST_END ----------------------

    #[test]
    fn data_lost_begin_round_trips() {
        let b = build_data_lost_begin(1_000_000, QUEUE_RT_AND_ANALYZER);
        let bytes = encode_data_lost_begin(&b);
        let parsed = decode_data_lost_begin(&bytes).unwrap();
        assert_eq!(parsed, b);
    }

    #[test]
    fn data_lost_end_round_trips() {
        let e = build_data_lost_end(
            2_000_000,
            QUEUE_RT,
            1_500_000, // first lost at +1.5 ms
            42,
        );
        let bytes = encode_data_lost_end(&e);
        let parsed = decode_data_lost_end(&bytes).unwrap();
        assert_eq!(parsed, e);
        assert_eq!(parsed.number_of_lost_events, 42);
    }

    #[test]
    fn data_lost_begin_rejects_wrong_object_type() {
        let b = build_data_lost_begin(0, 0);
        let mut bytes = encode_data_lost_begin(&b);
        bytes[12..16].copy_from_slice(&object_type::DATA_LOST_END.to_le_bytes());
        let err = decode_data_lost_begin(&bytes).unwrap_err();
        assert!(matches!(
            err,
            DiagnosticError::WrongObjectType(expected, _) if expected == object_type::DATA_LOST_BEGIN,
        ));
    }

    // ----- End-to-end through BlfFileWriter + BlfReader ---------

    /// Write a statistic + a data-lost pair, read them back via
    /// the streaming reader, and confirm both are surfaced as the
    /// right `BlfObject` variants.
    #[test]
    fn round_trips_all_three_through_native_writer_and_reader() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diag.blf");
        let mut writer = BlfFileWriter::create(&path).unwrap();

        let base_abs = 1_700_000_000_u64 * 1_000_000_000;
        let start = writer.set_start_if_unset((base_abs / 1_000_000) * 1_000_000);

        // 1) CAN_STATISTIC at t=0
        let mut statistic = build_can_statistic(base_abs - start, 1, 2_500); // 25.00 %
        statistic.standard_data_frames = 500;
        let stat_bytes = encode_can_statistic(&statistic);
        writer.append_object(&stat_bytes, base_abs).unwrap();

        // 2) DATA_LOST_BEGIN at t=+10ms
        let begin_ns = base_abs + 10_000_000;
        let begin = build_data_lost_begin(begin_ns - start, QUEUE_RT);
        writer
            .append_object(&encode_data_lost_begin(&begin), begin_ns)
            .unwrap();

        // 3) DATA_LOST_END at t=+20ms — 100 events lost, first at +12ms
        let end_ns = base_abs + 20_000_000;
        let end = build_data_lost_end(
            end_ns - start,
            QUEUE_RT,
            (base_abs + 12_000_000) - start,
            100,
        );
        writer
            .append_object(&encode_data_lost_end(&end), end_ns)
            .unwrap();

        writer.finish().unwrap();

        let mut reader = BlfReader::open(&path).unwrap();
        let mut saw_stat = false;
        let mut saw_begin = false;
        let mut saw_end = false;
        while let Some(obj) = reader.next_object().unwrap() {
            match obj {
                BlfObject::CanStatistic(s) => {
                    assert_eq!(s.channel, 1);
                    assert_eq!(s.bus_load, 2_500);
                    assert_eq!(s.standard_data_frames, 500);
                    saw_stat = true;
                }
                BlfObject::DataLostBegin(b) => {
                    assert_eq!(b.queue_identifier, QUEUE_RT);
                    saw_begin = true;
                }
                BlfObject::DataLostEnd(e) => {
                    assert_eq!(e.queue_identifier, QUEUE_RT);
                    assert_eq!(e.number_of_lost_events, 100);
                    saw_end = true;
                }
                _ => {}
            }
        }
        assert!(saw_stat, "expected CAN_STATISTIC");
        assert!(saw_begin, "expected DATA_LOST_BEGIN");
        assert!(saw_end, "expected DATA_LOST_END");
    }
}
