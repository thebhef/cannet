//! Reading a capture whose writer never finalized it.
//!
//! A writer that is killed mid-run leaves the placeholder
//! `FileStatistics` it stamped at open — no object count, no file
//! size, no measurement start — and, if it buffered its writes, a
//! trailing fragment of a record it never finished. The frames before
//! that fragment are intact and recoverable, and recovering them must
//! not write a single byte back to the file.

use cannet_blf::{scan_blf, BlfCanFrameSource, BlfCaptureWriter};
use cannet_core::{CanFrame, CanFramePayload, CanFrameSource as _, CanId, Direction};
use std::path::{Path, PathBuf};

const BASE_NS: u64 = 1_700_000_000_u64 * 1_000_000_000;
/// Enough frames to fill several 128 KiB `LOG_CONTAINER`s, so an
/// abandoned writer has whole containers on disk and a partial buffer
/// in memory.
const FRAMES: u64 = 20_000;

fn frame(i: u64) -> CanFrame {
    CanFrame::classic(
        BASE_NS + i * 1_000_000,
        0,
        CanId::standard(0x100 + u32::try_from(i % 0x100).unwrap()).unwrap(),
        Direction::Rx,
        vec![1, 2, 3, 4, 5, 6, 7, 8],
    )
    .unwrap()
}

/// Everything about a frame that survives an unset measurement start —
/// the wall clock does not, so timestamps are compared separately.
type FramePrint = (u8, u32, CanFramePayload);

fn prints(path: &Path) -> Vec<FramePrint> {
    let mut source = BlfCanFrameSource::open(path).expect("a recoverable capture opens");
    let mut out = Vec::new();
    while let Some(f) = source.next_frame().expect("the walk does not fail") {
        out.push((f.channel, f.id.raw(), f.payload.clone()));
    }
    out
}

/// A capture written and finalised the normal way.
fn finalised(dir: &Path) -> PathBuf {
    let path = dir.join("finalised.blf");
    let mut w = BlfCaptureWriter::create(&path).unwrap();
    for i in 0..FRAMES {
        w.append(&frame(i)).unwrap();
    }
    w.finish().unwrap();
    path
}

/// A capture whose writer was abandoned mid-run: the same appends, then
/// the writer is leaked so neither `finish` nor `Drop` runs — what a
/// hard kill leaves at `<dest>.part`.
fn abandoned(dir: &Path, name: &str) -> PathBuf {
    let dest = dir.join(name);
    let mut w = BlfCaptureWriter::create(&dest).unwrap();
    for i in 0..FRAMES {
        w.append(&frame(i)).unwrap();
    }
    std::mem::forget(w);
    let part = dir.join(format!("{name}.part"));
    assert!(part.exists(), "the abandoned writer's partial file");
    assert!(!dest.exists(), "nothing is left at the destination");
    part
}

/// `source`, minus its last `lost` bytes — a writer that buffered its
/// output and was killed part-way through a record.
fn torn(source: &Path, dest: &Path, lost: usize) -> PathBuf {
    let mut bytes = std::fs::read(source).unwrap();
    bytes.truncate(bytes.len() - lost);
    std::fs::write(dest, &bytes).unwrap();
    dest.to_path_buf()
}

/// Control: the finalised capture is read the same way, so a later
/// assertion that a damaged one reads is a discrimination and not an
/// accident.
#[test]
fn a_finalised_capture_yields_every_frame() {
    let dir = tempfile::tempdir().unwrap();
    let path = finalised(dir.path());
    let seen = prints(&path);
    assert_eq!(seen.len(), usize::try_from(FRAMES).unwrap());
    let scan = scan_blf(&path).unwrap();
    assert_eq!(scan.frame_count, FRAMES);
    assert!(!scan.unfinalized, "the writer finished this one");
    assert_eq!(scan.truncated_tail_bytes, None, "and left no fragment");
    assert!(!BlfCanFrameSource::open(&path).unwrap().is_unfinalized());
}

#[test]
fn a_capture_whose_writer_never_finalized_yields_the_frames_it_flushed() {
    let dir = tempfile::tempdir().unwrap();
    let control = prints(&finalised(dir.path()));
    let part = abandoned(dir.path(), "killed.blf");

    let seen = prints(&part);
    assert!(
        !seen.is_empty(),
        "the flushed containers are readable despite the placeholder header"
    );
    assert!(seen.len() < control.len(), "the buffered tail is lost");
    assert_eq!(
        seen,
        control[..seen.len()],
        "every frame before the loss is present and unchanged"
    );
    let scan = scan_blf(&part).unwrap();
    assert_eq!(usize::try_from(scan.frame_count).unwrap(), seen.len());
    assert!(scan.unfinalized, "the placeholder header says so");
    assert_eq!(
        scan.truncated_tail_bytes, None,
        "our writer's containers go out whole, so nothing is torn"
    );
    assert!(BlfCanFrameSource::open(&part).unwrap().is_unfinalized());
}

#[test]
fn a_trailing_fragment_ends_the_walk_instead_of_failing_it() {
    let dir = tempfile::tempdir().unwrap();
    let part = abandoned(dir.path(), "killed.blf");
    let whole = prints(&part);

    let mut ever_cost_frames = false;
    for lost in [1usize, 4, 17, 4096] {
        let cut = torn(&part, &dir.path().join(format!("torn-{lost}.blf")), lost);
        let seen = prints(&cut);
        assert!(
            !seen.is_empty(),
            "lost={lost}: the frames before the fragment are kept"
        );
        assert_eq!(
            seen,
            whole[..seen.len()],
            "lost={lost}: what is kept is unchanged"
        );
        let scan = scan_blf(&cut).unwrap_or_else(|e| panic!("lost={lost}: scan failed: {e}"));
        assert_eq!(usize::try_from(scan.frame_count).unwrap(), seen.len());
        // A record's trailing inter-object padding carries no data, so
        // losing only that loses nothing and there is nothing to report.
        // Losing any of the record itself costs frames, and then the
        // fragment is named.
        assert_eq!(
            scan.truncated_tail_bytes.is_some(),
            seen.len() < whole.len(),
            "lost={lost}: a fragment is reported exactly when one cost us frames"
        );
        ever_cost_frames |= seen.len() < whole.len();
    }
    assert!(
        ever_cost_frames,
        "the truncations have to actually damage the file"
    );
}

/// FNV-1a over the file's bytes, so "unchanged" is a digest comparison
/// rather than a claim that no write was attempted.
fn digest(path: &Path) -> (u64, u64) {
    let bytes = std::fs::read(path).unwrap();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in &bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (h, bytes.len() as u64)
}

#[test]
fn recovering_a_damaged_capture_leaves_its_bytes_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let part = abandoned(dir.path(), "killed.blf");
    let cut = torn(&part, &dir.path().join("torn.blf"), 1);

    let before = digest(&cut);
    let _ = prints(&cut);
    let _ = scan_blf(&cut).unwrap();
    let _ = prints(&cut);
    assert_eq!(digest(&cut), before, "recovery is read-only");

    // And no repaired copy appeared beside it.
    let siblings: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n != "killed.blf.part" && n != "torn.blf" && n != "finalised.blf")
        .collect();
    assert!(
        siblings.is_empty(),
        "no companion file was written: {siblings:?}"
    );
}

/// The tolerance is scoped to a trailing fragment. Damage in the middle
/// of the file is still an error — recovering past it would mean
/// guessing where the next record starts.
#[test]
fn damage_that_is_not_a_trailing_fragment_is_still_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let part = abandoned(dir.path(), "killed.blf");
    let mut bytes = std::fs::read(&part).unwrap();
    // Corrupt the second top-level record's `LOBJ` signature. The
    // first container still reads; the walk must not sail past this.
    let first_size = u32::from_le_bytes(bytes[144 + 8..144 + 12].try_into().unwrap()) as usize;
    let second = 144 + first_size + (first_size % 4);
    bytes[second] = b'X';
    let path = dir.path().join("corrupt.blf");
    std::fs::write(&path, &bytes).unwrap();

    let mut source = BlfCanFrameSource::open(&path).unwrap();
    let mut err = None;
    while err.is_none() {
        match source.next_frame() {
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(e) => err = Some(e),
        }
    }
    assert!(
        err.is_some(),
        "a corrupt record in the middle of the file is not a recoverable tail"
    );
}
