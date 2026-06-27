//! Regression guard for the filtered-scan contention offender (Task 17
//! Slice 2): with a filtered chronological view open, per-bus ingest FPS
//! must stay flat as the buffer grows past ~200k. The diagnosed bug — a
//! scrollbar match-count refresh that re-scanned the whole buffer ~8×/s
//! under the append mutex — drove `fps_retention` (second-half ÷
//! first-half ingest rate) toward 0.5. The fix is two-fold and both
//! parts are exercised here against the real `TraceStore` + scan path:
//!
//! - the scan is chunked, bounding the per-append lock-hold; and
//! - the match-count refresh is **incremental** (O(Δ), modelled by
//!   `scan_loop`), so a growing buffer no longer means a growing scan.
//!
//! This is the deterministic, hand-scheduled counterpart to the gated
//! `fps_retention` metric in the perf baseline.

use cannet_perf_measurement::tracebuffer::{run_with_schedule, TracebufferConfig};
use cannet_perf_measurement::workload::ScheduledMessage;

/// Five ids on the powertrain bus — the `{"bus":"pt"}` predicate matches
/// them all, so the scan does its full matching work every pass.
fn five_id_pt_schedule() -> Vec<ScheduledMessage> {
    [0x100u32, 0x110, 0x200, 0x201, 0x300]
        .into_iter()
        .map(|can_id| ScheduledMessage {
            bus_id: "pt".to_string(),
            bus_name: "Powertrain".to_string(),
            channel: 0,
            can_id,
            extended: false,
            is_fd: false,
            period_ms: 10,
            payload: vec![0u8; 8],
        })
        .collect()
}

#[test]
fn filtered_scan_keeps_ingest_fps_flat_as_the_buffer_grows() {
    let cfg = TracebufferConfig {
        store: cannet_perf_measurement::tracebuffer::StoreKind::Mem,
        target_frames: 200_000,
        // Paced (not flat-out): a real bus coexists with the scan rather
        // than filling the buffer before the scan runs. Matches the
        // baseline config's reasoning.
        ingest_hz: 40_000.0,
        scan: true,
        scan_hz: 8.0,
        predicate: serde_json::json!({ "bus": "pt" }),
    };

    let report = run_with_schedule(five_id_pt_schedule(), &cfg);

    assert!(
        report.frames_ingested >= 200_000,
        "expected the buffer to grow past 200k, got {}",
        report.frames_ingested
    );
    // Incremental, chunked scan → retention stays ~1.0. The diagnosed
    // O(buffer) offender drove it toward 0.5; a generous 0.8 floor flags
    // any reversion while tolerating scheduler noise.
    assert!(
        report.fps_retention >= 0.8,
        "ingest FPS decayed under the filtered scan: retention={:.3} \
         (first_half={:.0}/s second_half={:.0}/s) — the O(buffer) scan \
         offender may have regressed",
        report.fps_retention,
        report.ingest_fps_first_half,
        report.ingest_fps_second_half
    );
}
