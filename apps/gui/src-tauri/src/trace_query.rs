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

use cannet_dbc::Database;

use crate::app_state::{AppState, LoadedDbc};
use crate::dbc_commands::{decode_against, decode_resolved};
use crate::filter::{
    self, DecodeDependentLeaf, FilterPredicate, FuzzyCandidate, FuzzyLabel, FuzzyMatchMode,
    FuzzyResolution, FuzzySignal, MatchContext,
};
use crate::ipc::{
    self, ByIdSnapshot, FilteredTracePage, RowPage, SignalPageRow, SignalSections, SignalSelection,
    SignalSnapshotRecord, TraceFrameRecord,
};
use crate::signal_snapshot;
use crate::trace_store::{self, RawTraceFrame, TraceStore};

/// Whether this row describes a transmit no wire took, as the marker
/// the trace view renders. Only `Tx` rows can carry it, so an `Rx` row
/// never pays for the lookup.
fn tx_delivery(state: &AppState, record: &TraceFrameRecord) -> Option<&'static str> {
    (record.direction == "Tx" && state.undelivered_tx.contains(record.index))
        .then_some("undelivered")
}

/// Pull a `[start, end)` slice out of the trace store and decode each
/// frame against the loaded DBCs (first that matches wins). Shared by
/// the `fetch_trace_range` command (trace-view scrolling) and the
/// `trace-grew` tail (auto-scroll live tail). Out-of-range or
/// oversized ranges clamp to what's stored, matching [`TraceStore::slice`].
pub(crate) fn collect_trace_records(
    state: &AppState,
    start: u64,
    end: u64,
) -> Vec<TraceFrameRecord> {
    let start_us = usize::try_from(start).unwrap_or(usize::MAX);
    let end_us = usize::try_from(end).unwrap_or(usize::MAX);
    let raw = state.trace_store.slice(start_us, end_us);
    let dbs = state.databases();
    let model = state.decode_model(&dbs);
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
            let decoded = decode_against(&model, &frame);
            let mut record = TraceFrameRecord::from_raw(absolute_index, &frame, decoded);
            record.violation = violations.get(&absolute_index).copied();
            record.tx_delivery = tx_delivery(state, &record);
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

/// Resolve every `fuzzy` leaf in `filter` against the current capture,
/// databases and project bus names — the standing facts a fuzzy leaf
/// cannot read off one frame (see [`filter::TaggedPredicate::Fuzzy`]).
///
/// A predicate with no fuzzy leaf resolves to the empty context without
/// touching a database, so the existing leaves pay nothing for this.
pub(crate) fn resolve_match_context(state: &AppState, filter: &FilterPredicate) -> MatchContext {
    if filter.fuzzy_queries().is_empty() {
        return MatchContext::default();
    }
    let names: HashMap<String, String> = state.project_bus_names().iter().cloned().collect();
    let dbs = state.databases();
    resolve_match_context_against(
        filter,
        &state.trace_store,
        &dbs,
        &names,
        FuzzyMatchMode::Chronological,
    )
}

/// [`resolve_match_context`] against a bus-name map and databases the
/// caller already holds — `fetch_by_id_page` is handed the map, and
/// `ensure_active_filter_index` holds the `databases` lock for its own
/// build and would deadlock re-taking it.
pub(crate) fn resolve_match_context_against(
    filter: &FilterPredicate,
    store: &TraceStore,
    dbs: &[LoadedDbc],
    names: &HashMap<String, String>,
    mode: FuzzyMatchMode,
) -> MatchContext {
    let queries = filter.fuzzy_queries();
    if queries.is_empty() {
        return MatchContext::with_mode(mode);
    }
    let (candidates, signals, labels) = fuzzy_haystacks(store, dbs, names);
    let mut ctx = MatchContext::with_mode(mode);
    for q in queries {
        ctx.insert(
            q,
            FuzzyResolution::resolve(q, &candidates, &signals, &labels),
        );
    }
    ctx
}

/// The arbitration id as the trace renders it, in both spellings —
/// `s:1C0` / `x:00001C0A` and `s:448`. The prefix stays in both: the
/// two id widths overlap numerically, so it is part of the id's name,
/// not a formatting choice. Mirrors the frontend's
/// `formatArbitrationId`.
fn id_spellings(id: u32, extended: bool) -> (String, String) {
    let prefix = if extended { 'x' } else { 's' };
    let width = if extended { 8 } else { 3 };
    (format!("{prefix}:{id:0width$X}"), format!("{prefix}:{id}"))
}

/// Build the three lists a `fuzzy` query is ranked against: one
/// [`FuzzyCandidate`] per `(bus, id, extended)` the capture has seen,
/// one [`FuzzySignal`] per signal that message carries, and one
/// [`FuzzyLabel`] per value-table entry those signals define.
///
/// All three come from the capture's seen keys rather than from the
/// databases, because an id no frame carried cannot be a row — and an
/// id no database describes is still searchable by its bus and its
/// spelling. Databases are consulted in load order and the first one
/// assigned to the frame's bus that defines the message wins, which is
/// the same rule the decode path follows ([`filter::dbc_applies`]) —
/// so a signal or a label in these lists is one the frame's own
/// database names, and the bus it is scoped to is the frame's.
fn fuzzy_haystacks(
    store: &TraceStore,
    dbs: &[LoadedDbc],
    names: &HashMap<String, String>,
) -> (Vec<FuzzyCandidate>, Vec<FuzzySignal>, Vec<FuzzyLabel>) {
    // Borrowing sweeps of each database, so the per-key lookup below is
    // a map hit rather than a rescan.
    struct DbText<'a> {
        db: &'a Database,
        buses: &'a [String],
        messages: HashMap<(u32, bool), (&'a str, Option<&'a str>)>,
        signals: HashMap<(u32, bool), Vec<&'a str>>,
    }
    let texts: Vec<DbText<'_>> = dbs
        .iter()
        .map(|d| {
            let transmitters: HashMap<(u32, bool), Option<&str>> =
                d.db.message_transmitters()
                    .map(|(id, ext, tx)| ((id, ext), tx))
                    .collect();
            let mut signals: HashMap<(u32, bool), Vec<&str>> = HashMap::new();
            for (id, ext, sig) in d.db.signal_names() {
                signals.entry((id, ext)).or_default().push(sig);
            }
            DbText {
                db: &d.db,
                buses: &d.buses,
                messages: d
                    .db
                    .message_names()
                    .map(|(id, ext, name)| {
                        let tx = transmitters.get(&(id, ext)).copied().flatten();
                        ((id, ext), (name, tx))
                    })
                    .collect(),
                signals,
            }
        })
        .collect();

    let mut candidates = Vec::new();
    let mut signals = Vec::new();
    let mut labels = Vec::new();
    for (bus_id, id, extended) in store.seen_bus_ids() {
        let (hex, dec) = id_spellings(id, extended);
        let bus_name = names.get(&bus_id).map_or(bus_id.as_str(), String::as_str);
        let mut haystack = format!("{bus_name} {hex} {dec}");
        if let Some(t) = texts.iter().find(|t| {
            filter::dbc_applies(t.buses, Some(&bus_id)) && t.messages.contains_key(&(id, extended))
        }) {
            let (name, transmitter) = t.messages[&(id, extended)];
            haystack.push(' ');
            haystack.push_str(name);
            if let Some(tx) = transmitter {
                haystack.push(' ');
                haystack.push_str(tx);
            }
            // Signal names are *not* appended to the message's
            // haystack: they are ranked in their own right, so a query
            // aimed at a signal — or at one of its values — is not also
            // answered by the message carrying it.
            for sig in t.signals.get(&(id, extended)).into_iter().flatten() {
                signals.push(FuzzySignal {
                    bus_id: bus_id.clone(),
                    id,
                    extended,
                    signal: (*sig).to_string(),
                });
                for entry in
                    t.db.value_table_for_signal(id, extended, sig)
                        .unwrap_or(&[])
                {
                    labels.push(FuzzyLabel {
                        bus_id: bus_id.clone(),
                        id,
                        extended,
                        signal: (*sig).to_string(),
                        label: entry.label.clone(),
                    });
                }
            }
        }
        candidates.push(FuzzyCandidate {
            bus_id,
            id,
            extended,
            haystack,
        });
    }
    (candidates, signals, labels)
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
    let ctx = filter
        .as_ref()
        .map(|p| resolve_match_context(state.inner(), p))
        .unwrap_or_default();
    apply_filter_records(records, filter.as_ref(), &ctx)
}

/// Drop the records that don't pass `predicate`. The `Option` shape is
/// the "no filter wired" path; this just returns the vec unchanged.
/// `ctx` is the predicate's resolved standing facts
/// ([`resolve_match_context`]); a predicate with no `fuzzy` leaf reads
/// nothing from it.
pub(crate) fn apply_filter_records(
    records: Vec<TraceFrameRecord>,
    predicate: Option<&FilterPredicate>,
    ctx: &MatchContext,
) -> Vec<TraceFrameRecord> {
    let Some(p) = predicate else { return records };
    // The fetch-path's decoded `TraceFrameRecord` doesn't carry a raw
    // `RawTraceFrame`; build a thin facade so the predicate's `matches`
    // can read the fields it needs (id / bus_id / decoded).
    records
        .into_iter()
        .filter(|r| record_matches(p, r, ctx))
        .map(|mut r| {
            note_matching_signals(&mut r, ctx);
            r
        })
        .collect()
}

/// Record on an admitted row which of its signals the query matched —
/// a model fact the panel opens the row's disclosure to, rather than
/// one it re-derives from the query in JS (CLAUDE.md § GUI
/// architecture). Empty under a message-level winner.
pub(crate) fn note_matching_signals(record: &mut TraceFrameRecord, ctx: &MatchContext) {
    record.matching_signals = ctx.matching_signals(
        record.id,
        record.extended,
        Some(&record.bus_id),
        record.decoded.as_ref(),
    );
}

/// Evaluate a predicate against an already-decoded record — the fetch
/// path holds a `TraceFrameRecord`, so it reads the `(id, bus, decoded)`
/// view the predicate needs directly instead of fabricating a
/// `RawTraceFrame`.
fn record_matches(
    predicate: &FilterPredicate,
    record: &TraceFrameRecord,
    ctx: &MatchContext,
) -> bool {
    predicate.matches_fields(
        ctx,
        record.id,
        record.extended,
        Some(&record.bus_id),
        matches!(record.kind, crate::ipc::CanFrameKind::Error),
        record.decoded.as_ref(),
    )
}

/// Sort key for the by-id "bus" column: the project bus *name* (so the
/// on-screen order matches what the user reads), or the raw bus id when
/// the project doesn't know it (defensive — a removed bus). Mirrors the
/// former client-side `sortValue` "bus" case, moved host-side with the
/// rest of the by-id sort. There is no unassigned case: every row's
/// frame arrived on a bus.
///
/// Borrows rather than allocating, like [`ecu_sort_key`] and
/// [`kind_sort_key`] — it is called twice per comparison of an
/// `O(n log n)` sort.
fn bus_sort_key<'a>(bus_id: &'a str, names: &'a HashMap<String, String>) -> &'a str {
    names.get(bus_id).map_or(bus_id, String::as_str)
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
        "bus" => bus_sort_key(&fa.bus_id, names).cmp(bus_sort_key(&fb.bus_id, names)),
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
    let names: HashMap<String, String> = bus_names.into_iter().collect();
    fetch_by_id_page_inner(
        state.inner(),
        filter.as_ref(),
        scan_start,
        scan_end,
        sort_key.as_deref(),
        sort_dir.as_deref(),
        &names,
        offset,
        limit,
    )
}

/// [`fetch_by_id_page`] against the state and the bus-name map the
/// caller already holds — the command is the IPC shell around it, the
/// same split [`fetch_signal_page`] uses.
#[allow(clippy::too_many_arguments)] // the IPC payload's fields
pub(crate) fn fetch_by_id_page_inner(
    state: &AppState,
    filter: Option<&FilterPredicate>,
    scan_start: u64,
    scan_end: u64,
    sort_key: Option<&str>,
    sort_dir: Option<&str>,
    names: &HashMap<String, String>,
    offset: u64,
    limit: u64,
) -> RowPage<ByIdSnapshot> {
    let start = usize::try_from(scan_start).unwrap_or(usize::MAX);
    let end = usize::try_from(scan_end).unwrap_or(usize::MAX);
    let rows = state.trace_store.latest_in_window(start, end);
    // The bus *name* is part of a fuzzy leaf's haystack, and this
    // command is handed the project's id→name map already. A by-id row
    // is a *message*, not a frame, so its value matches are
    // definitional: the row shows when the message defines a signal
    // that can carry the value, whatever the latest frame reads.
    let ctx = filter.map_or_else(
        || MatchContext::with_mode(FuzzyMatchMode::Definitional),
        |p| {
            let dbs = state.databases();
            resolve_match_context_against(
                p,
                &state.trace_store,
                &dbs,
                names,
                FuzzyMatchMode::Definitional,
            )
        },
    );
    let mut snaps: Vec<ByIdSnapshot> = {
        let dbs = state.databases();
        let model = state.decode_model(&dbs);
        rows.into_iter()
            .filter_map(|row| {
                let decoded = decode_against(&model, &row.frame);
                let mut record = TraceFrameRecord::from_raw(
                    u64::try_from(row.index).unwrap_or(u64::MAX),
                    &row.frame,
                    decoded,
                );
                record.tx_delivery = tx_delivery(state, &record);
                if let Some(p) = filter {
                    if !record_matches(p, &record, &ctx) {
                        return None;
                    }
                    note_matching_signals(&mut record, &ctx);
                }
                Some(ByIdSnapshot {
                    frame: record,
                    rate: row.rate,
                    count: row.count,
                })
            })
            .collect()
    };
    sort_by_id(&mut snaps, sort_key, sort_dir, names);

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
        fuzzy_winner: ctx.winner(),
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
///
/// `sections` carries the view's user-authored sections. It orders the
/// rows, inserts a header row per section, and drops a folded section's
/// rows — so `count` is the fold-aware extent and every page row is
/// addressed in the same uniform row space. Omitted (or empty) it is
/// the flat list it always was.
#[tauri::command]
#[allow(
    clippy::unused_async,
    clippy::too_many_arguments,
    clippy::needless_pass_by_value
)]
pub(crate) async fn fetch_signal_page(
    app: AppHandle,
    selection: SignalSelection,
    sections: Option<SignalSections>,
    scan_start: u64,
    scan_end: u64,
    sort_key: Option<String>,
    sort_dir: Option<String>,
    bus_names: Vec<(String, String)>,
    source_buses: Option<Vec<String>>,
    offset: u64,
    limit: u64,
) -> Result<RowPage<SignalPageRow>, String> {
    let state: State<'_, AppState> = app.state();
    fetch_signal_page_inner(
        state.inner(),
        &selection,
        sections.as_ref(),
        scan_start,
        scan_end,
        sort_key.as_deref(),
        sort_dir.as_deref(),
        bus_names,
        source_buses.as_deref(),
        offset,
        limit,
    )
}

#[allow(clippy::too_many_arguments)] // the command's IPC payload, unwrapped for tests
pub(crate) fn fetch_signal_page_inner(
    state: &AppState,
    selection: &SignalSelection,
    sections: Option<&SignalSections>,
    scan_start: u64,
    scan_end: u64,
    sort_key: Option<&str>,
    sort_dir: Option<&str>,
    bus_names: Vec<(String, String)>,
    source_buses: Option<&[String]>,
    offset: u64,
    limit: u64,
) -> Result<RowPage<SignalPageRow>, String> {
    let start = usize::try_from(scan_start).unwrap_or(usize::MAX);
    let end = usize::try_from(scan_end).unwrap_or(usize::MAX);
    let names: HashMap<String, String> = bus_names.into_iter().collect();
    // Snapshot the DBC set (Arc clones) so decode and the store's
    // windowed queries run without holding the databases lock.
    let dbs: Vec<(String, Arc<Database>, Vec<String>)> = {
        let guard = state.databases();
        guard
            .iter()
            .map(|d| (d.path.clone(), d.db.clone(), d.buses.clone()))
            .collect()
    };
    // The picks travel with the set: a snapshot row is a decoded value
    // like any other, so it resolves per signal (ADR 0054).
    // The math model rides along: a math signal is a row of this view
    // too, and its fill resolves membership through the same model the
    // decode does — so the two cannot disagree inside one page.
    let math_model = {
        let guard = state.databases();
        let m = state.math_model(&guard);
        drop(guard);
        m
    };
    let model = crate::signal_fingerprint::DecodeModel::new(
        dbs.iter()
            .map(|(path, db, buses)| crate::signal_fingerprint::DbcScope { path, db, buses })
            .collect(),
        state.picks_snapshot(),
    )
    .with_math(math_model);
    // Shared, cached universe — rebuilding and re-sorting one entry per
    // signal per bus on every poll tick is what this cache exists to
    // avoid. The view's `sources` wiring is applied inside the selection
    // scan instead of by pruning `all`, so the snapshot stays shareable.
    let all = state.scoped_descriptor_snapshot();
    let no_sections = SignalSections::default();
    let sections = sections.unwrap_or(&no_sections);
    // A section's own patterns are part of what the view selects, so
    // they widen the selection before it resolves — otherwise a pattern
    // typed into a section would have no rows to claim.
    let selection = signal_snapshot::selection_with_section_patterns(selection, sections);
    let selected = signal_snapshot::select_descriptors(&all, &selection, &names, source_buses)?;
    let mut rows = collect_signal_rows(state, &model, &all, &selected, start, end);
    // File-backed signals (`docs/CONTEXT.md`) are rows of this view too.
    // They come from the capture rather than from a DBC, so they are not
    // in the descriptor universe and their columns are read off the
    // signal cache instead of joined to the trace window — no frame in
    // the window carries one.
    rows.extend(signal_snapshot::select_file_backed(
        &state.signal_caches.file_signals(),
        &selection,
        source_buses,
    )?);
    // Math signals (`docs/CONTEXT.md`) are rows of this view too, on
    // the same terms: computed rather than decoded, so their columns
    // come from the registry and their own pyramid instead of from the
    // trace window. Only a manual key selects one — a math series has
    // no canonical path for a pattern to match — so the whole block is
    // skipped for the overwhelmingly common view that names none.
    let math_ids = signal_snapshot::selected_math_ids(&selection);
    if !math_ids.is_empty() {
        rows.extend(math_rows(state, &model, &math_ids, source_buses));
    }
    // Sectioning subsumes the sort: rows sort *within* a section, so the
    // two cannot be separate passes.
    let rows = signal_snapshot::arrange_sections(rows, sections, sort_key, sort_dir, &names);

    let count = u64::try_from(rows.len()).unwrap_or(u64::MAX);
    let off = usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(rows.len());
    let lim = usize::try_from(limit).unwrap_or(usize::MAX);
    let page: Vec<SignalPageRow> = rows.into_iter().skip(off).take(lim).collect();
    Ok(RowPage {
        count,
        start: u64::try_from(off).unwrap_or(0),
        rows: page,
        fuzzy_winner: None,
    })
}

/// The snapshot rows for the math signals `ids` names.
///
/// A math series is materialised by a serve and nothing else — its
/// pyramid is session-scoped, not persisted — so the value columns are
/// read through a fill, the same one a plot's window fetch drives. The
/// fill is incremental with a watermark, so this costs the tail of what
/// the operands have grown by since the last poll, not the capture. An
/// id the registry no longer holds gets no row: the definition is gone,
/// and the view's reference to it is repaired where it is owned.
fn math_rows(
    state: &AppState,
    model: &crate::signal_fingerprint::DecodeModel<'_>,
    ids: &[String],
    source_buses: Option<&[String]>,
) -> Vec<crate::ipc::SignalSnapshotRecord> {
    let resolved: Vec<&crate::math_signals::ResolvedMath> =
        ids.iter().filter_map(|id| model.math().get(id)).collect();
    if resolved.is_empty() {
        return Vec::new();
    }
    let queries: Vec<crate::signal_cache::CacheQuery<'_>> = resolved
        .iter()
        .map(|r| crate::signal_cache::CacheQuery {
            bus_id: None,
            message_id: 0,
            extended: false,
            signal_name: &r.definition.id,
            file_backed: false,
            math: true,
        })
        .collect();
    let latest = state
        .signal_caches
        .math_latest(&queries, &state.trace_store, model);
    signal_snapshot::select_math(&resolved, &latest, source_buses)
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
            // A `StreamKey`'s bus is a descriptor's, which may be `None`
            // (a file-backed series); a frame key's is always a real bus.
            wanted.contains(&(Some(bus.clone()), *id, *ext))
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
    dbs: &crate::signal_fingerprint::DecodeModel<'_>,
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
                if let Some(decoded) = decode_resolved(
                    dbs,
                    latest.frame.bus_id.as_deref(),
                    latest.frame.id,
                    latest.frame.extended,
                    latest.frame.payload.data(),
                ) {
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
                let Some(decoded) = decode_resolved(
                    dbs,
                    frame.bus_id.as_deref(),
                    frame.id,
                    frame.extended,
                    frame.payload.data(),
                ) else {
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

    // What each signal is read in, which a project may have
    // reinterpreted (`crate::signal_units`).
    let signal_units = state.signal_units_snapshot();
    selected
        .iter()
        .map(|&i| {
            let (bus, d) = &all[i];
            snapshot_row(bus.as_deref(), d, cells.remove(&i).as_ref(), &signal_units)
        })
        .collect()
}

/// One DBC-backed descriptor plus the cell the window join found for
/// it (or `None` — the row still renders, blank), as a snapshot row.
fn snapshot_row(
    bus: Option<&str>,
    d: &cannet_dbc::SignalDescriptor,
    cell: Option<&SnapshotCell>,
    signal_units: &crate::signal_units::SignalUnits,
) -> SignalSnapshotRecord {
    SignalSnapshotRecord {
        bus_id: bus.map(str::to_string),
        transmitter: d.transmitter.clone(),
        message_id: d.message_id,
        extended: d.extended,
        message_name: d.message_name.clone(),
        signal_name: d.signal_name.clone(),
        // What the signal is read in, which a project may have
        // reinterpreted (`crate::signal_units`). The raw-field test
        // still reads the *database's* string: whether a field is raw
        // bits is a fact about the database, not about the label a user
        // corrected.
        unit: crate::signal_units::label_of_signal(
            signal_units,
            bus,
            (d.message_id, d.extended, &d.signal_name),
            &d.unit,
        ),
        is_enum: d.is_enum,
        raw_field: cannet_dbc::is_raw_field(d.value_is_raw_integer, &d.unit, d.is_enum),
        display_hex: d.display_hex,
        value: cell.map(|c| c.value),
        raw: cell.map(|c| c.raw),
        label: cell.and_then(|c| c.label.clone()),
        rate: cell.map(|c| c.rate),
        count: cell.map(|c| c.count),
        time_seconds: cell.map(|c| c.time_seconds),
        // Stamped by `arrange_sections`, which runs next.
        section: None,
        file_backed: false,
        math: false,
    }
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
    /// The predicate's resolved `fuzzy` leaves — settled here for the
    /// same reason and on the same schedule as `candidates`: a fuzzy
    /// query's match set is a cut on a ranked list over the databases,
    /// the bus names and the ids seen so far, and re-ranking that per
    /// page fetch would be the whole cost of the feature.
    pub(crate) match_context: MatchContext,
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
    let model = state.decode_model(&dbs);
    pairs
        .into_iter()
        .map(|(i, frame)| {
            let index = u64::try_from(i).unwrap_or(u64::MAX);
            let mut record =
                TraceFrameRecord::from_raw(index, &frame, decode_against(&model, &frame));
            record.violation = state.verifier.violation_at(index);
            record.tx_delivery = tx_delivery(state, &record);
            record
        })
        .collect()
}

/// Whether the index `guard` holds is the one `filter` needs, against the
/// capture session `session`.
fn index_is_current(
    active: Option<&ActiveFilterIndex>,
    filter: &FilterPredicate,
    session: u64,
) -> bool {
    active.is_some_and(|a| a.predicate == *filter && a.session_start_ns == session)
}

/// An empty index for `filter`, rooted in the session's filter directory.
/// `None` when the index files are unavailable (the caller serves an empty
/// result).
fn new_active_index(
    state: &AppState,
    filter: &FilterPredicate,
    session: u64,
) -> Option<ActiveFilterIndex> {
    let index = match cannet_spill::FilterIndex::new(&*state.filter_index_dir()) {
        Ok(i) => i,
        Err(e) => {
            tracing::error!("filter index unavailable ({e})");
            return None;
        }
    };
    Some(ActiveFilterIndex {
        predicate: filter.clone(),
        session_start_ns: session,
        index,
        candidates: filter::CandidateSet {
            keys: Vec::new(),
            membership: false,
        },
        decode_ids: HashSet::new(),
        match_context: MatchContext::default(),
        resolved_key_generation: None,
        resolve_count: 0,
    })
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
///
/// **A rebuild runs off the `filter_index` lock and takes it only for the
/// swap** (ADR 0049). A predicate change walks the whole capture, and holding
/// the lock for that parked every other filtered fetch — each one on a runtime
/// worker — behind it. The fresh index is therefore built into a local, and
/// installed at the end; a rebuild is serialized against another rebuild by a
/// separate gate, so two views asking for the same new predicate still cost
/// one walk. Whatever the build was planned against is a *hint* (ADR 0048):
/// the swap re-reads the session under the lock and discards the fresh index
/// if a Clear moved the capture underneath it, rather than installing one
/// stamped against a session that is gone.
pub(crate) fn ensure_active_filter_index<'a>(
    state: &'a AppState,
    filter: &FilterPredicate,
) -> Option<std::sync::MutexGuard<'a, Option<ActiveFilterIndex>>> {
    let session = state.trace_store.session_start_ns();
    if !index_is_current(state.filter_index().as_ref(), filter, session) {
        // Only one rebuild at a time, and not under the index lock: a
        // second caller waits here, then finds the index already built.
        let _build = state.filter_index_build();
        let session = state.trace_store.session_start_ns();
        if !index_is_current(state.filter_index().as_ref(), filter, session) {
            let mut fresh = new_active_index(state, filter, session)?;
            extend_active_index(state, filter, &mut fresh);
            let mut guard = state.filter_index();
            // The plan is a hint: a Clear during the build moved the
            // capture, and an index stamped against the session that is
            // gone must not be installed. The next call rebuilds.
            if state.trace_store.session_start_ns() == session {
                *guard = Some(fresh);
            }
        }
    }
    let mut guard = state.filter_index();
    if !index_is_current(guard.as_ref(), filter, state.trace_store.session_start_ns()) {
        // The capture moved under the build (a Clear), so nothing that
        // is installed describes the session being asked about. Serve
        // nothing; the next call rebuilds against the new session.
        return None;
    }
    extend_active_index(state, filter, guard.as_mut().expect("index is current"));
    Some(guard)
}

/// Resolve `filter` against the current capture (only when a new id has been
/// seen) and bring `active` current to the store tip. The body both the
/// off-lock rebuild and the on-lock incremental extend run; the second is
/// `O(delta)`, which is why it is cheap enough to do under the lock.
fn extend_active_index(state: &AppState, filter: &FilterPredicate, active: &mut ActiveFilterIndex) {
    {
        let dbs = state.databases();
        // Re-resolve only when a new id has been seen. Walking every
        // loaded DBC's message and signal names on each page fetch was
        // pure repetition — nothing else that feeds it can change without
        // dropping or rebuilding the index.
        let generation = state.trace_store.key_generation();
        if active.resolved_key_generation != Some(generation) {
            let names: HashMap<String, String> =
                state.project_bus_names().iter().cloned().collect();
            active.match_context = resolve_match_context_against(
                filter,
                &state.trace_store,
                &dbs,
                &names,
                FuzzyMatchMode::Chronological,
            );
            active.candidates =
                resolve_candidates_for(filter, &state.trace_store, &dbs, &active.match_context)
                    .unwrap_or_else(|| all_ids_tested(&state.trace_store));
            active.decode_ids = decode_candidate_ids(&dbs, filter);
            // `decode_dependent_leaves` reads the predicate alone, so it
            // cannot know which ids a `fuzzy` leaf's enum-label half
            // needs decoded — only its resolution does. Its id-keyed
            // half needs none at all.
            active
                .decode_ids
                .extend(active.match_context.decode_ids().iter().map(|(id, _)| *id));
            active.resolved_key_generation = Some(generation);
            active.resolve_count = active.resolve_count.wrapping_add(1);
        }
        let decode_ids = &active.decode_ids;
        let ctx = &active.match_context;
        let model = state.decode_model(&dbs);
        let keep = |f: &RawTraceFrame| {
            let decoded = if decode_ids.contains(&f.id) {
                decode_against(&model, f)
            } else {
                None
            };
            filter.matches(ctx, f, decoded.as_ref())
        };
        let candidates = active.candidates.clone();
        state
            .trace_store
            .refresh_filter_index(&mut active.index, &candidates, &keep);
    }
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
/// `async` + [`off_async_workers`](crate::sampling::off_async_workers)
/// (ADR 0048): a predicate change rebuilds the index over the whole capture,
/// which is capture-scaled work and must not hold an async-runtime worker for
/// its duration. The body holds no lock across an `.await` (it takes none —
/// the index extend chunks its own trace-store locking internally).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // a Tauri command — args are the IPC payload fields
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
    crate::sampling::off_async_workers(move || {
        fetch_filtered_trace_blocking(
            &app,
            &filter,
            scan_start,
            scan_end,
            offset,
            limit,
            from_end,
            prev_count,
            prev_count_end,
        )
    })
    .await
}

#[allow(clippy::too_many_arguments)]
fn fetch_filtered_trace_blocking(
    app: &AppHandle,
    filter: &FilterPredicate,
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
    let Some(mut guard) = ensure_active_filter_index(state.inner(), filter) else {
        return FilteredTracePage {
            count: 0,
            start: 0,
            rows: Vec::new(),
            fuzzy_winner: None,
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
    // The winner and the page's matching signals are model facts the
    // panel is handed rather than re-deriving (CLAUDE.md § GUI
    // architecture). The resolution is cloned out of the index because
    // the rows are materialized off the lock; it is sized by the match
    // set that cleared the floor, not by the capture.
    let fuzzy_winner = active.match_context.winner();
    let ctx = (fuzzy_winner.is_some_and(|w| w != filter::FuzzyWinner::Message))
        .then(|| active.match_context.clone());
    drop(guard);

    let mut rows = materialize_filtered_rows(state.inner(), &page_idxs);
    if let Some(ctx) = ctx {
        for r in &mut rows {
            note_matching_signals(r, &ctx);
        }
    }
    FilteredTracePage {
        count,
        start: start_match,
        rows,
        fuzzy_winner,
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
    ctx: &MatchContext,
) -> Option<filter::CandidateSet> {
    let seen = store.seen_bus_ids();
    let mut seen_ids: Vec<(u32, bool)> = seen.iter().map(|(_, id, ext)| (*id, *ext)).collect();
    seen_ids.sort_unstable();
    seen_ids.dedup();
    let seen_on_bus = |b: &str| -> Vec<(u32, bool)> {
        seen.iter()
            .filter(|(bus, _, _)| bus == b)
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
        fuzzy: ctx,
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
///
/// `async` so Tauri runs it off the main thread: the anchor fold behind
/// it is normally a few blocks, but over a capture restored from a
/// scratch written before the index was persisted it walks the whole
/// capture, and the window has to keep painting meanwhile. The body
/// holds no lock across an `.await` (it takes none).
#[tauri::command]
#[allow(clippy::unused_async)] // `async` makes Tauri run it off the main thread
pub(crate) async fn frame_indices_at_ns(app: AppHandle, timestamps: Vec<u64>) -> Vec<u64> {
    let state: State<'_, AppState> = app.state();
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
/// `async` + [`off_async_workers`](crate::sampling::off_async_workers)
/// (ADR 0048), for the same reason as [`fetch_filtered_trace`]: this shares
/// its index, so it shares its rebuild.
#[tauri::command]
pub(crate) async fn filtered_positions_at_ns(
    app: AppHandle,
    filter: FilterPredicate,
    scan_start: u64,
    timestamps: Vec<u64>,
) -> Vec<i64> {
    crate::sampling::off_async_workers(move || {
        filtered_positions_at_ns_blocking(&app, &filter, scan_start, &timestamps)
    })
    .await
}

fn filtered_positions_at_ns_blocking(
    app: &AppHandle,
    filter: &FilterPredicate,
    scan_start: u64,
    timestamps: &[u64],
) -> Vec<i64> {
    let state: State<'_, AppState> = app.state();
    let Some(mut guard) = ensure_active_filter_index(state.inner(), filter) else {
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
        .iter()
        .map(|&ts| {
            let raw = state.trace_store.frame_index_at_ns(ts);
            i64::try_from(active.index.position_of(raw)).unwrap_or(i64::MAX) - base
        })
        .collect()
}
