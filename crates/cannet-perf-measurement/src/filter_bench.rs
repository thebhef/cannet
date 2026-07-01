//! Filter-index characterization — does the host actually get O(page)
//! filtered fetches from the materialized filter index (ADR 0002 DS-3)?
//!
//! The `tracebuffer` mode's continuous scan measures the *incremental
//! count* refresh, which is already O(Δ) and so doesn't exercise the
//! filter index. The index's win is the **positional page fetch**: the
//! scan path re-scans `[0, offset]` to place a page (O(buffer)), while
//! the index pages in O(page) after a one-time build.
//!
//! This mode fills a real `TraceStore` (the in-RAM or disk-spill store),
//! resolves the predicate to its by-id candidate set
//! (`filter::resolve_candidates`), then times a deep positional page
//! three ways: the full forward scan (today's path), the one-time index
//! build, and the per-fetch index page. It is the harness driving the
//! genuine model surface — `TraceStore::refresh_filter_index` +
//! `FilterIndex::page` — not a microbenchmark of the bare store.

use std::sync::Arc;
use std::time::Instant;

use cannet_core::{CanFramePayload, Direction};
use cannet_gui_lib::filter::{resolve_candidates, CandidateInputs, FilterPredicate};
use cannet_gui_lib::trace_store::{RawTraceFrame, TraceStore};
use cannet_spill::FilterIndex;

use crate::tracebuffer::StoreKind;
use crate::workload::{self, ScheduledMessage};
use crate::LoadedExample;

/// One filter-bench run's parameters.
pub struct FilterBenchConfig {
    pub store: StoreKind,
    /// Frames to fill the store with before measuring.
    pub frames: usize,
    /// Predicate to filter by (JSON). Restricted to non-decode predicates
    /// (`bus` / `id_range` / `id_list`) so the `keep` test needs no DBC.
    pub predicate: serde_json::Value,
    /// Page offset (in match-positions) to fetch — use a deep one to show
    /// the scan path's O(offset) cost.
    pub offset: usize,
    /// Page size.
    pub limit: usize,
}

/// What the bench measured.
#[derive(Debug, serde::Serialize)]
pub struct FilterBenchReport {
    pub store: &'static str,
    pub frames: usize,
    pub predicate: serde_json::Value,
    /// Total frames matching the predicate.
    pub matches: usize,
    pub offset: usize,
    pub limit: usize,
    /// Full forward scan to count matches and materialize the page —
    /// today's positioned-fetch cost, paid on every scroll (O(buffer)).
    pub scan_positional_ms: f64,
    /// One-time filter-index build (O(matches) for a selective predicate;
    /// ~O(buffer) for a permissive one, but paid once).
    pub index_build_ms: f64,
    /// Per-fetch index page after the build — the steady cost (O(page)).
    pub index_page_us: f64,
}

/// Run the filter-index bench and return its report.
///
/// # Panics
/// Panics if the disk store can't open a scratch dir, or if the predicate
/// is not id-narrowable (the bench requires a narrowable predicate).
#[must_use]
pub fn run(ex: &LoadedExample, cfg: &FilterBenchConfig) -> FilterBenchReport {
    let templates = workload::build_schedule(ex);
    let scratch = match cfg.store {
        StoreKind::Mem => None,
        StoreKind::Disk => Some(tempfile::TempDir::new().expect("scratch tempdir")),
    };
    let store = Arc::new(match &scratch {
        None => TraceStore::new(),
        Some(dir) => TraceStore::new_disk(dir.path()).expect("open disk store"),
    });
    store.start_session(0);
    fill(&store, &templates, cfg.frames);

    let predicate: FilterPredicate =
        serde_json::from_value(cfg.predicate.clone()).expect("predicate parses");

    // Resolve the predicate's candidate id set against the filled store.
    let seen = store.seen_bus_ids();
    let mut seen_ids: Vec<(u32, bool)> = seen.iter().map(|(_, id, ext)| (*id, *ext)).collect();
    seen_ids.sort_unstable();
    seen_ids.dedup();
    let seen_on_bus = |b: &str| -> Vec<(u32, bool)> {
        seen.iter()
            .filter(|(bus, _, _)| bus.as_deref() == Some(b))
            .map(|(_, id, ext)| (*id, *ext))
            .collect()
    };
    let none = |_: &str| Vec::new();
    let inputs = CandidateInputs {
        seen_ids: &seen_ids,
        seen_on_bus: &seen_on_bus,
        regex_ids: &none,
        signal_ids: &none,
    };
    let candidates =
        resolve_candidates(&predicate, &inputs).expect("predicate must be id-narrowable");

    // (1) Full forward scan: count matches and materialize the page —
    // exactly what a positioned filtered fetch does today.
    let t = Instant::now();
    let scan_matches = scan_positional(&store, &predicate, cfg.offset, cfg.limit);
    let scan_positional_ms = ms(t);

    // (2) Filter index: a one-time build, then (3) the per-fetch page.
    let idx_dir = tempfile::TempDir::new().expect("index tempdir");
    let mut index = FilterIndex::new(idx_dir.path()).expect("open filter index");
    let keep = |f: &RawTraceFrame| predicate.matches(f, None);
    let t = Instant::now();
    store.refresh_filter_index(&mut index, &candidates, &keep);
    let index_build_ms = ms(t);

    let t = Instant::now();
    let page = index.page(cfg.offset, cfg.limit);
    let index_page_us = t.elapsed().as_secs_f64() * 1e6;

    assert_eq!(
        index.len(),
        scan_matches,
        "filter index and scan disagree on match count",
    );
    let _ = page;

    FilterBenchReport {
        store: match cfg.store {
            StoreKind::Mem => "mem",
            StoreKind::Disk => "disk",
        },
        frames: store.len(),
        predicate: cfg.predicate.clone(),
        matches: index.len(),
        offset: cfg.offset,
        limit: cfg.limit,
        scan_positional_ms,
        index_build_ms,
        index_page_us,
    }
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

/// Append `target` frames by cycling the schedule, flat out.
fn fill(store: &TraceStore, templates: &[ScheduledMessage], target: usize) {
    const BASE_TS: u64 = 1_000_000_000;
    for i in 0..target {
        let t = &templates[i % templates.len()];
        store.append(RawTraceFrame {
            timestamp_ns: BASE_TS + i as u64,
            channel: t.channel,
            id: t.can_id,
            extended: t.extended,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(t.payload.clone()),
            bus_id: Some(t.bus_id.clone()),
        });
    }
}

/// Emulate today's positioned filtered fetch: scan the whole buffer in
/// chunks, count matches, and (incidentally) collect the page at
/// `[offset, offset + limit)`. Returns the total match count.
fn scan_positional(
    store: &TraceStore,
    predicate: &FilterPredicate,
    offset: usize,
    limit: usize,
) -> usize {
    const CHUNK: usize = 8192;
    let len = store.len();
    let mut count = 0usize;
    let mut page = Vec::new();
    let mut pos = 0;
    while pos < len {
        let hi = (pos + CHUNK).min(len);
        for idx in store.scan_chunk(pos, hi, |f| predicate.matches(f, None)) {
            if count >= offset && count < offset + limit {
                page.push(idx);
            }
            count += 1;
        }
        pos = hi;
    }
    let _ = page;
    count
}
