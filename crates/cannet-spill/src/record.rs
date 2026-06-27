//! Fixed-size metadata record layout (ADR 0002 DS-1).
//!
//! Each stored frame has one fixed-size metadata record, so row `N` is
//! found by arithmetic — `offset = N * RECORD_SIZE` — with no index
//! structure. The record carries the frame's scalar fields plus an inline
//! `(offset, len)` into the separate packed payload blob. The logical
//! bus is interned to a small integer (`bus_idx`); `0xFFFF` means "no
//! bus" (`bus_id == None`).
//!
//! Layout (little-endian), 27 bytes — ADR DS-1's "~26 B", the extra byte
//! being the explicit `channel`:
//!
//! ```text
//!   [ 0.. 8)  ts_ns        u64
//!   [ 8..16)  payload_off  u64   global byte offset into the payload blob
//!   [16..20)  id           u32   arbitration id
//!   [20..22)  payload_len  u16   bytes at payload_off (0 for Remote/Error)
//!   [22..24)  bus_idx      u16   interned bus, 0xFFFF = None
//!   [24]      channel      u8
//!   [25]      flags        u8    see below
//!   [26]      dlc          u8    Remote DLC; 0 otherwise
//! ```
//!
//! `flags` bits: 0 = extended, 1 = `is_tx`, 2..4 = payload kind
//! (0 Classic, 1 Fd, 2 Remote, 3 Error), 4 = FD bitrate-switch,
//! 5 = FD error-state-indicator.

use cannet_core::{CanFdFlags, CanFramePayload, Direction};

pub(crate) const RECORD_SIZE: usize = 27;

/// Sentinel `bus_idx` for a frame with no logical bus (`bus_id == None`).
pub(crate) const BUS_NONE: u16 = u16::MAX;

const F_EXTENDED: u8 = 1 << 0;
const F_IS_TX: u8 = 1 << 1;
const KIND_SHIFT: u8 = 2;
const KIND_MASK: u8 = 0b11 << KIND_SHIFT;
const KIND_CLASSIC: u8 = 0;
const KIND_FD: u8 = 1;
const KIND_REMOTE: u8 = 2;
const KIND_ERROR: u8 = 3;
const F_FD_BRS: u8 = 1 << 4;
const F_FD_ESI: u8 = 1 << 5;

/// The decoded metadata fields of one record, sans payload bytes.
#[derive(Debug, Clone, Copy)]
pub(crate) struct MetaRecord {
    pub ts_ns: u64,
    pub payload_off: u64,
    pub payload_len: u16,
    pub id: u32,
    pub bus_idx: u16,
    pub channel: u8,
    pub extended: bool,
    pub direction: Direction,
    pub kind: PayloadKind,
}

/// What sort of payload the record points at — enough, with the payload
/// bytes, to rebuild the [`CanFramePayload`].
#[derive(Debug, Clone, Copy)]
pub(crate) enum PayloadKind {
    Classic,
    Fd(CanFdFlags),
    Remote { dlc: u8 },
    Error,
}

impl MetaRecord {
    /// Encode into the fixed-size on-disk record.
    pub(crate) fn encode(&self) -> [u8; RECORD_SIZE] {
        let mut buf = [0u8; RECORD_SIZE];
        buf[0..8].copy_from_slice(&self.ts_ns.to_le_bytes());
        buf[8..16].copy_from_slice(&self.payload_off.to_le_bytes());
        buf[16..20].copy_from_slice(&self.id.to_le_bytes());
        buf[20..22].copy_from_slice(&self.payload_len.to_le_bytes());
        buf[22..24].copy_from_slice(&self.bus_idx.to_le_bytes());
        buf[24] = self.channel;
        let mut flags = 0u8;
        if self.extended {
            flags |= F_EXTENDED;
        }
        if matches!(self.direction, Direction::Tx) {
            flags |= F_IS_TX;
        }
        let mut dlc = 0u8;
        let kind = match self.kind {
            PayloadKind::Classic => KIND_CLASSIC,
            PayloadKind::Fd(f) => {
                if f.bitrate_switch {
                    flags |= F_FD_BRS;
                }
                if f.error_state_indicator {
                    flags |= F_FD_ESI;
                }
                KIND_FD
            }
            PayloadKind::Remote { dlc: d } => {
                dlc = d;
                KIND_REMOTE
            }
            PayloadKind::Error => KIND_ERROR,
        };
        flags |= kind << KIND_SHIFT;
        buf[25] = flags;
        buf[26] = dlc;
        buf
    }

    /// Decode a record from its fixed-size bytes.
    ///
    /// # Panics
    /// Panics if `bytes` is shorter than [`RECORD_SIZE`].
    pub(crate) fn decode(bytes: &[u8]) -> Self {
        let ts_ns = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        let payload_off = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        let id = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
        let payload_len = u16::from_le_bytes(bytes[20..22].try_into().unwrap());
        let bus_idx = u16::from_le_bytes(bytes[22..24].try_into().unwrap());
        let channel = bytes[24];
        let flags = bytes[25];
        let dlc = bytes[26];
        let extended = flags & F_EXTENDED != 0;
        let direction = if flags & F_IS_TX != 0 {
            Direction::Tx
        } else {
            Direction::Rx
        };
        let kind = match (flags & KIND_MASK) >> KIND_SHIFT {
            KIND_CLASSIC => PayloadKind::Classic,
            KIND_FD => PayloadKind::Fd(CanFdFlags {
                bitrate_switch: flags & F_FD_BRS != 0,
                error_state_indicator: flags & F_FD_ESI != 0,
            }),
            KIND_REMOTE => PayloadKind::Remote { dlc },
            _ => PayloadKind::Error,
        };
        Self {
            ts_ns,
            payload_off,
            payload_len,
            id,
            bus_idx,
            channel,
            extended,
            direction,
            kind,
        }
    }
}

/// Split a payload into its record kind and the bytes to store in the
/// blob (empty for Remote/Error).
pub(crate) fn split_payload(payload: &CanFramePayload) -> (PayloadKind, &[u8]) {
    match payload {
        CanFramePayload::Classic(d) => (PayloadKind::Classic, d.as_slice()),
        CanFramePayload::Fd { data, flags } => (PayloadKind::Fd(*flags), data.as_slice()),
        CanFramePayload::Remote { dlc } => (PayloadKind::Remote { dlc: *dlc }, &[]),
        CanFramePayload::Error => (PayloadKind::Error, &[]),
    }
}

/// Rebuild a [`CanFramePayload`] from a record kind and its stored bytes.
pub(crate) fn rebuild_payload(kind: PayloadKind, data: &[u8]) -> CanFramePayload {
    match kind {
        PayloadKind::Classic => CanFramePayload::Classic(data.to_vec()),
        PayloadKind::Fd(flags) => CanFramePayload::Fd {
            data: data.to_vec(),
            flags,
        },
        PayloadKind::Remote { dlc } => CanFramePayload::Remote { dlc },
        PayloadKind::Error => CanFramePayload::Error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_round_trips_all_fields() {
        let rec = MetaRecord {
            ts_ns: 0x0123_4567_89ab_cdef,
            payload_off: 0xdead_beef,
            payload_len: 64,
            id: 0x1ff_ffff,
            bus_idx: 7,
            channel: 3,
            extended: true,
            direction: Direction::Tx,
            kind: PayloadKind::Fd(CanFdFlags {
                bitrate_switch: true,
                error_state_indicator: false,
            }),
        };
        let got = MetaRecord::decode(&rec.encode());
        assert_eq!(got.ts_ns, rec.ts_ns);
        assert_eq!(got.payload_off, rec.payload_off);
        assert_eq!(got.payload_len, rec.payload_len);
        assert_eq!(got.id, rec.id);
        assert_eq!(got.bus_idx, rec.bus_idx);
        assert_eq!(got.channel, rec.channel);
        assert!(got.extended);
        assert_eq!(got.direction, Direction::Tx);
        match got.kind {
            PayloadKind::Fd(f) => {
                assert!(f.bitrate_switch && !f.error_state_indicator);
            }
            _ => panic!("kind"),
        }
    }

    #[test]
    fn remote_carries_dlc_and_no_payload_bytes() {
        let (kind, bytes) = split_payload(&CanFramePayload::Remote { dlc: 5 });
        assert!(bytes.is_empty());
        let rec = MetaRecord {
            ts_ns: 1,
            payload_off: 0,
            payload_len: 0,
            id: 1,
            bus_idx: BUS_NONE,
            channel: 0,
            extended: false,
            direction: Direction::Rx,
            kind,
        };
        let got = MetaRecord::decode(&rec.encode());
        match got.kind {
            PayloadKind::Remote { dlc } => assert_eq!(dlc, 5),
            _ => panic!("kind"),
        }
        assert_eq!(got.bus_idx, BUS_NONE);
    }

    #[test]
    fn classic_and_error_round_trip() {
        for payload in [
            CanFramePayload::Classic(vec![1, 2, 3]),
            CanFramePayload::Error,
        ] {
            let (kind, bytes) = split_payload(&payload);
            let rec = MetaRecord {
                ts_ns: 9,
                payload_off: 0,
                payload_len: u16::try_from(bytes.len()).unwrap(),
                id: 0x100,
                bus_idx: 0,
                channel: 1,
                extended: false,
                direction: Direction::Rx,
                kind,
            };
            let got = MetaRecord::decode(&rec.encode());
            assert_eq!(rebuild_payload(got.kind, bytes), payload);
        }
    }
}
