//! Tests against the `vector_blf` C++ live oracle.
//!
//! Only compiled when the `vector-blf-oracle` cargo feature is enabled.
//! See ADR 0009 §"Test coverage strategy" source 4 and Phase 9.5
//! Tranche 0 in `plans/phased-implementation.md`.
//!
//! The harness binary is built by `scripts/build-vector-blf-oracle.sh`,
//! which clones Technica's `vector_blf` at a pinned commit and links a
//! small C++ harness against it. Both live under
//! `target/vector-blf-oracle/`; neither is shipped in cannet's runtime
//! binary, so `vector_blf`'s GPL-3.0-or-later licence stays outside
//! cannet's runtime distribution.

#![cfg(feature = "vector-blf-oracle")]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use cannet_blf::BlfCaptureWriter;
use cannet_core::{CanFrame, CanId, Direction};

/// One row of the harness's `list` subcommand output.
#[derive(Debug, Clone)]
struct ObjectListing {
    type_id: u32,
    type_name: String,
    #[allow(dead_code)]
    timestamp_ns: u64,
}

/// Run the build script (idempotent) and return the harness binary path.
fn ensure_harness() -> PathBuf {
    let repo_root = repo_root();
    let script = repo_root.join("scripts/build-vector-blf-oracle.sh");
    let status = Command::new("bash")
        .arg(&script)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .expect("failed to launch build-vector-blf-oracle.sh");
    assert!(status.success(), "vector_blf oracle build script failed");

    let binary = repo_root.join("target/vector-blf-oracle/bin/vector-blf-oracle-harness");
    assert!(
        binary.exists(),
        "oracle harness binary missing after build: {}",
        binary.display()
    );
    binary
}

fn list_objects(harness: &Path, blf: &Path) -> Vec<ObjectListing> {
    let output = Command::new(harness)
        .arg("list")
        .arg(blf)
        .output()
        .expect("failed to invoke oracle harness");
    assert!(
        output.status.success(),
        "oracle list exited {}: stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| {
            let mut cols = line.split('\t');
            let type_id: u32 = cols
                .next()
                .expect("missing typeId")
                .parse()
                .expect("typeId not numeric");
            let type_name = cols.next().expect("missing typeName").to_string();
            let timestamp_ns: u64 = cols
                .next()
                .expect("missing timestamp")
                .parse()
                .expect("timestamp not numeric");
            ObjectListing { type_id, type_name, timestamp_ns }
        })
        .collect()
}

fn repo_root() -> PathBuf {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR unset");
    PathBuf::from(manifest)
        .join("../..")
        .canonicalize()
        .expect("repo root not canonicalisable")
}

/// Smoke test for Tranche 0: a BLF produced by our (current `blf_asc`-
/// backed) writer is readable by the oracle, and the oracle sees the
/// frames we wrote.
///
/// Once Tranche 1 lands the native writer, this test becomes a contract
/// that the new writer also produces oracle-readable output. Failing
/// here means the new writer disagrees with `vector_blf` on the wire
/// format.
// Modern BLF timestamps need to be ≥ 1990-01-01 for blf_asc's
// SYSTEMTIME header to round-trip; same constraint the existing
// unit tests use.
const TS_BASE_NS: u64 = 1_700_000_000 * 1_000_000_000;

#[test]
fn oracle_lists_frames_written_by_our_writer() {
    let harness = ensure_harness();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("smoke.blf");

    let mut writer = BlfCaptureWriter::create(&path).unwrap();
    for i in 0u8..3 {
        let frame = CanFrame::classic(
            TS_BASE_NS + u64::from(i) * 1_000_000,
            0,
            CanId::standard(0x100 + u32::from(i)).unwrap(),
            Direction::Rx,
            vec![i],
        )
        .unwrap();
        writer.append(&frame).unwrap();
    }
    writer.finish().unwrap();

    let listing = list_objects(&harness, &path);
    let frame_rows: Vec<&ObjectListing> = listing
        .iter()
        .filter(|o| matches!(o.type_name.as_str(), "CAN_MESSAGE" | "CAN_MESSAGE2"))
        .collect();
    assert_eq!(
        frame_rows.len(),
        3,
        "oracle should see the 3 frames we wrote; full listing: {listing:#?}",
    );
    // The exact object type the writer emits is an implementation
    // detail of blf_asc today; Tranche 1's native writer will pin it.
    let kind_ids: Vec<u32> = frame_rows.iter().map(|o| o.type_id).collect();
    assert!(
        kind_ids.iter().all(|&id| id == 1 || id == 86),
        "expected CAN_MESSAGE(1) or CAN_MESSAGE2(86), got {kind_ids:?}",
    );
}
