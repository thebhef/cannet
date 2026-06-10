//! Calculated fields: sequence counters and CRCs recomputed on every
//! send (ADR 0027).
//!
//! A **calculated field** is a signal on a transmitted message whose
//! value the host recomputes each time the message is sent: a
//! **sequence counter** (incrementing value with a rollover) or a
//! **CRC** (computed over a stated byte range of the just-encoded
//! payload, optionally prefixed — the AUTOSAR E2E Data ID case).
//!
//! The flow is two-phase:
//!
//! 1. **Resolve** a [`CalculatedFieldsConfig`] against the database
//!    once, at registration time
//!    ([`crate::Database::resolve_calculated_fields`]) — destination
//!    signals become bit placements, the CRC algorithm becomes a
//!    table-driven engine, and every config error
//!    ([`CalcFieldError`]) is caught here, so the fire path does no
//!    DBC lookups and cannot fail on config.
//! 2. **Apply** ([`ResolvedCalculatedFields::apply`]) on each send:
//!    counter step → CRC over the *updated* buffer → both
//!    partial-encoded into the payload. Or **verify**
//!    ([`ResolvedCalculatedFields::verify`]) on each received frame.
//!
//! The CRC computation is the `crc` crate's (with `crc-catalog`'s
//! named-algorithm list — see `plans/technology-inventory.md`); this
//! module owns the bit placement and range/overlap semantics.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use can_dbc::ByteOrder;
use crc::{Algorithm, Crc};

use crate::crc_named;
use crate::{decode_signal_bits, encode_signal_bits};

/// Sequence-counter designation: the destination `signal` plus the
/// step parameters. `increment` defaults to 1 and `rollover` to
/// `2^bit_length − 1` (wrap at the signal's width) when `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CounterConfig {
    /// Destination signal name on the message.
    pub signal: String,
    /// Added on each send. Must be ≥ 1.
    pub increment: u64,
    /// The counter runs `0..=rollover`. `None` → `2^bit_length − 1`.
    pub rollover: Option<u64>,
}

impl CounterConfig {
    /// A counter on `signal` with the defaults (`increment` 1,
    /// rollover at the signal's width).
    #[must_use]
    pub fn new(signal: impl Into<String>) -> Self {
        Self {
            signal: signal.into(),
            increment: 1,
            rollover: None,
        }
    }
}

/// CRC designation: the destination `signal`, the algorithm, the
/// payload range it's computed over, and an optional prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrcConfig {
    /// Destination signal name on the message.
    pub signal: String,
    pub algorithm: CrcAlgorithm,
    /// `[start, length]` of the covered payload range, in bits.
    /// Byte-aligned ranges only for now (a config error otherwise);
    /// the bits unit keeps configs forward-compatible.
    pub range_bits: (u32, u32),
    /// Bytes prepended to the ranged data before computation — how an
    /// AUTOSAR E2E Data ID (in the CRC but not in the frame) is
    /// expressed. Empty for none.
    pub prefix: Vec<u8>,
}

/// Either a named `crc-catalog` algorithm or explicit Rocksoft
/// parameters — exactly one of the two (enforced by the enum).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CrcAlgorithm {
    /// A catalogue name, e.g. `CRC-8/SAE-J1850`. The available list is
    /// [`named_crc_algorithms`].
    Named(String),
    Raw(RawCrcParams),
}

/// Explicit Rocksoft CRC parameters for algorithms not in the
/// catalogue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RawCrcParams {
    /// Register width in bits, `1..=64`.
    pub width: u8,
    pub poly: u64,
    pub init: u64,
    pub refin: bool,
    pub refout: bool,
    pub xorout: u64,
}

/// Per-message calculated-field designation: at most one counter and
/// one CRC.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CalculatedFieldsConfig {
    pub counter: Option<CounterConfig>,
    pub crc: Option<CrcConfig>,
}

impl CalculatedFieldsConfig {
    /// True when neither field is configured.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.counter.is_none() && self.crc.is_none()
    }
}

/// The names of every available catalogue algorithm, in catalogue
/// order — what a GUI algorithm picker lists.
#[must_use]
pub fn named_crc_algorithms() -> Vec<&'static str> {
    crc_named::named_algorithms()
        .iter()
        .map(|(n, _)| *n)
        .collect()
}

/// Why a [`CalculatedFieldsConfig`] failed to resolve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CalcFieldError {
    /// No message in the database matches the addressed id.
    MessageNotFound,
    /// No signal with this name on the message.
    SignalNotFound(String),
    /// The destination signal's declared layout can't be encoded
    /// (size outside `1..=64`).
    UnusableSignalLayout(String),
    /// `increment` is 0 — the counter would never advance.
    ZeroIncrement,
    /// `rollover` is 0 — the counter would be constant.
    ZeroRollover,
    /// `rollover` doesn't fit the destination signal's bit width.
    RolloverTooLarge { rollover: u64, max: u64 },
    /// No catalogue algorithm with this name.
    UnknownAlgorithm(String),
    /// Raw parameter width outside `1..=64`.
    UnusableAlgorithmWidth(u8),
    /// The algorithm's width exceeds the destination signal's size.
    AlgorithmWiderThanSignal { width: u8, signal_bits: u32 },
    /// The CRC range isn't byte-aligned (start and length must both be
    /// multiples of 8, length non-zero).
    RangeNotByteAligned { start: u32, length: u32 },
    /// The CRC range runs past the message's declared payload length.
    RangeOutOfBounds { end_bit: u32, payload_bits: u32 },
    /// The CRC range covers (part of) the CRC's own destination
    /// signal — a circular definition.
    RangeOverlapsDestination,
}

impl std::fmt::Display for CalcFieldError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MessageNotFound => write!(f, "no DBC message matches the id"),
            Self::SignalNotFound(name) => write!(f, "no signal named {name} on the message"),
            Self::UnusableSignalLayout(name) => {
                write!(f, "signal {name} has an unencodable bit layout")
            }
            Self::ZeroIncrement => write!(f, "counter increment must be at least 1"),
            Self::ZeroRollover => write!(f, "counter rollover must be at least 1"),
            Self::RolloverTooLarge { rollover, max } => {
                write!(f, "rollover {rollover} exceeds the signal's maximum {max}")
            }
            Self::UnknownAlgorithm(name) => write!(f, "unknown CRC algorithm {name}"),
            Self::UnusableAlgorithmWidth(w) => {
                write!(f, "CRC width {w} is outside the supported 1..=64")
            }
            Self::AlgorithmWiderThanSignal { width, signal_bits } => write!(
                f,
                "CRC width {width} exceeds the destination signal's {signal_bits} bits"
            ),
            Self::RangeNotByteAligned { start, length } => write!(
                f,
                "CRC range {start}:{length} is not byte-aligned (start and length must be multiples of 8)"
            ),
            Self::RangeOutOfBounds { end_bit, payload_bits } => write!(
                f,
                "CRC range ends at bit {end_bit} but the payload is {payload_bits} bits"
            ),
            Self::RangeOverlapsDestination => {
                write!(f, "CRC range covers the CRC's own destination signal")
            }
        }
    }
}

impl std::error::Error for CalcFieldError {}

/// A destination signal's bit placement, captured at resolution time
/// so the fire path does no DBC lookups.
#[derive(Debug, Clone, Copy)]
struct Placement {
    start_bit: usize,
    size: usize,
    byte_order: ByteOrder,
}

impl Placement {
    /// The payload byte indices this signal's bits touch, following
    /// the same walk the decoder takes. Used for the range-overlap
    /// check (the CRC range is byte-aligned, so byte granularity is
    /// exact).
    fn occupied_bytes(self) -> Vec<usize> {
        let mut bytes = Vec::new();
        match self.byte_order {
            ByteOrder::LittleEndian => {
                for bit in self.start_bit..self.start_bit + self.size {
                    let b = bit / 8;
                    if bytes.last() != Some(&b) {
                        bytes.push(b);
                    }
                }
            }
            ByteOrder::BigEndian => {
                // Motorola walk: down within the byte, then to the MSB
                // of the next byte (mirrors `encode_signal_bits`).
                let mut bit = self.start_bit;
                for _ in 0..self.size {
                    let b = bit / 8;
                    if bytes.last() != Some(&b) {
                        bytes.push(b);
                    }
                    let bit_in_byte = bit % 8;
                    if bit_in_byte == 0 {
                        bit += 15;
                    } else {
                        bit -= 1;
                    }
                }
            }
        }
        bytes
    }
}

/// A resolved counter: placement plus step parameters.
#[derive(Debug, Clone)]
pub struct ResolvedCounter {
    placement: Placement,
    increment: u64,
    rollover: u64,
}

impl ResolvedCounter {
    /// `(current + increment) mod (rollover + 1)`.
    fn step(&self, current: u64) -> u64 {
        match self.rollover.checked_add(1) {
            Some(modulus) => (current % modulus).wrapping_add(self.increment % modulus) % modulus,
            // rollover == u64::MAX: the modulus is 2^64, i.e. native
            // wrapping arithmetic.
            None => current.wrapping_add(self.increment),
        }
    }
}

/// A resolved CRC: placement, a ready-built table-driven engine, the
/// byte range, and the prefix.
#[derive(Clone)]
pub struct ResolvedCrc {
    placement: Placement,
    engine: Crc<u64>,
    range_bytes: std::ops::Range<usize>,
    prefix: Vec<u8>,
}

impl std::fmt::Debug for ResolvedCrc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedCrc")
            .field("placement", &self.placement)
            .field("width", &self.engine.algorithm.width)
            .field("range_bytes", &self.range_bytes)
            .field("prefix", &self.prefix)
            .finish()
    }
}

impl ResolvedCrc {
    /// CRC over `prefix ++ payload[range]`, or `None` if the payload
    /// is shorter than the range.
    fn compute(&self, payload: &[u8]) -> Option<u64> {
        let ranged = payload.get(self.range_bytes.clone())?;
        let mut digest = self.engine.digest();
        digest.update(&self.prefix);
        digest.update(ranged);
        Some(digest.finalize())
    }
}

/// A [`CalculatedFieldsConfig`] resolved against a message: every
/// destination is a bit placement and the CRC engine is built. Apply
/// it in a transmit fire path ([`Self::apply`]) or against received
/// payloads ([`Self::verify`]).
#[derive(Debug, Clone, Default)]
pub struct ResolvedCalculatedFields {
    counter: Option<ResolvedCounter>,
    crc: Option<ResolvedCrc>,
}

/// Why [`ResolvedCalculatedFields::apply`] failed: the live payload
/// buffer is too short for the resolved placement / range (the config
/// was validated against the DBC's declared length, but the buffer is
/// the caller's).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PayloadTooShort;

impl std::fmt::Display for PayloadTooShort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "payload too short for the configured calculated fields")
    }
}

impl std::error::Error for PayloadTooShort {}

/// One verification finding on a received frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldViolation {
    /// The received CRC doesn't match the recomputed one.
    CrcMismatch { expected: u64, found: u64 },
    /// The received counter isn't `prev + increment (mod rollover+1)`.
    CounterSkip { expected: u64, found: u64 },
    /// The payload is too short to carry a configured field at all.
    Truncated,
}

/// Result of verifying one received payload: the findings plus the
/// observed counter value (the caller carries it to the next frame of
/// this `(bus, id)` — including after a skip, so one drop logs one
/// violation rather than cascading).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyOutcome {
    pub violations: Vec<FieldViolation>,
    pub counter: Option<u64>,
}

impl ResolvedCalculatedFields {
    /// True when neither field resolved (an empty config).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.counter.is_none() && self.crc.is_none()
    }

    /// The fire-path application (ADR 0027): step the counter and
    /// partial-encode it, then compute the CRC over the *updated*
    /// buffer (a range covering the counter sees the new value) and
    /// partial-encode that. `counter` is the runtime state the caller
    /// owns — seed it 0 when the owner starts transmitting.
    pub fn apply(&self, counter: &mut u64, payload: &mut [u8]) -> Result<(), PayloadTooShort> {
        if let Some(c) = &self.counter {
            let next = c.step(*counter);
            encode_signal_bits(
                payload,
                c.placement.start_bit,
                c.placement.size,
                next,
                c.placement.byte_order,
            )
            .ok_or(PayloadTooShort)?;
            *counter = next;
        }
        if let Some(c) = &self.crc {
            let value = c.compute(payload).ok_or(PayloadTooShort)?;
            encode_signal_bits(
                payload,
                c.placement.start_bit,
                c.placement.size,
                value,
                c.placement.byte_order,
            )
            .ok_or(PayloadTooShort)?;
        }
        Ok(())
    }

    /// Verify one received payload. CRC verification is stateless;
    /// counter verification compares against `prev_counter` (the
    /// value observed on the previous frame of this `(bus, id)`) —
    /// `None` (first sighting) seeds without a finding.
    #[must_use]
    pub fn verify(&self, payload: &[u8], prev_counter: Option<u64>) -> VerifyOutcome {
        let mut violations = Vec::new();
        let mut counter = None;
        if let Some(c) = &self.counter {
            match decode_signal_bits(
                payload,
                c.placement.start_bit,
                c.placement.size,
                c.placement.byte_order,
            ) {
                Some(found) => {
                    counter = Some(found);
                    if let Some(prev) = prev_counter {
                        let expected = c.step(prev);
                        if found != expected {
                            violations.push(FieldViolation::CounterSkip { expected, found });
                        }
                    }
                }
                None => violations.push(FieldViolation::Truncated),
            }
        }
        if let Some(c) = &self.crc {
            let recomputed = c.compute(payload);
            let found = decode_signal_bits(
                payload,
                c.placement.start_bit,
                c.placement.size,
                c.placement.byte_order,
            );
            match (recomputed, found) {
                (Some(expected), Some(found)) => {
                    if expected != found {
                        violations.push(FieldViolation::CrcMismatch { expected, found });
                    }
                }
                _ => violations.push(FieldViolation::Truncated),
            }
        }
        VerifyOutcome { violations, counter }
    }
}

/// Intern a raw parameter set as a `&'static Algorithm<u64>` (the
/// `crc` crate's constructors require `'static`). Each *distinct*
/// parameter set is leaked exactly once and reused thereafter, so
/// memory growth is bounded by the number of distinct raw CRCs ever
/// configured in the session — a handful in practice.
fn raw_algorithm(params: RawCrcParams) -> &'static Algorithm<u64> {
    static CACHE: OnceLock<Mutex<HashMap<RawCrcParams, &'static Algorithm<u64>>>> =
        OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("raw CRC algorithm cache poisoned");
    cache.entry(params).or_insert_with(|| {
        Box::leak(Box::new(Algorithm {
            width: params.width,
            poly: params.poly,
            init: params.init,
            refin: params.refin,
            refout: params.refout,
            xorout: params.xorout,
            // Unused by the computation; only the catalogue knows real
            // check values.
            check: 0,
            residue: 0,
        }))
    })
}

/// Resolve one config against a message entry. Free function (not a
/// `Database` method) so `lib.rs` can wrap it with the message lookup.
pub(crate) fn resolve(
    entry: &crate::MessageEntry,
    config: &CalculatedFieldsConfig,
) -> Result<ResolvedCalculatedFields, CalcFieldError> {
    let counter = config
        .counter
        .as_ref()
        .map(|c| resolve_counter(entry, c))
        .transpose()?;
    let crc = config
        .crc
        .as_ref()
        .map(|c| resolve_crc(entry, c))
        .transpose()?;
    Ok(ResolvedCalculatedFields { counter, crc })
}

/// The named signal's bit placement on this message.
fn placement_of(entry: &crate::MessageEntry, name: &str) -> Result<Placement, CalcFieldError> {
    let sig = entry
        .signals
        .iter()
        .find(|s| s.signal.name == name)
        .ok_or_else(|| CalcFieldError::SignalNotFound(name.to_string()))?;
    let start_bit = usize::try_from(sig.signal.start_bit)
        .map_err(|_| CalcFieldError::UnusableSignalLayout(name.to_string()))?;
    let size = match usize::try_from(sig.signal.size) {
        Ok(s) if (1..=64).contains(&s) => s,
        _ => return Err(CalcFieldError::UnusableSignalLayout(name.to_string())),
    };
    Ok(Placement {
        start_bit,
        size,
        byte_order: sig.signal.byte_order,
    })
}

fn resolve_counter(
    entry: &crate::MessageEntry,
    c: &CounterConfig,
) -> Result<ResolvedCounter, CalcFieldError> {
    let placement = placement_of(entry, &c.signal)?;
    if c.increment == 0 {
        return Err(CalcFieldError::ZeroIncrement);
    }
    let max = if placement.size == 64 {
        u64::MAX
    } else {
        (1u64 << placement.size) - 1
    };
    let rollover = c.rollover.unwrap_or(max);
    if rollover == 0 {
        return Err(CalcFieldError::ZeroRollover);
    }
    if rollover > max {
        return Err(CalcFieldError::RolloverTooLarge { rollover, max });
    }
    Ok(ResolvedCounter {
        placement,
        increment: c.increment,
        rollover,
    })
}

fn resolve_crc(entry: &crate::MessageEntry, c: &CrcConfig) -> Result<ResolvedCrc, CalcFieldError> {
    let placement = placement_of(entry, &c.signal)?;
    let algorithm: &'static Algorithm<u64> = match &c.algorithm {
        CrcAlgorithm::Named(name) => crc_named::lookup(name)
            .ok_or_else(|| CalcFieldError::UnknownAlgorithm(name.clone()))?,
        CrcAlgorithm::Raw(params) => {
            if !(1..=64).contains(&params.width) {
                return Err(CalcFieldError::UnusableAlgorithmWidth(params.width));
            }
            raw_algorithm(*params)
        }
    };
    let signal_bits = u32::try_from(placement.size).unwrap_or(0);
    if u32::from(algorithm.width) > signal_bits {
        return Err(CalcFieldError::AlgorithmWiderThanSignal {
            width: algorithm.width,
            signal_bits,
        });
    }
    let (start, length) = c.range_bits;
    if start % 8 != 0 || length % 8 != 0 || length == 0 {
        return Err(CalcFieldError::RangeNotByteAligned { start, length });
    }
    let payload_bits = u32::try_from(entry.expected_len)
        .ok()
        .and_then(|len| len.checked_mul(8))
        .unwrap_or(u32::MAX);
    let end_bit = start
        .checked_add(length)
        .ok_or(CalcFieldError::RangeOutOfBounds {
            end_bit: u32::MAX,
            payload_bits,
        })?;
    if end_bit > payload_bits {
        return Err(CalcFieldError::RangeOutOfBounds { end_bit, payload_bits });
    }
    let range_bytes = (start / 8) as usize..(end_bit / 8) as usize;
    if placement
        .occupied_bytes()
        .iter()
        .any(|b| range_bytes.contains(b))
    {
        return Err(CalcFieldError::RangeOverlapsDestination);
    }
    Ok(ResolvedCrc {
        placement,
        engine: Crc::<u64>::new(algorithm),
        range_bytes,
        prefix: c.prefix.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;

    /// 0x123 Status: Mode in byte 0, payload bytes 1..=5 free, a 4-bit
    /// counter in byte 6's low nibble, the CRC in byte 7. Plus a
    /// big-endian variant and a 16-bit-CRC variant.
    const CALC_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU1 GW

BO_ 291 Status: 8 ECU1
 SG_ Mode : 0|8@1+ (1,0) [0|255] "" GW
 SG_ AliveCtr : 48|4@1+ (1,0) [0|15] "" GW
 SG_ Crc8 : 56|8@1+ (1,0) [0|255] "" GW

BO_ 292 StatusBe: 8 ECU1
 SG_ CrcBe : 7|8@0+ (1,0) [0|255] "" GW

BO_ 293 Wide: 8 ECU1
 SG_ Crc16 : 48|16@1+ (1,0) [0|65535] "" GW
"#;

    fn db() -> Database {
        Database::parse(CALC_DBC).expect("fixture DBC parses")
    }

    fn id(raw: u32) -> cannet_core::CanId {
        cannet_core::CanId::standard(raw).unwrap()
    }

    fn crc8_j1850_config(range_bits: (u32, u32), prefix: Vec<u8>) -> CalculatedFieldsConfig {
        CalculatedFieldsConfig {
            counter: None,
            crc: Some(CrcConfig {
                signal: "Crc8".into(),
                algorithm: CrcAlgorithm::Named("CRC-8/SAE-J1850".into()),
                range_bits,
                prefix,
            }),
        }
    }

    /// Every named catalogue entry must reproduce its published check
    /// value (`checksum("123456789") == check`) — this validates both
    /// the widening to `Algorithm<u64>` and the generated name table.
    #[test]
    fn every_named_algorithm_matches_its_catalogue_check_value() {
        let table = crate::crc_named::named_algorithms();
        assert!(table.len() > 100, "catalogue list looks truncated");
        for (name, alg) in table {
            let crc = Crc::<u64>::new(alg);
            assert_eq!(
                crc.checksum(b"123456789"),
                alg.check,
                "check value mismatch for {name}"
            );
        }
    }

    #[test]
    fn named_lookup_is_exact_and_misses_cleanly() {
        assert!(crate::crc_named::lookup("CRC-8/SAE-J1850").is_some());
        assert!(crate::crc_named::lookup("CRC-8/sae-j1850").is_none());
        assert!(crate::crc_named::lookup("CRC-99/NOPE").is_none());
        let err = db()
            .resolve_calculated_fields(id(291), &crc8_j1850_config((0, 56), vec![]))
            .map(|_| ());
        assert!(err.is_ok());
        let err = db().resolve_calculated_fields(
            id(291),
            &CalculatedFieldsConfig {
                counter: None,
                crc: Some(CrcConfig {
                    signal: "Crc8".into(),
                    algorithm: CrcAlgorithm::Named("CRC-99/NOPE".into()),
                    range_bits: (0, 56),
                    prefix: vec![],
                }),
            },
        );
        assert_eq!(err.unwrap_err(), CalcFieldError::UnknownAlgorithm("CRC-99/NOPE".into()));
    }

    /// The E2E-profile shape: Data ID prefix + payload range. Expected
    /// values computed with an independent bitwise CRC-8 implementation
    /// (poly 0x1D, init 0xFF, xorout 0xFF, no reflection) — not with
    /// the `crc` crate.
    #[test]
    fn e2e_prefix_vectors_from_independent_reference() {
        let resolved = db()
            .resolve_calculated_fields(id(291), &crc8_j1850_config((0, 56), vec![0xA3]))
            .unwrap();
        let mut payload = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x00];
        let mut counter = 0;
        resolved.apply(&mut counter, &mut payload).unwrap();
        assert_eq!(payload[7], 0x41, "single-byte prefix vector");

        let resolved = db()
            .resolve_calculated_fields(id(291), &crc8_j1850_config((0, 56), vec![0x0F, 0xA3]))
            .unwrap();
        let mut payload = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x00];
        resolved.apply(&mut counter, &mut payload).unwrap();
        assert_eq!(payload[7], 0xFD, "two-byte prefix vector");
    }

    /// A 16-bit CRC into a 16-bit little-endian signal occupying bytes
    /// 6..8: a range reaching into byte 6 is rejected as overlapping,
    /// and the non-overlapping range produces the value the
    /// independent reference implementation computes.
    #[test]
    fn sixteen_bit_crc_encodes_into_its_signal() {
        let config = |range_bits| CalculatedFieldsConfig {
            counter: None,
            crc: Some(CrcConfig {
                signal: "Crc16".into(),
                algorithm: CrcAlgorithm::Named("CRC-16/IBM-3740".into()),
                range_bits,
                prefix: vec![],
            }),
        };
        assert_eq!(
            db().resolve_calculated_fields(id(293), &config((0, 56))).map(|_| ()),
            Err(CalcFieldError::RangeOverlapsDestination),
            "a 0:56 range covers byte 6, which the 16-bit signal occupies"
        );

        let resolved = db().resolve_calculated_fields(id(293), &config((0, 48))).unwrap();
        let mut payload = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x00, 0x00];
        let mut counter = 0;
        resolved.apply(&mut counter, &mut payload).unwrap();
        let found = decode_signal_bits(&payload, 48, 16, ByteOrder::LittleEndian).unwrap();
        // Independent bitwise CRC-16/IBM-3740 over 11 22 33 44 55 66.
        let expected = {
            let mut crc: u16 = 0xFFFF;
            for b in [0x11u8, 0x22, 0x33, 0x44, 0x55, 0x66] {
                crc ^= u16::from(b) << 8;
                for _ in 0..8 {
                    crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
                }
            }
            crc
        };
        assert_eq!(found, u64::from(expected));
    }

    /// Raw Rocksoft parameters equal to a named entry produce identical
    /// results.
    #[test]
    fn raw_params_match_the_equivalent_named_algorithm() {
        let raw = CalculatedFieldsConfig {
            counter: None,
            crc: Some(CrcConfig {
                signal: "Crc8".into(),
                algorithm: CrcAlgorithm::Raw(RawCrcParams {
                    width: 8,
                    poly: 0x1D,
                    init: 0xFF,
                    refin: false,
                    refout: false,
                    xorout: 0xFF,
                }),
                range_bits: (0, 56),
                prefix: vec![0xA3],
            }),
        };
        let named = crc8_j1850_config((0, 56), vec![0xA3]);
        let mut a = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x00];
        let mut b = a;
        let mut counter = 0;
        db().resolve_calculated_fields(id(291), &raw)
            .unwrap()
            .apply(&mut counter, &mut a)
            .unwrap();
        db().resolve_calculated_fields(id(291), &named)
            .unwrap()
            .apply(&mut counter, &mut b)
            .unwrap();
        assert_eq!(a, b);
        assert_eq!(a[7], 0x41);
    }

    /// Counter semantics: seed 0, step before encode, wrap at rollover
    /// (including non-power-of-two rollovers and increments > 1).
    #[test]
    fn counter_steps_and_wraps() {
        let config = CalculatedFieldsConfig {
            counter: Some(CounterConfig {
                signal: "AliveCtr".into(),
                increment: 1,
                rollover: Some(2),
            }),
            crc: None,
        };
        let resolved = db().resolve_calculated_fields(id(291), &config).unwrap();
        let mut payload = [0u8; 8];
        let mut counter = 0u64;
        let mut sent = Vec::new();
        for _ in 0..5 {
            resolved.apply(&mut counter, &mut payload).unwrap();
            sent.push(decode_signal_bits(&payload, 48, 4, ByteOrder::LittleEndian).unwrap());
        }
        // Seed 0; first fired frame carries `increment` (ADR 0027 fire
        // path: step, then encode), wrapping 0..=2.
        assert_eq!(sent, vec![1, 2, 0, 1, 2]);

        let config = CalculatedFieldsConfig {
            counter: Some(CounterConfig {
                signal: "AliveCtr".into(),
                increment: 2,
                rollover: Some(15),
            }),
            crc: None,
        };
        let resolved = db().resolve_calculated_fields(id(291), &config).unwrap();
        let mut counter = 14u64;
        resolved.apply(&mut counter, &mut payload).unwrap();
        assert_eq!(counter, 0, "14 + 2 wraps mod 16");
    }

    #[test]
    fn default_rollover_is_the_signal_width() {
        let config = CalculatedFieldsConfig {
            counter: Some(CounterConfig::new("AliveCtr")),
            crc: None,
        };
        let resolved = db().resolve_calculated_fields(id(291), &config).unwrap();
        let mut payload = [0u8; 8];
        let mut counter = 15u64; // 4-bit signal → rollover 15
        resolved.apply(&mut counter, &mut payload).unwrap();
        assert_eq!(counter, 0);
    }

    /// Full fire-path round trip: counter + CRC (range covering the
    /// counter), decoded back through the Database, then verified.
    #[test]
    fn apply_then_verify_round_trips_and_catches_corruption() {
        let config = CalculatedFieldsConfig {
            counter: Some(CounterConfig::new("AliveCtr")),
            crc: Some(CrcConfig {
                signal: "Crc8".into(),
                algorithm: CrcAlgorithm::Named("CRC-8/SAE-J1850".into()),
                range_bits: (0, 56),
                prefix: vec![0xA3],
            }),
        };
        let database = db();
        let resolved = database.resolve_calculated_fields(id(291), &config).unwrap();
        let mut payload = [0x42, 0, 0, 0, 0, 0, 0, 0];
        let mut counter = 0u64;

        resolved.apply(&mut counter, &mut payload).unwrap();
        let first = payload;
        resolved.apply(&mut counter, &mut payload).unwrap();
        let second = payload;

        // The decoded view shows the live values — no special-casing.
        let decoded = database.decode_raw(id(291), &second).unwrap();
        let alive = decoded.signals.iter().find(|s| s.name == "AliveCtr").unwrap();
        assert_eq!(alive.raw_unsigned, 2);

        // Verification: first sighting seeds, the consecutive frame
        // passes, and the CRC matches on both.
        let outcome = resolved.verify(&first, None);
        assert!(outcome.violations.is_empty());
        assert_eq!(outcome.counter, Some(1));
        let outcome = resolved.verify(&second, outcome.counter);
        assert!(outcome.violations.is_empty());
        assert_eq!(outcome.counter, Some(2));

        // Corrupt a covered byte → CRC mismatch.
        let mut corrupted = second;
        corrupted[2] ^= 0x01;
        let outcome = resolved.verify(&corrupted, Some(1));
        assert!(matches!(
            outcome.violations.as_slice(),
            [FieldViolation::CrcMismatch { .. }]
        ));

        // Replay `second` after `second` → counter skip (expected 3,
        // found 2), and the observed value re-seeds the state.
        let outcome = resolved.verify(&second, Some(2));
        assert_eq!(
            outcome.violations,
            vec![FieldViolation::CounterSkip { expected: 3, found: 2 }]
        );
        assert_eq!(outcome.counter, Some(2));
    }

    #[test]
    fn truncated_payload_is_a_violation_and_apply_errors() {
        let config = crc8_j1850_config((0, 56), vec![]);
        let resolved = db().resolve_calculated_fields(id(291), &config).unwrap();
        let short = [0u8; 4];
        let outcome = resolved.verify(&short, None);
        assert_eq!(outcome.violations, vec![FieldViolation::Truncated]);
        let mut buf = [0u8; 4];
        let mut counter = 0;
        assert_eq!(resolved.apply(&mut counter, &mut buf), Err(PayloadTooShort));
    }

    #[test]
    fn validation_rejects_bad_configs() {
        let database = db();
        let resolve = |config: &CalculatedFieldsConfig| {
            database
                .resolve_calculated_fields(id(291), config)
                .map(|_| ())
        };

        // Non-byte-aligned range.
        assert_eq!(
            resolve(&crc8_j1850_config((4, 8), vec![])).unwrap_err(),
            CalcFieldError::RangeNotByteAligned { start: 4, length: 8 }
        );
        assert_eq!(
            resolve(&crc8_j1850_config((0, 12), vec![])).unwrap_err(),
            CalcFieldError::RangeNotByteAligned { start: 0, length: 12 }
        );
        // Zero-length range.
        assert_eq!(
            resolve(&crc8_j1850_config((0, 0), vec![])).unwrap_err(),
            CalcFieldError::RangeNotByteAligned { start: 0, length: 0 }
        );
        // Range past the declared payload.
        assert_eq!(
            resolve(&crc8_j1850_config((0, 72), vec![])).unwrap_err(),
            CalcFieldError::RangeOutOfBounds { end_bit: 72, payload_bits: 64 }
        );
        // Range covering the CRC's own byte.
        assert_eq!(
            resolve(&crc8_j1850_config((0, 64), vec![])).unwrap_err(),
            CalcFieldError::RangeOverlapsDestination
        );
        // Unknown destination signal.
        assert_eq!(
            resolve(&CalculatedFieldsConfig {
                counter: Some(CounterConfig::new("Nope")),
                crc: None,
            })
            .unwrap_err(),
            CalcFieldError::SignalNotFound("Nope".into())
        );
        // Counter parameter errors.
        assert_eq!(
            resolve(&CalculatedFieldsConfig {
                counter: Some(CounterConfig {
                    signal: "AliveCtr".into(),
                    increment: 0,
                    rollover: None,
                }),
                crc: None,
            })
            .unwrap_err(),
            CalcFieldError::ZeroIncrement
        );
        assert_eq!(
            resolve(&CalculatedFieldsConfig {
                counter: Some(CounterConfig {
                    signal: "AliveCtr".into(),
                    increment: 1,
                    rollover: Some(16),
                }),
                crc: None,
            })
            .unwrap_err(),
            CalcFieldError::RolloverTooLarge { rollover: 16, max: 15 }
        );
        // Algorithm wider than the destination.
        assert_eq!(
            resolve(&CalculatedFieldsConfig {
                counter: None,
                crc: Some(CrcConfig {
                    signal: "Crc8".into(),
                    algorithm: CrcAlgorithm::Named("CRC-16/IBM-3740".into()),
                    range_bits: (0, 56),
                    prefix: vec![],
                }),
            })
            .unwrap_err(),
            CalcFieldError::AlgorithmWiderThanSignal { width: 16, signal_bits: 8 }
        );
        // Unknown message id.
        assert_eq!(
            database
                .resolve_calculated_fields(id(0x7FF), &crc8_j1850_config((0, 56), vec![]))
                .map(|_| ())
                .unwrap_err(),
            CalcFieldError::MessageNotFound
        );
    }

    /// A big-endian destination's occupied bytes are walked Motorola-
    /// style for the overlap check: `CrcBe` at `start_bit` 7, size 8,
    /// is byte 0, so a range starting at byte 0 must be rejected and
    /// one starting at byte 1 accepted.
    #[test]
    fn big_endian_destination_overlap_uses_the_motorola_walk() {
        let config = |range_bits| CalculatedFieldsConfig {
            counter: None,
            crc: Some(CrcConfig {
                signal: "CrcBe".into(),
                algorithm: CrcAlgorithm::Named("CRC-8/SAE-J1850".into()),
                range_bits,
                prefix: vec![],
            }),
        };
        assert_eq!(
            db().resolve_calculated_fields(id(292), &config((0, 8))).map(|_| ()),
            Err(CalcFieldError::RangeOverlapsDestination)
        );
        let resolved = db().resolve_calculated_fields(id(292), &config((8, 56))).unwrap();
        let mut payload = [0u8; 8];
        payload[1..8].copy_from_slice(&[0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
        let mut counter = 0;
        resolved.apply(&mut counter, &mut payload).unwrap();
        // Same bytes as the LE e2e test minus the prefix: independent
        // reference value for CRC-8/SAE-J1850 over 11..77 is 0x97.
        assert_eq!(
            decode_signal_bits(&payload, 7, 8, ByteOrder::BigEndian).unwrap(),
            u64::from(payload[0])
        );
        let outcome = resolved.verify(&payload, None);
        assert!(outcome.violations.is_empty());
    }
}
