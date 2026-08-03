//! Trace-query commands: the paged views over the trace store.
//!
//! Everything the frontend uses to render a trace *view* into the
//! host-side model (ADR 0025 / ADR 0002 DS-3): the chronological range
//! fetch and its filter, the by-id snapshot page and its host-side
//! column sort, the latest-per-signal snapshot page, and the filtered
//! chronological view backed by the materialized `ActiveFilterIndex`.
//! Also the time→index anchoring commands (`frame_indices_at_ns` /
//! `filtered_positions_at_ns`, ADR 0024 / ADR 0035).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use cannet_core::CanId;
use cannet_dbc::Database;

use crate::app_state::{AppState, LoadedDbc};
use crate::dbc_commands::decode_against;
use crate::filter::{self, DecodeDependentLeaf, FilterPredicate};
use crate::ipc::{
    self, ByIdSnapshot, FilteredTracePage, RowPage, SignalSelection, SignalSnapshotRecord,
    TraceFrameRecord,
};
use crate::signal_snapshot;
use crate::trace_store::{self, RawTraceFrame, TraceStore};


/// Pull a `[start, end)` slice out of the trace store and decode each
/// frame against the loaded DBCs (first that matches wins). Shared by
/// the `fetch_trace_range` command (trace-view scrolling) and the
/// `trace-grew` tail (auto-scroll live tail). Out-of-range or
/// oversized ranges clamp to what's stored, matching [`TraceStore::slice`].
pub(crate) fn collect_trace_records(state: &AppState, start: u64, end: u64) -> Vec<TraceFrameRecord> {
    let start_us = usize::try_from(start).unwrap_or(usize::MAX);
    let end_us = usize::try_from(end).unwrap_or(usize::MAX);
    let raw = state.trace_store.slice(start_us, end_us);
    let dbs = state.databases();
    let violations: std::collections::HashMap<u64, &'static str> = state
        .verifier
        .violations_in(start, end)
        .into_iter()
        .collect();
    raw.into_iter()
        .enumerate()
        .map(|(i, frame)| {
            #[allow(clippy::cast_possible_truncation)]
            let absolute_index = start + i as u64;
            let decoded = decode_against(&dbs, &frame);
            let mut record = TraceFrameRecord::from_raw(absolute_index, &frame, decoded);
            record.violation = violations.get(&absolute_index).copied();
            record
        })
        .collect()
}


/// Resolve `filter`'s decode-dependent leaves against the loaded DBCs
/// into the set of arbitration ids whose decode could change the
/// predicate's verdict — the *decode candidates*. A `name_regex` leaf
/// contributes every id whose message name matches in any DBC; a
/// `signal_equals` leaf contributes every id whose message carries a
/// signal with that name.
///
/// For a frame whose id is outside the set, no DBC decodes it to a
/// matching name / signal, so the decode-dependent leaves evaluate
/// false with or without the decode and the raw leaves never read it —
/// skipping the decode cannot change the scan's result. This is what
/// keeps `fetch_filtered_trace`'s repeated full-window scans from
/// decoding every frame in the session: the per-frame decode gate
/// collapses to a set lookup, and only actual candidates pay for a
/// decode. The set is keyed on the raw id alone (standard/extended
/// collisions just decode a few extra frames — a harmless superset).
pub(crate) fn decode_candidate_ids(dbs: &[LoadedDbc], filter: &FilterPredicate) -> HashSet<u32> {
    let leaves = filter.decode_dependent_leaves();
    let mut out = HashSet::new();
    if leaves.is_empty() {
        return out;
    }
    for d in dbs {
        for (id, _extended, name) in d.db.message_names() {
            let hit = leaves.iter().any(|l| {
                matches!(l, DecodeDependentLeaf::MessageNameRegex(p)
                    if filter::regex_match(p, name))
            });
            if hit {
                out.insert(id);
            }
        }
        for (id, _extended, sig) in d.db.signal_names() {
            let hit = leaves
                .iter()
                .any(|l| matches!(l, DecodeDependentLeaf::SignalName(n) if *n == sig));
            if hit {
                out.insert(id);
            }
        }
    }
    out
}

/// Pull a `[start, end)` slice out of the trace store and decode each
/// frame against the currently-attached DBC. The caller is expected to
/// be the trace view, sizing `end - start` to the visible window plus a
/// small prefetch pad.
///
/// `filter` is the consumer's optional [`FilterPredicate`]
/// (a filter element's predicate, evaluated post-decode). Frames that
/// don't pass are dropped from the returned vec — the consumer sees a
/// pre-filtered slice. The frontend already keys its row cache on the
/// raw absolute index, so a filtered slice is just a denser stream of
/// rows over the same window.
///
/// `async` so Tauri runs it off the main thread: under a fast replay
/// the pump thread takes the trace-store lock thousands of times a
/// second, so the clone-and-decode here can stall briefly — keeping it
/// off the UI thread keeps the window (and `disconnect`) responsive.
#[tauri::command]
#[allow(clippy::unused_async)] // `async` is what makes Tauri run it off the main thread
pub(crate) async fn fetch_trace_range(
    app: AppHandle,
    start: u64,
    end: u64,
    filter: Option<FilterPredicate>,
) -> Vec<TraceFrameRecord> {
    let state: State<'_, AppState> = app.state();
    let records = collect_trace_records(state.inner(), start, end);
    apply_filter_records(records, filter.as_ref())
}

/// Drop the records that don't pass `predicate`. The `Option` shape is
/// the "no filter wired" path; this just returns the vec unchanged.
pub(crate) fn apply_filter_records(
    records: Vec<TraceFrameRecord>,
    predicate: Option<&FilterPredicate>,
) -> Vec<TraceFrameRecord> {
    let Some(p) = predicate else { return records };
    // The fetch-path's decoded `TraceFrameRecord` doesn't carry a raw
    // `RawTraceFrame`; build a thin facade so the predicate's `matches`
    // can read the fields it needs (id / bus_id / decoded).
    records
        .into_iter()
        .filter(|r| record_matches(p, r))
        .collect()
}

/// Evaluate a predicate against an already-decoded record — the fetch
/// path holds a `TraceFrameRecord`, so it reads the `(id, bus, decoded)`
/// view the predicate needs directly instead of fabricating a
/// `RawTraceFrame`.
fn record_matches(predicate: &FilterPredicate, record: &TraceFrameRecord) -> bool {
    predicate.matches_fields(record.id, record.bus_id.as_deref(), record.decoded.as_ref())
}

/// Sort key for the by-id "bus" column: the project bus *name* (so the
/// on-screen order matches what the user reads), the raw bus id when the
/// project doesn't know it (defensive — a removed bus), or `"~"` for an
/// unassigned frame so it sorts after any real bus name ascending.
/// Mirrors the former client-side `sortValue` "bus" case, moved host-side
/// with the rest of the by-id sort.
///
/// Borrows rather than allocating, like [`ecu_sort_key`] and
/// [`kind_sort_key`] — it is called twice per comparison of an
/// `O(n log n)` sort.
fn bus_sort_key<'a>(bus_id: Option<&'a str>, names: &'a HashMap<String, String>) -> &'a str {
    match bus_id {
        None => "~",
        Some(id) => names.get(id).map_or(id, String::as_str),
    }
}

/// The `ecu` column's sort key — the decoded message's transmitter.
/// Undecoded rows and the `Vector__XXX` "no sender" placeholder sort
/// after any real ECU ascending, same convention as [`bus_sort_key`].
fn ecu_sort_key(f: &TraceFrameRecord) -> &str {
    f.decoded
        .as_ref()
        .and_then(|d| d.transmitter.as_deref())
        .unwrap_or("~")
}

/// The `kind` column's sort key — the frame-kind discriminant, matching
/// the `snake_case` tag the frontend column shows.
fn kind_sort_key(kind: &ipc::CanFrameKind) -> &'static str {
    match kind {
        ipc::CanFrameKind::Classic => "classic",
        ipc::CanFrameKind::Fd { .. } => "fd",
        ipc::CanFrameKind::Remote { .. } => "remote",
        ipc::CanFrameKind::Error => "error",
    }
}

/// Compare two by-id rows by one column's value — the host-side
/// equivalent of the former client `sortValue` / `compareValues`
/// (traceColumns.ts). An unknown key compares equal (leaves the order).
fn by_id_cmp(
    a: &ByIdSnapshot,
    b: &ByIdSnapshot,
    key: &str,
    names: &HashMap<String, String>,
) -> std::cmp::Ordering {
    let (fa, fb) = (&a.frame, &b.frame);
    match key {
        "rate" => a.rate.total_cmp(&b.rate),
        "idx" => fa.index.cmp(&fb.index),
        "time" => fa.timestamp_seconds.total_cmp(&fb.timestamp_seconds),
        "bus" => bus_sort_key(fa.bus_id.as_deref(), names)
            .cmp(bus_sort_key(fb.bus_id.as_deref(), names)),
        "dir" => fa.direction.cmp(fb.direction),
        "id" => fa.id.cmp(&fb.id),
        "kind" => kind_sort_key(&fa.kind).cmp(kind_sort_key(&fb.kind)),
        "len" => fa.data.len().cmp(&fb.data.len()),
        "data" => fa.data.cmp(&fb.data),
        "msg" => {
            let na = fa.decoded.as_ref().map_or("", |d| d.name.as_str());
            let nb = fb.decoded.as_ref().map_or("", |d| d.name.as_str());
            na.cmp(nb)
        }
        "ecu" => ecu_sort_key(fa).cmp(ecu_sort_key(fb)),
        _ => std::cmp::Ordering::Equal,
    }
}

/// Sort by-id rows host-side per the panel's column sort, so a *paged*
/// by-id view orders the whole set rather than each page in isolation
/// (ADR 0025). `key` / `dir` are the `ColumnKey` and direction the panel
/// sends; a `None` key leaves the `latest_in_window` default order (by
/// bus, channel, id). Replaces the former client-side `sortRows`. Stable,
/// so equal keys keep the default order — including under `desc`.
pub(crate) fn sort_by_id(
    rows: &mut [ByIdSnapshot],
    key: Option<&str>,
    dir: Option<&str>,
    names: &HashMap<String, String>,
) {
    let Some(key) = key else { return };
    let desc = dir == Some("desc");
    rows.sort_by(|a, b| {
        let c = by_id_cmp(a, b, key, names);
        if desc {
            c.reverse()
        } else {
            c
        }
    });
}

/// A *paged* by-id snapshot of the trace window `[scan_start, scan_end)`:
/// one row per arbitration id, its latest in-window frame decoded against
/// the loaded DBCs (paired with the id's rate and session frame count),
/// optionally constrained by `filter`, sorted host-side per
/// `sort_key` / `sort_dir`, returned as the page `[offset, offset+limit)`
/// of a [`RowPage`] (ADR 0025). The by-id view pages this through the
/// same windowed-source primitive as the chronological views — there is
/// no separate whole-snapshot path. `bus_names` carries the project's bus
/// id→name map so the "bus" column sorts by the name the user sees (the
/// host knows only bus ids). A count-only refresh passes `limit == 0` and
/// reads just `count`.
///
/// `filter` drops rows whose latest in-window frame doesn't pass the
/// predicate. (As before, this filters the *latest* observation; a row a
/// signal-value filter excludes can re-appear once the id emits a passing
/// value.) Bounding to `scan_end` rather than the live tip is what makes
/// a paused/stopped snapshot reflect the window it shows. `async` so
/// Tauri runs it off the main thread, like the other paged accessors.
#[tauri::command]
#[allow(clippy::unused_async, clippy::too_many_arguments)] // off-thread; args are the IPC payload
pub(crate) async fn fetch_by_id_page(
    app: AppHandle,
    filter: Option<FilterPredicate>,
    scan_start: u64,
    scan_end: u64,
    sort_key: Option<String>,
    sort_dir: Option<String>,
    bus_names: Vec<(String, String)>,
    offset: u64,
    limit: u64,
) -> RowPage<ByIdSnapshot> {
    let state: State<'_, AppState> = app.state();
    let start = usize::try_from(scan_start).unwrap_or(usize::MAX);
    let end = usize::try_from(scan_end).unwrap_or(usize::MAX);
    let rows = state.trace_store.latest_in_window(start, end);
    let mut snaps: Vec<ByIdSnapshot> = {
        let dbs = state.databases();
        rows.into_iter()
            .filter_map(|row| {
                let decoded = decode_against(&dbs, &row.frame);
                let record = TraceFrameRecord::from_raw(
                    u64::try_from(row.index).unwrap_or(u64::MAX),
                    &row.frame,
                    decoded,
                );
                if let Some(p) = filter.as_ref() {
                    if !record_matches(p, &record) {
                        return None;
                    }
                }
                Some(ByIdSnapshot {
                    frame: record,
                    rate: row.rate,
                    count: row.count,
                })
            })
            .collect()
    };
    let names: HashMap<String, String> = bus_names.into_iter().collect();
    sort_by_id(&mut snaps, sort_key.as_deref(), sort_dir.as_deref(), &names);

    let count = u64::try_from(snaps.len()).unwrap_or(u64::MAX);
    let off = usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(snaps.len());
    let lim = usize::try_from(limit).unwrap_or(usize::MAX);
    let page: Vec<ByIdSnapshot> = snaps.into_iter().skip(off).take(lim).collect();
    RowPage {
        count,
        start: u64::try_from(off).unwrap_or(0),
        rows: page,
    }
}

/// A *paged* latest-per-signal snapshot of the trace window
/// `[scan_start, scan_end)` — the signal view's accessor, and the by-id
/// page's per-signal sibling (same ADR 0025 row-page contract). One row
/// per *selected descriptor*, always present: a signal with no
/// in-window update still gets a row, just with blank value/statistics.
/// Selection (manual keys + regex over the ADR 0038 canonical path),
/// sort, and paging all evaluate host-side. `Err` carries an invalid
/// regex's compile error for the panel to surface.
///
/// The DBC panel's live value column calls this too (keys-only
/// selection over its visible slice) — one decode path, one row shape,
/// so the two surfaces cannot drift.
#[tauri::command]
#[allow(
    clippy::unused_async,
    clippy::too_many_arguments,
    clippy::needless_pass_by_value
)]
pub(crate) async fn fetch_signal_page(
    app: AppHandle,
    selection: SignalSelection,
    scan_start: u64,
    scan_end: u64,
    sort_key: Option<String>,
    sort_dir: Option<String>,
    bus_names: Vec<(String, String)>,
    project_buses: Vec<String>,
    source_buses: Option<Vec<String>>,
    offset: u64,
    limit: u64,
) -> Result<RowPage<SignalSnapshotRecord>, String> {
    let state: State<'_, AppState> = app.state();
    fetch_signal_page_inner(
        state.inner(),
        &selection,
        scan_start,
        scan_end,
        sort_key.as_deref(),
        sort_dir.as_deref(),
        bus_names,
        &project_buses,
        source_buses.as_deref(),
        offset,
        limit,
    )
}

#[allow(clippy::too_many_arguments)] // the command's IPC payload, unwrapped for tests
pub(crate) fn fetch_signal_page_inner(
    state: &AppState,
    selection: &SignalSelection,
    scan_start: u64,
    scan_end: u64,
    sort_key: Option<&str>,
    sort_dir: Option<&str>,
    bus_names: Vec<(String, String)>,
    project_buses: &[String],
    source_buses: Option<&[String]>,
    offset: u64,
    limit: u64,
) -> Result<RowPage<SignalSnapshotRecord>, String> {
    let start = usize::try_from(scan_start).unwrap_or(usize::MAX);
    let end = usize::try_from(scan_end).unwrap_or(usize::MAX);
    let names: HashMap<String, String> = bus_names.into_iter().collect();
    // Snapshot the DBC set (Arc clones) so decode and the store's
    // windowed queries run without holding the databases lock.
    let dbs: Vec<(Arc<Database>, Vec<String>)> = {
        let guard = state.databases();
        guard
            .iter()
            .map(|d| (d.db.clone(), d.buses.clone()))
            .collect()
    };
    // Shared, cached universe — rebuilding and re-sorting one entry per
    // signal per bus on every poll tick is what this cache exists to
    // avoid. The view's `sources` wiring is applied inside the selection
    // scan instead of by pruning `all`, so the snapshot stays shareable.
    let all = state.scoped_descriptor_snapshot(project_buses);
    let selected = signal_snapshot::select_descriptors(&all, selection, &names, source_buses)?;
    let mut rows = collect_signal_rows(state, &dbs, &all, &selected, start, end);
    signal_snapshot::sort_rows(&mut rows, sort_key, sort_dir, &names);

    let count = u64::try_from(rows.len()).unwrap_or(u64::MAX);
    let off = usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(rows.len());
    let lim = usize::try_from(limit).unwrap_or(usize::MAX);
    let page: Vec<SignalSnapshotRecord> = rows.into_iter().skip(off).take(lim).collect();
    Ok(RowPage {
        count,
        start: u64::try_from(off).unwrap_or(0),
        rows: page,
    })
}

/// Join the selected descriptors with the trace window: one decoded
/// latest frame per *message stream and mux group* — never per signal —
/// then one row per descriptor extracted from those decodes. Rows come
/// back in `selected` order (the deterministic descriptor order);
/// blanks stay in place.
/// A message stream's identity in the snapshot join: `(bus, id,
/// extended)` — the descriptor key minus the signal name.
type StreamKey = (Option<String>, u32, bool);

/// The selected descriptor indices one message stream owes rows for,
/// split by how their latest frame resolves.
#[derive(Default)]
struct WantedSignals {
    plain: Vec<usize>,
    mux: HashMap<u64, Vec<usize>>,
}

/// One resolved (non-blank) snapshot cell: a descriptor's decoded
/// latest value + its update statistics.
struct SnapshotCell {
    value: f64,
    raw: i64,
    label: Option<String>,
    rate: f64,
    count: u64,
    time_seconds: f64,
}

/// Extract cells for `idxs` (descriptor indices into `all`) from one
/// decoded frame, all sharing that frame's statistics. A signal absent
/// from the decode (payload too short) simply stays blank.
fn extract_snapshot_cells(
    cells: &mut HashMap<usize, SnapshotCell>,
    all: &[(Option<String>, cannet_dbc::SignalDescriptor)],
    idxs: &[usize],
    decoded: &cannet_dbc::DecodedMessage<'_>,
    rate: f64,
    count: u64,
    time_seconds: f64,
) {
    for &i in idxs {
        let Some(sig) = decoded
            .signals
            .iter()
            .find(|s| s.name == all[i].1.signal_name)
        else {
            continue;
        };
        cells.insert(
            i,
            SnapshotCell {
                value: sig.value,
                raw: sig.raw_signed,
                label: sig.label.map(str::to_string),
                rate,
                count,
                time_seconds,
            },
        );
    }
}

/// One windowed by-key snapshot serving every plain (non-mux) signal of
/// the requested streams: the per-channel `FrameKey`s merged down to
/// `(bus, id, extended)`, keeping the newest occurrence (a same-bus
/// multi-channel id is a degenerate config — the newest channel's frame
/// and statistics represent it).
///
/// Restricted to the streams actually asked for. The unrestricted
/// snapshot clones a key and a frame payload per distinct id *in the
/// capture*, under the append lock, and the callers here want a page's
/// worth — the signals view's ~30 rows, the DBC panel's visible signals.
fn plain_latest_for<'a>(
    state: &AppState,
    streams: impl Iterator<Item = &'a StreamKey>,
    start: usize,
    end: usize,
) -> HashMap<StreamKey, trace_store::LatestById> {
    let wanted: HashSet<StreamKey> = streams.cloned().collect();
    let mut out: HashMap<StreamKey, trace_store::LatestById> = HashMap::new();
    let rows = state
        .trace_store
        .latest_in_window_where(start, end, |(bus, _ch, id, ext)| {
            wanted.contains(&(bus.clone(), *id, *ext))
        });
    for row in rows {
        let key = (row.frame.bus_id.clone(), row.frame.id, row.frame.extended);
        match out.get(&key) {
            Some(have) if have.index >= row.index => {}
            _ => {
                out.insert(key, row);
            }
        }
    }
    out
}

fn collect_signal_rows(
    state: &AppState,
    dbs: &[(Arc<Database>, Vec<String>)],
    all: &[(Option<String>, cannet_dbc::SignalDescriptor)],
    selected: &[usize],
    start: usize,
    end: usize,
) -> Vec<SignalSnapshotRecord> {
    let mut streams: HashMap<StreamKey, WantedSignals> = HashMap::new();
    for &i in selected {
        let (bus, d) = &all[i];
        let w = streams
            .entry((bus.clone(), d.message_id, d.extended))
            .or_default();
        match d.mux_selector {
            None => w.plain.push(i),
            Some(sel) => w.mux.entry(sel).or_default().push(i),
        }
    }

    let plain_latest = plain_latest_for(state, streams.keys(), start, end);

    // Per descriptor index: the decoded value + statistics, or absent
    // (blank row). Decodes happen per (stream, group): a 500-signal mux
    // message costs one decode per selector group, not per signal.
    let mut cells: HashMap<usize, SnapshotCell> = HashMap::new();
    #[allow(clippy::cast_precision_loss)]
    let secs = |ns: u64| (ns as f64) / 1e9;
    for ((bus, id, extended), wanted) in &streams {
        if !wanted.plain.is_empty() {
            if let Some(latest) = plain_latest.get(&(bus.clone(), *id, *extended)) {
                if let Some(decoded) = decode_snapshot_frame(dbs, &latest.frame) {
                    extract_snapshot_cells(
                        &mut cells,
                        all,
                        &wanted.plain,
                        &decoded,
                        latest.rate,
                        latest.count,
                        secs(latest.frame.timestamp_ns),
                    );
                }
            }
        }
        if !wanted.mux.is_empty() {
            let selectors: Vec<u64> = wanted.mux.keys().copied().collect();
            let latest = state.trace_store.latest_mux_in_window(
                bus.as_deref(),
                *id,
                *extended,
                &selectors,
                start,
                end,
            );
            for (sel, (_, frame)) in &latest {
                let Some(decoded) = decode_snapshot_frame(dbs, frame) else {
                    continue;
                };
                let (rate, count) = state
                    .trace_store
                    .mux_stats(bus.as_deref(), *id, *extended, *sel)
                    .unwrap_or((0.0, 0));
                extract_snapshot_cells(
                    &mut cells,
                    all,
                    &wanted.mux[sel],
                    &decoded,
                    rate,
                    count,
                    secs(frame.timestamp_ns),
                );
            }
        }
    }

    selected
        .iter()
        .map(|&i| {
            let (bus, d) = &all[i];
            let cell = cells.remove(&i);
            SignalSnapshotRecord {
                bus_id: bus.clone(),
                transmitter: d.transmitter.clone(),
                message_id: d.message_id,
                extended: d.extended,
                message_name: d.message_name.clone(),
                signal_name: d.signal_name.clone(),
                unit: d.unit.clone(),
                is_enum: d.is_enum,
                value: cell.as_ref().map(|c| c.value),
                raw: cell.as_ref().map(|c| c.raw),
                label: cell.as_ref().and_then(|c| c.label.clone()),
                rate: cell.as_ref().map(|c| c.rate),
                count: cell.as_ref().map(|c| c.count),
                time_seconds: cell.as_ref().map(|c| c.time_seconds),
            }
        })
        .collect()
}

/// Decode a raw frame against the DBC-set snapshot — the same
/// first-applicable-DBC-wins and per-bus-scoping rules as
/// [`decode_against`], but returning the borrow-rich
/// [`cannet_dbc::DecodedMessage`] (the snapshot rows need `raw_signed`,
/// which the wire-shape [`DecodedRecord`] doesn't carry).
fn decode_snapshot_frame<'a>(
    dbs: &'a [(Arc<Database>, Vec<String>)],
    frame: &RawTraceFrame,
) -> Option<cannet_dbc::DecodedMessage<'a>> {
    let id = CanId::new(frame.id, frame.extended).ok()?;
    dbs.iter()
        .filter(|(_, buses)| {
            buses.is_empty()
                || frame
                    .bus_id
                    .as_ref()
                    .is_some_and(|b| buses.iter().any(|x| x == b))
        })
        .find_map(|(db, _)| db.decode_raw(id, frame.payload.data()))
}

/// The filter index `AppState` keeps live for the trace's current filtered
/// view (ADR 0002 DS-3). It is rebuilt when the predicate it was built for
/// changes, or when the capture session changes (a Clear / new capture
/// bumps the store's `session_start_ns`, invalidating the recorded frame
/// indices); otherwise it is extended incrementally as the capture grows,
/// so a steady filtered view is `O(delta)` and serving a page is
/// `O(log n + page)` — never an `O(capture)` scan.
pub(crate) struct ActiveFilterIndex {
    /// The predicate the index was built for. A different predicate is a
    /// full rebuild.
    pub(crate) predicate: FilterPredicate,
    /// The store session the recorded indices belong to. A change (Clear /
    /// new capture) means the indices reference a discarded timeline —
    /// rebuild.
    pub(crate) session_start_ns: u64,
    pub(crate) index: cannet_spill::FilterIndex,
    /// The predicate's by-id candidate set and the ids whose frames have
    /// to be decoded to test it. Both are a pure function of (predicate,
    /// loaded DBCs, ids seen so far) — resolving them walks every loaded
    /// DBC's message and signal names, and it ran on *every* page fetch.
    /// The predicate and the DBC set can't move without this whole index
    /// being dropped (`invalidate_derived_caches` nulls it on any DBC
    /// change; a predicate change rebuilds it above), so the only input
    /// left to watch is the store's key generation.
    pub(crate) candidates: filter::CandidateSet,
    pub(crate) decode_ids: HashSet<u32>,
    pub(crate) resolved_key_generation: Option<u64>,
    /// How many times the resolution above was actually computed. Carried
    /// only so the memo is testable — nothing reads it in production.
    pub(crate) resolve_count: u64,
}

/// Map a filtered view window onto a single index page. `p_start` / `p_end`
/// are the match-positions bounding the frame window `[scan_start, end)`
/// (from [`cannet_spill::FilterIndex::position_of`]); within that window
/// this returns the running match `count`, the absolute index page-position
/// and length to read, and the match-index of the page's first row.
///
/// It reproduces the old streaming selector's semantics off the
/// random-access index: a forward `[offset, offset + limit)` slice, or the
/// last `limit` matches when `from_end` (the live tail). Pure, so the
/// index math is unit-tested apart from the store / lock machinery.
pub(crate) fn windowed_filter_page(
    p_start: usize,
    p_end: usize,
    offset: u64,
    limit: u64,
    from_end: bool,
) -> (u64, usize, usize, u64) {
    let count_usize = p_end.saturating_sub(p_start);
    let count = u64::try_from(count_usize).unwrap_or(u64::MAX);
    let lim = usize::try_from(limit).unwrap_or(usize::MAX);
    if from_end {
        // The last `limit` matches in the window.
        let page_len = lim.min(count_usize);
        let page_pos = p_end - page_len;
        let start_match = count.saturating_sub(u64::try_from(page_len).unwrap_or(u64::MAX));
        (count, page_pos, page_len, start_match)
    } else {
        // The `[offset, offset + limit)` slice within the window.
        let off = usize::try_from(offset)
            .unwrap_or(usize::MAX)
            .min(count_usize);
        let page_len = lim.min(count_usize - off);
        let page_pos = p_start + off;
        let start_match = u64::try_from(off).unwrap_or(u64::MAX);
        (count, page_pos, page_len, start_match)
    }
}

/// Materialise the decoded rows of a filtered page from its absolute store
/// indices: clone the frames, decode each against the current DBCs, and
/// attach any ingest-time violation. Shared by [`fetch_filtered_trace`]'s
/// full-scan and follow-live tail paths.
fn materialize_filtered_rows(state: &AppState, page_idxs: &[usize]) -> Vec<TraceFrameRecord> {
    let pairs = state.trace_store.frames_at(page_idxs);
    let dbs = state.databases();
    pairs
        .into_iter()
        .map(|(i, frame)| {
            let index = u64::try_from(i).unwrap_or(u64::MAX);
            let mut record =
                TraceFrameRecord::from_raw(index, &frame, decode_against(&dbs, &frame));
            record.violation = state.verifier.violation_at(index);
            record
        })
        .collect()
}

/// Ensure the active filter index ([`AppState::filter_index`]) is built for
/// `filter` against the current capture session and current to the store tip,
/// returning the held lock guard. The shared head of [`fetch_filtered_trace`]
/// and [`filtered_positions_at_ns`]: rebuild on a predicate or session change
/// (a Clear / new capture bumps `session_start_ns`, invalidating the recorded
/// frame indices), then extend by the freshly-appended tail — candidate-id
/// narrowed, `O(delta)`, never an `O(capture)` scan. `None` when the index
/// file is unavailable (the caller serves an empty result). The `databases`
/// lock is held only for the synchronous build; the index's own chunked
/// extend releases the trace-store append lock between chunks, so ingest is
/// not starved.
pub(crate) fn ensure_active_filter_index<'a>(
    state: &'a AppState,
    filter: &FilterPredicate,
) -> Option<std::sync::MutexGuard<'a, Option<ActiveFilterIndex>>> {
    let mut guard = state
        .filter_index();
    let session = state.trace_store.session_start_ns();
    let needs_rebuild = match guard.as_ref() {
        Some(a) => a.predicate != *filter || a.session_start_ns != session,
        None => true,
    };
    if needs_rebuild {
        let index = match cannet_spill::FilterIndex::new(&state.filter_index_dir) {
            Ok(i) => i,
            Err(e) => {
                tracing::error!("filter index unavailable ({e})");
                return None;
            }
        };
        *guard = Some(ActiveFilterIndex {
            predicate: filter.clone(),
            session_start_ns: session,
            index,
            candidates: filter::CandidateSet {
                keys: Vec::new(),
                membership: false,
            },
            decode_ids: HashSet::new(),
            resolved_key_generation: None,
            resolve_count: 0,
        });
    }
    {
        let active = guard.as_mut().expect("active filter index just set");
        let dbs = state.databases();
        // Re-resolve only when a new id has been seen. Walking every
        // loaded DBC's message and signal names on each page fetch was
        // pure repetition — nothing else that feeds it can change without
        // dropping or rebuilding the index.
        let generation = state.trace_store.key_generation();
        if active.resolved_key_generation != Some(generation) {
            active.candidates = resolve_candidates_for(filter, &state.trace_store, &dbs)
                .unwrap_or_else(|| all_ids_tested(&state.trace_store));
            active.decode_ids = decode_candidate_ids(&dbs, filter);
            active.resolved_key_generation = Some(generation);
            active.resolve_count = active.resolve_count.wrapping_add(1);
        }
        let decode_ids = &active.decode_ids;
        let keep = |f: &RawTraceFrame| {
            let decoded = if decode_ids.contains(&f.id) {
                decode_against(&dbs, f)
            } else {
                None
            };
            filter.matches(f, decoded.as_ref())
        };
        let candidates = active.candidates.clone();
        state
            .trace_store
            .refresh_filter_index(&mut active.index, &candidates, &keep);
    }
    Some(guard)
}

/// A *paged* window into the filtered chronological trace, served from the
/// materialized filter index (ADR 0002 DS-3). Returns the total match count
/// within `[scan_start, scan_end)` plus the decoded matches at match-indices
/// `[offset, offset + limit)` — or, when `from_end` is set, the *last*
/// `limit` matches, so the live-tail view gets its page and the running
/// total in one call. The frontend pages this; it never holds the whole
/// filtered set in memory.
///
/// The index — not a window scan — is what makes this `O(log n + page)`:
/// the predicate resolves to its by-id candidate set
/// ([`filter::resolve_candidates`]), the index is brought current to the
/// store tip ([`TraceStore::refresh_filter_index`], `O(delta)`,
/// visiting only candidate-id frames — never an `O(capture)` scan), and the
/// `[scan_start, scan_end)` window maps onto a match-position range by two
/// [`cannet_spill::FilterIndex::position_of`] lower-bounds. Count is then
/// the range width and the page a random-access [`cannet_spill::FilterIndex::page`]
/// slice. Only the returned page's frames are cloned and decoded for display
/// ([`materialize_filtered_rows`]), never the whole match set.
///
/// The index is held on [`AppState`] across calls and rebuilt only when the
/// predicate or the capture session changes; otherwise each call extends it
/// by the freshly-appended tail. Because the index gives an exact count in
/// `O(log n)`, the legacy `prev_count` / `prev_count_end` incremental-count
/// checkpoint is no longer needed — the parameters are accepted for IPC
/// compatibility but unused.
///
/// `async` so Tauri runs it off the main thread; the body holds no lock
/// across an `.await` (it takes none — the index extend chunks its own
/// trace-store locking internally).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // a Tauri command — args are the IPC payload fields
#[allow(clippy::unused_async)] // `async` makes Tauri run it off the main thread
pub(crate) async fn fetch_filtered_trace(
    app: AppHandle,
    filter: FilterPredicate,
    scan_start: u64,
    scan_end: u64,
    offset: u64,
    limit: u64,
    from_end: bool,
    prev_count: Option<u64>,
    prev_count_end: Option<u64>,
) -> FilteredTracePage {
    let state: State<'_, AppState> = app.state();
    // The filter index gives an exact count in O(log n), so the legacy
    // incremental-count checkpoint is no longer consulted.
    let _ = (prev_count, prev_count_end);
    let win_start = usize::try_from(scan_start).unwrap_or(usize::MAX);

    // Hold the active filter index for the whole call (filtered fetches are
    // infrequent and the index is cheap to serve), built for this predicate
    // and current to the store tip.
    let Some(mut guard) = ensure_active_filter_index(state.inner(), &filter) else {
        return FilteredTracePage {
            count: 0,
            start: 0,
            rows: Vec::new(),
        };
    };
    let active = guard.as_mut().expect("active filter index ensured");

    // Map the frame window `[scan_start, end)` onto a match-position range
    // (two lower-bound searches) and read that page directly. `end` is
    // clamped to what the index has actually been built through.
    let end = usize::try_from(scan_end)
        .unwrap_or(usize::MAX)
        .min(active.index.built_through());
    let p_start = active.index.position_of(win_start);
    let p_end = active.index.position_of(end);
    let (count, page_pos, page_len, start_match) =
        windowed_filter_page(p_start, p_end, offset, limit, from_end);
    let page_idxs = active.index.page(page_pos, page_len);
    drop(guard);

    let rows = materialize_filtered_rows(state.inner(), &page_idxs);
    FilteredTracePage {
        count,
        start: start_match,
        rows,
    }
}

/// Resolve `filter` to its by-id candidate set (ADR 0002 DS-3) against the
/// live capture and DBCs. `None` when the predicate is not id-narrowable (a
/// vacuous-true `all` or a non-narrowable `any`); the caller falls back to a
/// tested build over every seen id.
fn resolve_candidates_for(
    filter: &FilterPredicate,
    store: &TraceStore,
    dbs: &[LoadedDbc],
) -> Option<filter::CandidateSet> {
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
    let regex_ids = |pat: &str| -> Vec<(u32, bool)> {
        let mut v: Vec<(u32, bool)> = Vec::new();
        for d in dbs {
            for (id, ext, name) in d.db.message_names() {
                if filter::regex_match(pat, name) {
                    v.push((id, ext));
                }
            }
        }
        v
    };
    let signal_ids = |name: &str| -> Vec<(u32, bool)> {
        let mut v: Vec<(u32, bool)> = Vec::new();
        for d in dbs {
            for (id, ext, sig) in d.db.signal_names() {
                if sig == name {
                    v.push((id, ext));
                }
            }
        }
        v
    };
    let inputs = filter::CandidateInputs {
        seen_ids: &seen_ids,
        seen_on_bus: &seen_on_bus,
        regex_ids: &regex_ids,
        signal_ids: &signal_ids,
    };
    filter::resolve_candidates(filter, &inputs)
}

/// The fallback candidate set for a non-id-narrowable predicate: every id
/// the capture has seen, tested per frame. A correct (if `O(seen ids)`-wide)
/// superset — these predicates are pathological (a vacuous-true `all`).
fn all_ids_tested(store: &TraceStore) -> filter::CandidateSet {
    let mut keys: Vec<(u32, bool)> = store
        .seen_bus_ids()
        .into_iter()
        .map(|(_, id, ext)| (id, ext))
        .collect();
    keys.sort_unstable();
    keys.dedup();
    filter::CandidateSet {
        keys,
        membership: false,
    }
}
/// Anchor each timeline event's timestamp to a frame index (ADR 0035): the
/// first retained frame at/after that ns, or `len()` if past the tail. The
/// chronological trace view splices events into its frame stream at these
/// indices — time→index is the model's job (ADR 0024), not the view's.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn frame_indices_at_ns(state: State<'_, AppState>, timestamps: Vec<u64>) -> Vec<u64> {
    timestamps
        .into_iter()
        .map(|ts| state.trace_store.frame_index_at_ns(ts) as u64)
        .collect()
}

/// Anchor each timeline event's timestamp to a window-local match position in
/// the *filtered* chronological view (ADR 0035 + ADR 0002 DS-3). The raw
/// [`frame_indices_at_ns`] anchors index the unfiltered stream; a filtered
/// view pages its own match-position space, so its interleave needs each
/// event mapped there: ns → raw frame index ([`TraceStore::frame_index_at_ns`],
/// time→index per ADR 0024) → match position
/// ([`cannet_spill::FilterIndex::position_of`]), expressed relative to the
/// window start `scan_start`. Returns one position per timestamp, in input
/// order; a value outside `[0, window-match-count]` means the event falls
/// outside the window and the view drops it — mirroring the unfiltered merge,
/// where out-of-window anchors are likewise dropped.
///
/// `async` so Tauri runs it off the main thread; the body holds no lock
/// across an `.await` (it takes none).
#[tauri::command]
#[allow(clippy::unused_async)] // `async` makes Tauri run it off the main thread
pub(crate) async fn filtered_positions_at_ns(
    app: AppHandle,
    filter: FilterPredicate,
    scan_start: u64,
    timestamps: Vec<u64>,
) -> Vec<i64> {
    let state: State<'_, AppState> = app.state();
    let Some(mut guard) = ensure_active_filter_index(state.inner(), &filter) else {
        return Vec::new();
    };
    let active = guard.as_mut().expect("active filter index ensured");
    // The window start's match position is the local zero: an event's
    // window-local row is `position_of(its frame) - position_of(scan_start)`.
    let base = i64::try_from(
        active
            .index
            .position_of(usize::try_from(scan_start).unwrap_or(usize::MAX)),
    )
    .unwrap_or(i64::MAX);
    timestamps
        .into_iter()
        .map(|ts| {
            let raw = state.trace_store.frame_index_at_ns(ts);
            i64::try_from(active.index.position_of(raw)).unwrap_or(i64::MAX) - base
        })
        .collect()
}
