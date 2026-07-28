//! Integration coverage for a BLF layout our own writer never
//! produces but real hardware does: the **entire log in one
//! uncompressed `LOG_CONTAINER`**, as emitted by Kvaser embedded
//! loggers (chunking + zlib cost RAM/CPU an embedded recorder skips).
//!
//! Such a file is valid per Vector's spec; the only thing it exposed
//! was the reader's per-object front-drain of the carry-over buffer,
//! which is O(objects × payload) — quadratic when one container holds
//! the whole log, turning a ~1 s load into minutes. This test rebuilds
//! a real example BLF into that shape and asserts the reader returns
//! byte-identical frames. A regression to front-draining would stall
//! this test rather than fail it.

use std::path::{Path, PathBuf};

use cannet_blf::format::header::{FileStatistics, FILE_STATISTICS_MIN_BYTES};
use cannet_blf::format::log_container::{self, COMPRESSION_NONE};
use cannet_blf::format::object::{object_type, ObjectHeaderBase, OBJECT_HEADER_BASE_BYTES};
use cannet_blf::BlfCanFrameSource;
use cannet_core::{CanFrame, CanFrameSource};

fn example_blf() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/cannet-demo.blf")
}

fn read_all_frames(path: &Path) -> Vec<CanFrame> {
    let mut src = BlfCanFrameSource::open(path).unwrap();
    let mut frames = Vec::new();
    while let Some(f) = src.next_frame().unwrap() {
        frames.push(f);
    }
    frames
}

/// Extract the concatenated inner-object stream (every top-level
/// `LOG_CONTAINER`, inflated) from a valid BLF `src`, plus its verbatim
/// `FileStatistics` header bytes.
fn header_and_inner_stream(src: &[u8]) -> (&[u8], Vec<u8>) {
    let stats = FileStatistics::parse(&src[..FILE_STATISTICS_MIN_BYTES]).unwrap();
    let header_len = stats.statistics_size as usize;
    let mut inner = Vec::new();
    let mut pos = header_len;
    while pos + OBJECT_HEADER_BASE_BYTES <= src.len() {
        let base = ObjectHeaderBase::parse(&src[pos..]).unwrap();
        let obj_size = base.object_size as usize;
        if base.object_type == object_type::LOG_CONTAINER {
            let container = log_container::decode(&src[pos..pos + obj_size]).unwrap();
            inner.extend_from_slice(&container.uncompressed_payload);
        }
        pos += usize::try_from(base.advance_bytes()).unwrap();
    }
    (&src[..header_len], inner)
}

/// Rebuild a BLF whose whole log lives in ONE uncompressed
/// `LOG_CONTAINER` — the Kvaser layout. `inner` (an object stream) is
/// wrapped once; the original `header` is reused verbatim.
fn wrap_single_uncompressed_container(header: &[u8], inner: &[u8]) -> Vec<u8> {
    let container = log_container::encode(inner, COMPRESSION_NONE).unwrap();
    let mut out = Vec::with_capacity(header.len() + container.len());
    out.extend_from_slice(header);
    out.extend_from_slice(&container);
    out
}

/// A real example BLF, re-wrapped into a single uncompressed container,
/// must read back byte-identically. The inner object stream is repeated
/// until the lone container is several MB so a regression to per-object
/// front-draining (O(objects × payload)) stalls this test instead of
/// passing it — the small demo file alone is too small to be slow.
#[test]
fn reader_streams_a_single_uncompressed_container_identically() {
    let src_path = example_blf();
    let base_frames = read_all_frames(&src_path);
    assert!(!base_frames.is_empty(), "demo BLF should contain frames");

    let src_bytes = std::fs::read(&src_path).unwrap();
    let (header, inner) = header_and_inner_stream(&src_bytes);

    // Repeat the object stream up to ~8 MiB: big enough that the
    // quadratic front-drain would take minutes, trivial once linear.
    let copies = (8 * 1024 * 1024 / inner.len().max(1)).max(1);
    let mut big_inner = Vec::with_capacity(inner.len() * copies);
    for _ in 0..copies {
        big_inner.extend_from_slice(&inner);
    }
    let reformatted = wrap_single_uncompressed_container(header, &big_inner);

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("single_container.blf");
    std::fs::write(&dest, &reformatted).unwrap();

    let roundtrip = read_all_frames(&dest);
    assert_eq!(
        roundtrip.len(),
        base_frames.len() * copies,
        "every repeated frame should survive the single-container round-trip"
    );
    // The stream is `base_frames` repeated `copies` times, in order.
    for (i, frame) in roundtrip.iter().enumerate() {
        assert_eq!(frame, &base_frames[i % base_frames.len()]);
    }
}
