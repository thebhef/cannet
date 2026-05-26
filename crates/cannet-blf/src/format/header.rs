//! BLF `FileStatistics` — the fixed-layout record every BLF opens
//! with.
//!
//! Layout per Vector's `binlog_objects.h` (2018 v8) §
//! `VBLFileStatisticsEx`, cross-referenced against
//! `vector_blf`'s `FileStatistics.h`:
//!
//! ```text
//! offset  size  field
//! 0       4     signature  ("LOGG" = 0x4747_4F4C little-endian)
//! 4       4     statistics_size  (bytes — normally 144)
//! 8       4     api_number  (encoded major.minor.build.patch)
//! 12      1     application_id
//! 13      1     compression_level
//! 14      1     application_major
//! 15      1     application_minor
//! 16      8     file_size  (compressed bytes on disk)
//! 24      8     uncompressed_file_size
//! 32      4     object_count
//! 36      4     application_build
//! 40      16    measurement_start_time  (SYSTEMTIME)
//! 56      16    last_object_time        (SYSTEMTIME)
//! 72      8     restore_points_offset
//! 80      64    reserved (16 × u32 = 64 bytes)
//! ```
//!
//! Total: 144 bytes. All multi-byte integers are little-endian
//! (BLF is a little-endian-only format per `vector_blf`'s README).
//!
//! Only `signature` and `statistics_size` are structurally
//! validated on parse; the remaining fields are read into a typed
//! struct so callers (e.g. the streaming reader) can use the
//! measurement-start time and other metadata without a second pass.

/// Vector's `LOGG` file-signature constant, little-endian (i.e. the
/// bytes are `L O G G` in the order they appear on disk).
pub const FILE_SIGNATURE: u32 = 0x4747_4F4C;

/// The fixed (`statistics_size` ≥ 144) byte width of a `FileStatistics`
/// record. The on-disk record can be larger if `statistics_size`
/// reports more; that's a forward-compat hook we'll surface as
/// "trailing bytes" rather than reject.
pub const FILE_STATISTICS_MIN_BYTES: usize = 144;

/// Vector `SYSTEMTIME` (16 bytes). Stored as little-endian
/// `u16`s — year / month / dow / day / hour / minute / second / ms.
/// All zeros means "unset", which is what fresh writers stamp.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SystemTime {
    pub year: u16,
    pub month: u16,
    pub day_of_week: u16,
    pub day: u16,
    pub hour: u16,
    pub minute: u16,
    pub second: u16,
    pub millisecond: u16,
}

impl SystemTime {
    pub(crate) fn parse(bytes: [u8; 16]) -> Self {
        Self {
            year: u16::from_le_bytes([bytes[0], bytes[1]]),
            month: u16::from_le_bytes([bytes[2], bytes[3]]),
            day_of_week: u16::from_le_bytes([bytes[4], bytes[5]]),
            day: u16::from_le_bytes([bytes[6], bytes[7]]),
            hour: u16::from_le_bytes([bytes[8], bytes[9]]),
            minute: u16::from_le_bytes([bytes[10], bytes[11]]),
            second: u16::from_le_bytes([bytes[12], bytes[13]]),
            millisecond: u16::from_le_bytes([bytes[14], bytes[15]]),
        }
    }

    /// Convert this SYSTEMTIME to nanoseconds since the UNIX epoch
    /// (1970-01-01 00:00:00 UTC), proleptic Gregorian, no leap
    /// seconds (BLF, like Windows SYSTEMTIME, doesn't model them).
    ///
    /// Returns 0 if any field is zero or out of range — the
    /// convention Vector uses for "not set", and what
    /// `blf_asc::systemtime_to_timestamp` returns for the same input.
    pub fn to_unix_nanos(self) -> u64 {
        if self.year == 0 || self.month == 0 || self.day == 0 {
            return 0;
        }
        let y = i32::from(self.year);
        let m = u32::from(self.month);
        let d = u32::from(self.day);
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            return 0;
        }
        let days = days_since_unix_epoch(y, m, d);
        if days < 0 {
            return 0;
        }
        let secs = u64::try_from(days).unwrap_or(0) * 86_400
            + u64::from(self.hour) * 3_600
            + u64::from(self.minute) * 60
            + u64::from(self.second);
        secs * 1_000_000_000 + u64::from(self.millisecond) * 1_000_000
    }
}

/// Inverse of [`SystemTime::to_unix_nanos`]. Input 0 maps to the
/// all-zero "unset" sentinel SYSTEMTIME.
impl SystemTime {
    pub fn from_unix_nanos(ns: u64) -> Self {
        if ns == 0 {
            return Self::default();
        }
        let secs = ns / 1_000_000_000;
        let millisecond = u16::try_from((ns / 1_000_000) % 1_000).unwrap_or(0);
        let day_secs = secs % 86_400;
        let days_since_epoch = i64::try_from(secs / 86_400).unwrap_or(0);
        let (year, month, day) = civil_from_days(days_since_epoch);
        Self {
            year: u16::try_from(year).unwrap_or(0),
            month: u16::try_from(month).unwrap_or(0),
            day_of_week: 0, // BLF readers don't require this; Vector
                            // populates it but it's redundant info
            day: u16::try_from(day).unwrap_or(0),
            hour: u16::try_from(day_secs / 3_600).unwrap_or(0),
            minute: u16::try_from((day_secs % 3_600) / 60).unwrap_or(0),
            second: u16::try_from(day_secs % 60).unwrap_or(0),
            millisecond,
        }
    }
}

fn write_system_time(dst: &mut [u8], t: SystemTime) {
    assert_eq!(dst.len(), 16, "SYSTEMTIME slot is 16 bytes");
    dst[0..2].copy_from_slice(&t.year.to_le_bytes());
    dst[2..4].copy_from_slice(&t.month.to_le_bytes());
    dst[4..6].copy_from_slice(&t.day_of_week.to_le_bytes());
    dst[6..8].copy_from_slice(&t.day.to_le_bytes());
    dst[8..10].copy_from_slice(&t.hour.to_le_bytes());
    dst[10..12].copy_from_slice(&t.minute.to_le_bytes());
    dst[12..14].copy_from_slice(&t.second.to_le_bytes());
    dst[14..16].copy_from_slice(&t.millisecond.to_le_bytes());
}

/// Inverse of [`days_since_unix_epoch`] — Howard Hinnant's "civil
/// from days." Returns (year, month, day).
fn civil_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe = u32::try_from(z - era * 146_097).unwrap_or(0); // [0, 146097)
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 400)
    let y_offset = i64::from(yoe) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y_offset + 1 } else { y_offset };
    (i32::try_from(y).unwrap_or(0), m, d)
}

/// Days between 1970-01-01 and (`year`, `month`, `day`), proleptic
/// Gregorian. Returns a signed count so dates before the epoch (rare
/// but possible) can be detected with `< 0`.
fn days_since_unix_epoch(year: i32, month: u32, day: u32) -> i64 {
    // Howard Hinnant's "days from civil" — well-known constant-time
    // proleptic Gregorian day count. Origin: 1970-03-01 shifted by
    // 60 days to land back on 1970-01-01.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = u32::try_from(y.rem_euclid(400)).expect("rem_euclid(400) ∈ [0,400)");
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    i64::from(era) * 146_097 + i64::from(doe) - 719_468
}

/// Parsed `FileStatistics` header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStatistics {
    /// Total record size in bytes per `statistics_size`. Always ≥
    /// [`FILE_STATISTICS_MIN_BYTES`]; values larger than the minimum
    /// indicate a writer wrote a forward-extended record we'll
    /// preserve verbatim when we round-trip.
    pub statistics_size: u32,
    /// Encoded `major * 1_000_000 + minor * 1_000 + build * 100 + patch`.
    pub api_number: u32,
    pub application_id: u8,
    pub compression_level: u8,
    pub application_major: u8,
    pub application_minor: u8,
    /// Compressed file size in bytes (the on-disk size).
    pub file_size: u64,
    /// Uncompressed file size in bytes.
    pub uncompressed_file_size: u64,
    /// Total object count across the file.
    pub object_count: u32,
    pub application_build: u32,
    pub measurement_start_time: SystemTime,
    pub last_object_time: SystemTime,
    /// File offset of the `LOG_CONTAINER` carrying restore-point
    /// records, or 0 if the file doesn't use them.
    pub restore_points_offset: u64,
}

/// Parse errors specific to the BLF header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderError {
    /// File was too short to even contain the fixed-size header.
    /// Carries the byte length we got.
    Truncated(usize),
    /// First 4 bytes weren't `LOGG`. Carries what we saw.
    BadSignature(u32),
    /// `statistics_size` field claimed a record smaller than 144 bytes,
    /// which violates Vector's spec. Carries the reported size.
    StatisticsSizeTooSmall(u32),
}

impl std::fmt::Display for HeaderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated(n) => write!(
                f,
                "BLF header truncated: got {n} bytes, need at least {FILE_STATISTICS_MIN_BYTES}",
            ),
            Self::BadSignature(sig) => write!(
                f,
                "BLF signature mismatch: expected {FILE_SIGNATURE:#010x} (LOGG), got {sig:#010x}",
            ),
            Self::StatisticsSizeTooSmall(n) => write!(
                f,
                "BLF FileStatistics.statistics_size reports {n} bytes, below the {FILE_STATISTICS_MIN_BYTES}-byte minimum",
            ),
        }
    }
}

impl std::error::Error for HeaderError {}

impl FileStatistics {
    /// Encode this header to its fixed 144 bytes. The trailing
    /// 64-byte reserved region is zero-filled (matches what every
    /// BLF writer in the wild does).
    pub fn encode(&self) -> [u8; FILE_STATISTICS_MIN_BYTES] {
        let mut bytes = [0u8; FILE_STATISTICS_MIN_BYTES];
        bytes[0..4].copy_from_slice(&FILE_SIGNATURE.to_le_bytes());
        bytes[4..8].copy_from_slice(&self.statistics_size.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.api_number.to_le_bytes());
        bytes[12] = self.application_id;
        bytes[13] = self.compression_level;
        bytes[14] = self.application_major;
        bytes[15] = self.application_minor;
        bytes[16..24].copy_from_slice(&self.file_size.to_le_bytes());
        bytes[24..32].copy_from_slice(&self.uncompressed_file_size.to_le_bytes());
        bytes[32..36].copy_from_slice(&self.object_count.to_le_bytes());
        bytes[36..40].copy_from_slice(&self.application_build.to_le_bytes());
        write_system_time(&mut bytes[40..56], self.measurement_start_time);
        write_system_time(&mut bytes[56..72], self.last_object_time);
        bytes[72..80].copy_from_slice(&self.restore_points_offset.to_le_bytes());
        // bytes[80..144] = reserved (already zero from initialisation)
        bytes
    }

    /// Parse the fixed 144-byte prefix as a `FileStatistics` record.
    /// Trailing bytes past 144 (when `statistics_size` reports more)
    /// are the writer's responsibility to expose; this parse covers
    /// the universally-present prefix only.
    // The `try_into().unwrap()` calls are unreachable: every slice
    // is taken from the bytes[0..N] window after the length check
    // at the top.
    #[allow(clippy::missing_panics_doc)]
    pub fn parse(bytes: &[u8]) -> Result<Self, HeaderError> {
        if bytes.len() < FILE_STATISTICS_MIN_BYTES {
            return Err(HeaderError::Truncated(bytes.len()));
        }
        let signature = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        if signature != FILE_SIGNATURE {
            return Err(HeaderError::BadSignature(signature));
        }
        let statistics_size = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        if (statistics_size as usize) < FILE_STATISTICS_MIN_BYTES {
            return Err(HeaderError::StatisticsSizeTooSmall(statistics_size));
        }
        Ok(Self {
            statistics_size,
            api_number: u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            application_id: bytes[12],
            compression_level: bytes[13],
            application_major: bytes[14],
            application_minor: bytes[15],
            file_size: u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
            uncompressed_file_size: u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
            object_count: u32::from_le_bytes(bytes[32..36].try_into().unwrap()),
            application_build: u32::from_le_bytes(bytes[36..40].try_into().unwrap()),
            measurement_start_time: SystemTime::parse(bytes[40..56].try_into().unwrap()),
            last_object_time: SystemTime::parse(bytes[56..72].try_into().unwrap()),
            restore_points_offset: u64::from_le_bytes(bytes[72..80].try_into().unwrap()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_constant_matches_logg_ascii() {
        assert_eq!(FILE_SIGNATURE.to_le_bytes(), *b"LOGG");
    }

    #[test]
    fn parses_a_minimum_synthetic_header() {
        let mut bytes = [0u8; FILE_STATISTICS_MIN_BYTES];
        bytes[0..4].copy_from_slice(b"LOGG");
        bytes[4..8].copy_from_slice(&144_u32.to_le_bytes());
        bytes[8..12].copy_from_slice(&4_080_200_u32.to_le_bytes());
        bytes[12] = 2; // applicationId = CANoe
        bytes[13] = 6; // compression_level
        bytes[14] = 1;
        bytes[15] = 2;
        bytes[16..24].copy_from_slice(&12_345_u64.to_le_bytes());
        bytes[24..32].copy_from_slice(&67_890_u64.to_le_bytes());
        bytes[32..36].copy_from_slice(&42_u32.to_le_bytes());
        bytes[36..40].copy_from_slice(&7_u32.to_le_bytes());
        // measurement_start_time year=2026, month=5
        bytes[40..42].copy_from_slice(&2026_u16.to_le_bytes());
        bytes[42..44].copy_from_slice(&5_u16.to_le_bytes());

        let parsed = FileStatistics::parse(&bytes).expect("header should parse");
        assert_eq!(parsed.statistics_size, 144);
        assert_eq!(parsed.api_number, 4_080_200);
        assert_eq!(parsed.application_id, 2);
        assert_eq!(parsed.compression_level, 6);
        assert_eq!(parsed.application_major, 1);
        assert_eq!(parsed.application_minor, 2);
        assert_eq!(parsed.file_size, 12_345);
        assert_eq!(parsed.uncompressed_file_size, 67_890);
        assert_eq!(parsed.object_count, 42);
        assert_eq!(parsed.application_build, 7);
        assert_eq!(parsed.measurement_start_time.year, 2026);
        assert_eq!(parsed.measurement_start_time.month, 5);
    }

    #[test]
    fn system_time_to_unix_nanos_handles_unset_sentinel() {
        // Zero year / month / day means "not set" — Vector and
        // blf_asc both return 0 here.
        assert_eq!(SystemTime::default().to_unix_nanos(), 0);
    }

    #[test]
    fn system_time_to_unix_nanos_converts_a_known_date() {
        // 2024-01-15 12:30:45.250 UTC = 1_705_321_845_250_000_000 ns.
        let t = SystemTime {
            year: 2024,
            month: 1,
            day: 15,
            hour: 12,
            minute: 30,
            second: 45,
            millisecond: 250,
            ..SystemTime::default()
        };
        assert_eq!(t.to_unix_nanos(), 1_705_321_845_250_000_000);
    }

    #[test]
    fn system_time_round_trips_through_unix_nanos() {
        for ns in [
            1_705_321_845_250_000_000u64, // 2024-01-15 12:30:45.250
            1_709_164_800_000_000_000u64, // 2024-02-29 00:00:00 (leap)
            946_684_800_000_000_000u64,   // 2000-01-01 00:00:00 (century leap)
            1_577_836_800_001_000_000u64, // 2020-01-01 00:00:00.001
        ] {
            let st = SystemTime::from_unix_nanos(ns);
            assert_eq!(
                st.to_unix_nanos(),
                ns,
                "round-trip failed for {ns}: got {st:?}",
            );
        }
    }

    #[test]
    fn file_statistics_round_trips_through_encode_parse() {
        let original = FileStatistics {
            statistics_size: 144,
            api_number: 4_080_200,
            application_id: 2,
            compression_level: 6,
            application_major: 1,
            application_minor: 2,
            file_size: 12_345,
            uncompressed_file_size: 67_890,
            object_count: 42,
            application_build: 7,
            measurement_start_time: SystemTime::from_unix_nanos(1_705_321_845_250_000_000),
            last_object_time: SystemTime::from_unix_nanos(1_705_321_855_750_000_000),
            restore_points_offset: 0,
        };
        let bytes = original.encode();
        let parsed = FileStatistics::parse(&bytes).unwrap();
        assert_eq!(parsed, original);
    }

    #[test]
    fn system_time_to_unix_nanos_handles_leap_year_feb_29() {
        // 2024 is a leap year. 2024-02-29 00:00:00 UTC = 1_709_164_800 s.
        let t = SystemTime {
            year: 2024,
            month: 2,
            day: 29,
            ..SystemTime::default()
        };
        assert_eq!(t.to_unix_nanos(), 1_709_164_800_000_000_000);
    }

    #[test]
    fn rejects_short_buffer() {
        let err = FileStatistics::parse(&[0u8; 100]).unwrap_err();
        assert_eq!(err, HeaderError::Truncated(100));
    }

    #[test]
    fn rejects_bad_signature() {
        let mut bytes = [0u8; FILE_STATISTICS_MIN_BYTES];
        bytes[0..4].copy_from_slice(b"NOPE");
        bytes[4..8].copy_from_slice(&144_u32.to_le_bytes());
        let err = FileStatistics::parse(&bytes).unwrap_err();
        assert!(matches!(err, HeaderError::BadSignature(_)));
    }

    #[test]
    fn rejects_undersized_statistics_size() {
        let mut bytes = [0u8; FILE_STATISTICS_MIN_BYTES];
        bytes[0..4].copy_from_slice(b"LOGG");
        bytes[4..8].copy_from_slice(&100_u32.to_le_bytes());
        let err = FileStatistics::parse(&bytes).unwrap_err();
        assert_eq!(err, HeaderError::StatisticsSizeTooSmall(100));
    }

    /// A real BLF written by `BlfCaptureWriter` must have a header
    /// the parser accepts — round-trip check that the writer's
    /// stamped header is well-formed by the parser's definition.
    #[test]
    fn parses_header_of_a_blf_written_by_our_writer() {
        use crate::BlfCaptureWriter;
        use cannet_core::{CanFrame, CanId, Direction};
        use std::io::Read;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("header.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        let frame = CanFrame::classic(
            1_700_000_000_u64 * 1_000_000_000,
            0,
            CanId::standard(0x123).unwrap(),
            Direction::Rx,
            vec![0xAA, 0xBB],
        )
        .unwrap();
        writer.append(&frame).unwrap();
        writer.finish().unwrap();

        let mut prefix = vec![0u8; FILE_STATISTICS_MIN_BYTES];
        std::fs::File::open(&path)
            .unwrap()
            .read_exact(&mut prefix)
            .unwrap();
        let parsed = FileStatistics::parse(&prefix).expect("real BLF header parses");
        assert_eq!(parsed.statistics_size as usize, FILE_STATISTICS_MIN_BYTES);
        // file_size in the header should match the actual on-disk size.
        let on_disk = std::fs::metadata(&path).unwrap().len();
        assert_eq!(parsed.file_size, on_disk);
    }
}
