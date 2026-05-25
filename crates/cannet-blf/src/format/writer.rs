//! Streaming BLF writer. Counterpart to [`super::reader::BlfReader`].
//!
//! Accumulates encoded inner objects in a scratch buffer; when the
//! buffer grows past [`DEFAULT_CONTAINER_BUFFER_BYTES`], flushes
//! them as one zlib-compressed `LOG_CONTAINER` to disk. On
//! [`BlfFileWriter::finish`], any remaining buffered bytes flush
//! and the placeholder `FileStatistics` written at open time is
//! overwritten with the actual on-disk size, object count, and
//! measurement timestamps.

use std::fs::{File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::Path;

use super::header::{FileStatistics, SystemTime, FILE_STATISTICS_MIN_BYTES};
use super::log_container::{self, COMPRESSION_ZLIB};

/// Soft cap on the inner-object buffer before flushing as a
/// `LOG_CONTAINER`. Chosen to match Vector's tools (≈128 KiB
/// pre-compression) — small enough that flushes happen regularly
/// without dominating, large enough that zlib has meaningful
/// material to compress.
pub const DEFAULT_CONTAINER_BUFFER_BYTES: usize = 128 * 1024;

/// Streaming BLF writer. See module docs.
pub struct BlfFileWriter {
    file: File,
    /// Inner-object scratch — back-to-back encoded objects that
    /// haven't been packed into a `LOG_CONTAINER` yet.
    buffer: Vec<u8>,
    /// Soft cap; once `buffer.len() >= flush_threshold` we flush.
    flush_threshold: usize,
    /// Earliest event timestamp seen so far (ns since UNIX epoch),
    /// or `None` if no events have been appended. Used to stamp
    /// `measurement_start_time` in the final `FileStatistics`.
    /// Per-event `object_timestamp` is the *relative* offset from
    /// this; the writer subtracts it before encoding.
    start_unix_nanos: Option<u64>,
    /// Latest event timestamp seen so far — stamps `last_object_time`.
    last_unix_nanos: Option<u64>,
    /// Running count of appended events.
    object_count: u32,
    /// Running uncompressed inner-byte count — what the final
    /// `FileStatistics.uncompressed_file_size` reports.
    uncompressed_size: u64,
}

impl BlfFileWriter {
    /// Create a new BLF at `path` and write a placeholder
    /// `FileStatistics` header. The header is overwritten with the
    /// correct values on [`Self::finish`].
    // `expect` is unreachable: 144 fits in u32 trivially.
    #[allow(clippy::missing_panics_doc)]
    pub fn create<P: AsRef<Path>>(path: P) -> io::Result<Self> {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(path)?;
        // Placeholder FileStatistics: signature and statistics_size
        // are correct; everything else is zero until finish.
        let placeholder = FileStatistics {
            statistics_size: u32::try_from(FILE_STATISTICS_MIN_BYTES)
                .expect("144 fits in u32"),
            api_number: 0,
            application_id: 0,
            compression_level: 0,
            application_major: 0,
            application_minor: 0,
            file_size: 0,
            uncompressed_file_size: 0,
            object_count: 0,
            application_build: 0,
            measurement_start_time: SystemTime::default(),
            last_object_time: SystemTime::default(),
            restore_points_offset: 0,
        };
        file.write_all(&placeholder.encode())?;
        Ok(Self {
            file,
            buffer: Vec::with_capacity(DEFAULT_CONTAINER_BUFFER_BYTES),
            flush_threshold: DEFAULT_CONTAINER_BUFFER_BYTES,
            start_unix_nanos: None,
            last_unix_nanos: None,
            object_count: 0,
            uncompressed_size: 0,
        })
    }

    /// If `start_unix_nanos` is not yet set, set it to `candidate`
    /// and return that; otherwise return the existing value. The
    /// caller is responsible for ms-flooring `candidate` so the
    /// SYSTEMTIME-encoded start round-trips losslessly (see
    /// [`BlfCaptureWriter::append`] for that detail).
    pub fn set_start_if_unset(&mut self, candidate: u64) -> u64 {
        *self.start_unix_nanos.get_or_insert(candidate)
    }

    /// Append one already-encoded inner object's bytes. Caller is
    /// responsible for producing a complete object (base header +
    /// extension + body) — including computing the relative
    /// per-event timestamp against [`Self::set_start_if_unset`]'s
    /// returned start. We just append, track stats, and flush when
    /// the buffer hits the threshold.
    pub fn append_object(
        &mut self,
        object_bytes: &[u8],
        event_timestamp_unix_nanos: u64,
    ) -> io::Result<()> {
        self.last_unix_nanos = Some(event_timestamp_unix_nanos);
        self.buffer.extend_from_slice(object_bytes);
        // 4-byte object padding inside the inflated stream — same
        // formula the reader uses to skip past it.
        let padding = object_bytes.len() % 4;
        if padding != 0 {
            self.buffer.resize(self.buffer.len() + padding, 0);
        }
        self.object_count = self.object_count.saturating_add(1);
        self.uncompressed_size = self
            .uncompressed_size
            .saturating_add((object_bytes.len() + padding) as u64);
        if self.buffer.len() >= self.flush_threshold {
            self.flush_container()?;
        }
        Ok(())
    }

    /// Snapshot of the earliest event timestamp seen so far (ns
    /// since UNIX epoch). Used by the higher-level adapter to
    /// compute per-event relative timestamps.
    pub fn start_unix_nanos(&self) -> Option<u64> {
        self.start_unix_nanos
    }

    /// Flush the current scratch buffer as one `LOG_CONTAINER` to
    /// disk. No-op if the buffer is empty.
    pub fn flush_container(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let bytes = log_container::encode(&self.buffer, COMPRESSION_ZLIB).map_err(|e| {
            io::Error::other(format!("LOG_CONTAINER encode: {e}"))
        })?;
        self.file.write_all(&bytes)?;
        self.buffer.clear();
        Ok(())
    }

    /// Flush, finalise, and update the `FileStatistics` header in
    /// place. After this returns the file is a complete, valid BLF.
    // `expect` is unreachable: 144 fits in u32 trivially.
    #[allow(clippy::missing_panics_doc)]
    pub fn finish(mut self) -> io::Result<u64> {
        self.flush_container()?;
        let file_size = self.file.seek(SeekFrom::End(0))?;
        let stats = FileStatistics {
            statistics_size: u32::try_from(FILE_STATISTICS_MIN_BYTES)
                .expect("144 fits in u32"),
            // application_id 5 matches what blf_asc has historically
            // stamped; keeps third-party readers consuming our files
            // with no surprises.
            api_number: 0,
            application_id: 5,
            compression_level: 0,
            application_major: 0,
            application_minor: 0,
            file_size,
            uncompressed_file_size: self.uncompressed_size,
            object_count: self.object_count,
            application_build: 0,
            measurement_start_time: SystemTime::from_unix_nanos(
                self.start_unix_nanos.unwrap_or(0),
            ),
            last_object_time: SystemTime::from_unix_nanos(self.last_unix_nanos.unwrap_or(0)),
            restore_points_offset: 0,
        };
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(&stats.encode())?;
        self.file.flush()?;
        Ok(file_size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::can::{build_can_message2, encode_can_message2};
    use crate::format::reader::{BlfObject, BlfReader};

    #[test]
    fn writes_a_minimal_empty_blf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.blf");
        let writer = BlfFileWriter::create(&path).unwrap();
        let size = writer.finish().unwrap();
        assert_eq!(size, FILE_STATISTICS_MIN_BYTES as u64);
        // The just-written file parses (it has just the header).
        let reader = BlfReader::open(&path).unwrap();
        assert_eq!(
            reader.file_statistics().statistics_size as usize,
            FILE_STATISTICS_MIN_BYTES,
        );
    }

    /// Write a handful of `CAN_MESSAGE2` objects, read them back
    /// with the native reader, and confirm the on-disk content
    /// round-trips. The per-event timestamps need to be relative
    /// to `start_unix_nanos` so the reader's absolute-recovery
    /// works the same way.
    #[test]
    fn writes_can_message2_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("native.blf");
        let mut writer = BlfFileWriter::create(&path).unwrap();
        let base_ns = 1_700_000_000_u64 * 1_000_000_000;
        for i in 0u32..32 {
            let abs_ns = base_ns + u64::from(i) * 1_000_000;
            // ms-floor the candidate so SYSTEMTIME round-trips.
            let start = writer.set_start_if_unset((abs_ns / 1_000_000) * 1_000_000);
            let rel_ns = abs_ns - start;
            let m = build_can_message2(
                rel_ns,
                /* channel (1-based on disk) */ 1,
                /* flags */ 0,
                /* dlc */ 2,
                /* id_raw */ 0x100 + i,
                vec![u8::try_from(i & 0xFF).unwrap(), 0xCC],
            );
            let bytes = encode_can_message2(&m);
            writer.append_object(&bytes, abs_ns).unwrap();
        }
        writer.finish().unwrap();

        let mut reader = BlfReader::open(&path).unwrap();
        let start = reader.start_unix_nanos();
        assert_eq!(
            start, base_ns,
            "header's measurement_start_time should round-trip to ns precision",
        );
        let mut count = 0;
        while let Some(obj) = reader.next_object().unwrap() {
            if let BlfObject::CanMessage2(m) = obj {
                assert_eq!(m.can_id(), 0x100 + count);
                // event.timestamp_ns is relative; adding start
                // gives absolute.
                assert_eq!(
                    m.event.timestamp_ns() + start,
                    base_ns + u64::from(count) * 1_000_000,
                );
                count += 1;
            }
        }
        assert_eq!(count, 32);
    }
}
