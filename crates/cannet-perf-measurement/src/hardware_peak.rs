//! Hardware-PEAK mode — full stack via the python-can sidecar + real PEAK hardware.
//!
//! Spawns the sidecar, enumerates its interfaces, and drives the workload
//! over real CAN: the schedule is transmitted on one PEAK adapter and
//! read back on the other (the two adapters are physically bridged — the
//! `examples/ev-demo` bench topology), then fed into the model while the
//! same filtered scan contends. This is the only mode that exercises the
//! driver and the wire end to end; it needs hardware, so it can't run in
//! CI. Reuses the grpc mode's wire ingest / transmit loops — only the frame
//! source (sidecar + hardware vs in-process virtual bus) differs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cannet_client::{connect_and_subscribe, list_interfaces, PreSubscribeConfig, Subscription};
use cannet_gui_lib::trace_store::TraceStore;

use crate::runner::{build_report, current_rss_mb, parse_predicate, scan_loop, HarnessReport, RunParams};
use crate::sidecar::SidecarProcess;
use crate::LoadedExample;

/// Hardware-PEAK-mode run parameters.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HardwarePeakConfig {
    /// Stop once the receiver has stored this many frames.
    pub target_frames: usize,
    /// Transmit pace, frames/s (the offered bus load). `0` = flat-out.
    pub tx_hz: f64,
    /// Bus bit rate to configure the PEAK interfaces at.
    pub speed_bps: u64,
    /// Run the contending filtered scan.
    pub scan: bool,
    /// Full-scan rate, Hz.
    pub scan_hz: f64,
    /// Filter predicate the scan evaluates, as JSON.
    pub predicate: serde_json::Value,
}

impl Default for HardwarePeakConfig {
    fn default() -> Self {
        Self {
            target_frames: 20_000,
            tx_hz: 1_000.0,
            speed_bps: 500_000,
            scan: true,
            scan_hz: 8.0,
            predicate: serde_json::json!({ "bus": "pt" }),
        }
    }
}

/// Run the hardware-peak workload against real PEAK hardware.
///
/// # Errors
/// Returns a message if the sidecar won't start, no PEAK interface is
/// enumerated, or the session can't be opened.
///
/// # Panics
/// Panics if a worker thread panics (e.g. the trace store mutex is
/// poisoned).
pub fn run(ex: &LoadedExample, cfg: &HardwarePeakConfig) -> Result<HarnessReport, String> {
    let schedule = Arc::new(crate::workload::build_schedule(ex));
    let bus_by_id: Arc<std::collections::HashMap<u32, String>> = Arc::new(
        schedule
            .iter()
            .map(|m| (m.can_id, m.bus_id.clone()))
            .collect(),
    );

    let sidecar = SidecarProcess::spawn()?;
    let address = sidecar.address().to_string();

    // Enumerate interfaces (async one-shot) and pick the PEAK adapters.
    let rt = tokio::runtime::Runtime::new().map_err(|e| format!("tokio runtime: {e}"))?;
    let interfaces = rt
        .block_on(list_interfaces(&address))
        .map_err(|e| format!("list_interfaces: {e}"))?;
    drop(rt);
    let pcans: Vec<String> = interfaces
        .into_iter()
        .filter(|i| i.id.starts_with("pcan"))
        .map(|i| i.id)
        .collect();
    if pcans.is_empty() {
        return Err("no PEAK (pcan:*) interfaces enumerated — is the hardware connected?".into());
    }
    let tx_iface = pcans[0].clone();
    let rx_iface = pcans.get(1).cloned().unwrap_or_else(|| tx_iface.clone());

    // Open both adapters at the configured bit rate. The receiver reads
    // the looped-back frames on `rx_iface`; we transmit on `tx_iface`.
    let pre = PreSubscribeConfig {
        speed_bps: cfg.speed_bps,
        fd_enabled: false,
        fd_data_speed_bps: 0,
    };
    let mut subs = vec![Subscription::new(&rx_iface, 0).with_config(pre)];
    if rx_iface != tx_iface {
        subs.push(Subscription::new(&tx_iface, 1).with_config(pre));
    }
    let session =
        connect_and_subscribe(&address, subs).map_err(|e| format!("session connect: {e}"))?;
    let (handle, mut recv, transmitter) = session.into_parts();

    let store = Arc::new(TraceStore::new());
    store.start_session(0);
    let stop = Arc::new(AtomicBool::new(false));
    let rss_start = current_rss_mb();

    let tx = {
        let schedule = schedule.clone();
        let stop = stop.clone();
        let tx_hz = cfg.tx_hz;
        let tx_iface = tx_iface.clone();
        std::thread::spawn(move || {
            crate::grpc::tx_loop(&transmitter, &tx_iface, &schedule, &stop, tx_hz);
        })
    };

    let scan = if cfg.scan {
        let store = store.clone();
        let stop = stop.clone();
        let predicate = parse_predicate(&cfg.predicate);
        let hz = cfg.scan_hz;
        Some(std::thread::spawn(move || {
            scan_loop(&store, &stop, &predicate, hz)
        }))
    } else {
        None
    };

    let ingest_out = crate::grpc::rx_ingest(&mut recv, &store, &bus_by_id, cfg.target_frames);
    stop.store(true, Ordering::Relaxed);

    let _ = tx.join();
    let scan_durations = scan
        .map(|h| h.join().expect("scan thread panicked"))
        .unwrap_or_default();
    let rss_end = current_rss_mb();

    handle.shutdown();
    drop(sidecar);

    Ok(build_report(
        &RunParams {
            mode: "hardware-peak",
            scan: cfg.scan,
            scan_hz: cfg.scan_hz,
            ingest_hz: cfg.tx_hz,
            predicate: cfg.predicate.clone(),
            target_frames: cfg.target_frames,
        },
        &ingest_out,
        &scan_durations,
        rss_start,
        rss_end,
    ))
}
