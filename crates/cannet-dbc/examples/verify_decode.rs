//! Reads the demo BLF through cannet-blf, decodes against cannet-demo.dbc
//! using cannet-dbc, and prints a per-message summary plus a few decoded
//! frames per ID. This is a script, not a long-lived integration test —
//! it lives next to the fixture so anyone editing the fixture can re-run
//! it as a sanity check.
//!
//!     cargo run --example verify_decode

use std::collections::BTreeMap;
use std::path::Path;

use cannet_blf::BlfCanFrameSource;
use cannet_core::CanFrameSource;
use cannet_dbc::Database;

fn main() -> anyhow::Result<()> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let blf = workspace.join("examples").join("cannet-demo.blf");
    let dbc = workspace.join("examples").join("cannet-demo.dbc");

    let dbc_text = std::fs::read_to_string(&dbc)?;
    let db = Database::parse(&dbc_text).map_err(|e| anyhow::anyhow!("dbc: {e}"))?;
    let mut src = BlfCanFrameSource::open(&blf)?;

    let mut counts: BTreeMap<u32, usize> = BTreeMap::new();
    let mut samples: BTreeMap<u32, Vec<String>> = BTreeMap::new();
    let mut total = 0usize;

    while let Some(frame) = src.next_frame()? {
        total += 1;
        *counts.entry(frame.id.raw()).or_default() += 1;
        if let Some(decoded) = db.decode(&frame) {
            let entry = samples.entry(frame.id.raw()).or_default();
            if entry.len() < 2 {
                let signals = decoded
                    .signals
                    .iter()
                    .map(|s| format!("{}={:.4}{}", s.name, s.value, s.unit))
                    .collect::<Vec<_>>()
                    .join(" ");
                #[allow(clippy::cast_precision_loss)]
                let t_seconds = frame.timestamp_ns as f64 / 1e9;
                entry.push(format!(
                    "t={t_seconds:.3}s {}: {signals}",
                    decoded.name
                ));
            }
        }
    }

    println!("Total frames: {total}");
    println!("Per-ID counts:");
    for (id, n) in &counts {
        println!("  {id:#010x}: {n}");
    }
    println!();
    for (id, lines) in &samples {
        println!("Sample decoded frames for {id:#010x}:");
        for l in lines {
            println!("  {l}");
        }
    }
    Ok(())
}
