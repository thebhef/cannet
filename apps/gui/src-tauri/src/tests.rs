//! Unit tests for the host crate's command modules.
//!
//! Relocated wholesale from `lib.rs` when that god-file was split; the
//! suite shares helpers (`test_state`, `loaded`, `tiny_dbc`, …) across
//! what are now several modules, so it stays one cohesive `tests` module
//! resolving crate-internal items through `use super::*` at the crate root.

use super::*;
use cannet_core::{CanFramePayload, Direction};

fn dummy_frame(ts_ns: u64, id: u32) -> RawTraceFrame {
    RawTraceFrame {
        timestamp_ns: ts_ns,
        channel: 0,
        id,
        extended: false,
        direction: Direction::Rx,
        payload: CanFramePayload::Classic(vec![]),
        bus_id: None,
    }
}

#[test]
fn open_trace_store_uses_the_disk_backend_at_the_scratch_dir() {
    // Production opens the disk-spill store rooted at the scratch dir
    // (ADR 0002 DS-6): an append lands as on-disk segment files there,
    // proving the live store is disk-backed and not the in-RAM double.
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("current");
    std::fs::create_dir_all(&dir).unwrap();
    let store = open_trace_store(&dir);
    store.append(dummy_frame(1_000, 0x123));
    assert_eq!(store.len(), 1);
    let has_segments = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| {
            let n = e.file_name();
            let n = n.to_string_lossy();
            n.starts_with("meta.") || n.starts_with("payload.")
        });
    assert!(has_segments, "expected disk-spill segment files in {dir:?}");
}

#[test]
fn open_trace_store_falls_back_to_in_ram_when_scratch_is_unavailable() {
    // A scratch dir that can't be opened must not down the app: the store
    // falls back to the in-RAM backend and a capture still runs. The
    // project directory always resolves (ADR 0042), so the failure this
    // guards is now the directory not existing on disk, not the absence
    // of a project.
    // A regular file where the scratch dir should be: unopenable as a
    // directory, however hard the store tries.
    let root = tempfile::TempDir::new().unwrap();
    let blocked = root.path().join("blocked");
    std::fs::write(&blocked, b"not a directory").unwrap();
    let store = open_trace_store(&blocked);
    store.append(dummy_frame(1_000, 0x1));
    assert_eq!(store.len(), 1);
}

/// Serve a filtered page over a whole match set of `n` (positions
/// `[0, n)`), returning `(count, page positions, start_match)` — the
/// page is the position slice the index would read.
fn fpage(n: usize, offset: u64, limit: u64, from_end: bool) -> (u64, Vec<usize>, u64) {
    let (count, pos, len, start) = windowed_filter_page(0, n, offset, limit, from_end);
    (count, (pos..pos + len).collect(), start)
}

#[test]
fn windowed_filter_page_pages_a_forward_offset_limit_slice() {
    // 5 matches at positions 0..5; forward [1, 3) → positions 1, 2.
    let (count, page, start) = fpage(5, 1, 2, false);
    assert_eq!(count, 5);
    assert_eq!(page, vec![1, 2]);
    assert_eq!(start, 1);
}

#[test]
fn windowed_filter_page_from_end_keeps_the_last_limit_matches() {
    let (count, page, start) = fpage(5, 0, 2, true);
    assert_eq!(count, 5);
    assert_eq!(page, vec![3, 4]);
    assert_eq!(start, 3); // count - page.len()
}

#[test]
fn windowed_filter_page_limit_zero_counts_without_paging() {
    let (count, page, start) = fpage(5, 0, 0, false);
    assert_eq!(count, 5);
    assert!(page.is_empty());
    assert_eq!(start, 0);
}

#[test]
fn windowed_filter_page_offset_past_the_end_is_an_empty_page() {
    let (count, page, start) = fpage(3, 99, 10, false);
    assert_eq!(count, 3);
    assert!(page.is_empty());
    assert_eq!(start, 3); // offset.min(count)
}

#[test]
fn windowed_filter_page_from_end_fewer_matches_than_limit() {
    // Sparse window: fewer matches than the page cap → keep all,
    // anchored at match-index 0.
    let (count, page, start) = fpage(3, 0, 10, true);
    assert_eq!(count, 3);
    assert_eq!(page, vec![0, 1, 2]);
    assert_eq!(start, 0);
}

#[test]
fn windowed_filter_page_sub_window_offsets_into_absolute_positions() {
    // A frame window mapping to match-positions [2, 7) (5 matches).
    // Forward [0, 3) within the window → absolute positions 2, 3, 4.
    let (count, pos, len, start) = windowed_filter_page(2, 7, 0, 3, false);
    assert_eq!(count, 5);
    assert_eq!((pos, len, start), (2, 3, 0));
    // from_end within the same window → last 2 → positions 5, 6.
    let (count, pos, len, start) = windowed_filter_page(2, 7, 0, 2, true);
    assert_eq!((count, pos, len, start), (5, 5, 2, 3));
}

#[test]
fn windowed_filter_page_empty_or_inverted_window_is_zero() {
    // win_start past the tip (p_start > p_end via saturating_sub) → no
    // matches, empty page, regardless of direction.
    assert_eq!(windowed_filter_page(7, 2, 0, 5, false), (0, 7, 0, 0));
    assert_eq!(windowed_filter_page(7, 2, 0, 5, true), (0, 2, 0, 0));
}

// --- by-id host-side sort (former client `sortRows`) ---

fn snap(id: u32, channel: u8, rate: f64, bus: Option<&str>) -> ByIdSnapshot {
    ByIdSnapshot {
        frame: TraceFrameRecord {
            index: 0,
            timestamp_seconds: 0.0,
            channel,
            id,
            extended: false,
            direction: "Rx",
            kind: ipc::CanFrameKind::Classic,
            data: vec![],
            decoded: None,
            bus_id: bus.map(Into::into),
            violation: None,
        },
        rate,
        count: 0,
    }
}

fn sorted_ids(
    rows: &[ByIdSnapshot],
    key: Option<&str>,
    dir: Option<&str>,
    names: &HashMap<String, String>,
) -> Vec<u32> {
    let mut v = rows.to_vec();
    sort_by_id(&mut v, key, dir, names);
    v.iter().map(|r| r.frame.id).collect()
}

#[test]
fn sort_by_id_orders_by_a_column_stable_and_no_op_for_none() {
    let names = HashMap::new();
    let rows = [
        snap(0x200, 1, 0.0, None),
        snap(0x100, 0, 0.0, None),
        snap(0x100, 2, 0.0, None),
    ];
    // None key leaves the input order (the host default).
    assert_eq!(
        sorted_ids(&rows, None, None, &names),
        vec![0x200, 0x100, 0x100]
    );
    // Stable: the two 0x100 rows keep their input order (channels 0, 2).
    let mut v = rows.to_vec();
    sort_by_id(&mut v, Some("id"), Some("asc"), &names);
    assert_eq!(
        v.iter()
            .map(|r| (r.frame.id, r.frame.channel))
            .collect::<Vec<_>>(),
        vec![(0x100, 0), (0x100, 2), (0x200, 1)],
    );
    assert_eq!(
        sorted_ids(&rows, Some("id"), Some("desc"), &names),
        vec![0x200, 0x100, 0x100]
    );
}

#[test]
fn sort_by_id_orders_by_rate() {
    let names = HashMap::new();
    let rows = [
        snap(0x100, 0, 5.0, None),
        snap(0x200, 0, 50.0, None),
        snap(0x300, 0, 0.5, None),
    ];
    assert_eq!(
        sorted_ids(&rows, Some("rate"), Some("asc"), &names),
        vec![0x300, 0x100, 0x200]
    );
    assert_eq!(
        sorted_ids(&rows, Some("rate"), Some("desc"), &names),
        vec![0x200, 0x100, 0x300]
    );
}

#[test]
fn sort_by_id_orders_by_bus_name_unassigned_last() {
    // Sorts by the resolved bus *name*, with the unassigned bucket
    // after any real bus ascending (and before them descending). A bus
    // the project no longer knows falls back to its raw id.
    // The bus ids deliberately sort the *opposite* way to their names,
    // so an implementation that ignored `names` and ordered by raw id
    // would fail rather than coincide.
    let names: HashMap<String, String> = [
        ("b1".to_string(), "Powertrain".to_string()),
        ("b2".to_string(), "Chassis".to_string()),
    ]
    .into_iter()
    .collect();
    let rows = [
        snap(0x100, 0, 0.0, Some("b1")), // Powertrain
        snap(0x200, 0, 0.0, None),       // unassigned -> "~"
        snap(0x300, 0, 0.0, Some("b2")), // Chassis
        snap(0x400, 0, 0.0, Some("z")),  // unknown bus -> "z"
    ];
    assert_eq!(
        sorted_ids(&rows, Some("bus"), Some("asc"), &names),
        vec![0x300, 0x100, 0x400, 0x200]
    );
    assert_eq!(
        sorted_ids(&rows, Some("bus"), Some("desc"), &names),
        vec![0x200, 0x400, 0x100, 0x300]
    );
}

#[test]
fn sort_by_id_orders_by_ecu_no_transmitter_last() {
    // Sorts by the decoded message's transmitter, with undecoded /
    // no-sender rows after any real ECU ascending (mirrors "bus").
    let names = HashMap::new();
    let with_ecu = |mut s: ByIdSnapshot, tx: Option<&str>| {
        s.frame.decoded = Some(DecodedRecord {
            name: "M".to_string(),
            transmitter: tx.map(Into::into),
            signals: vec![],
        });
        s
    };
    let rows = [
        with_ecu(snap(0x100, 0, 0.0, None), Some("Zonal")),
        snap(0x200, 0, 0.0, None), // undecoded
        with_ecu(snap(0x300, 0, 0.0, None), Some("Bms")),
        with_ecu(snap(0x400, 0, 0.0, None), None), // Vector__XXX
    ];
    assert_eq!(
        sorted_ids(&rows, Some("ecu"), Some("asc"), &names),
        vec![0x300, 0x100, 0x200, 0x400],
    );
    assert_eq!(
        sorted_ids(&rows, Some("ecu"), Some("desc"), &names),
        vec![0x200, 0x400, 0x100, 0x300],
    );
}

/// A multiplexed message in the ev-zonal shape: a selector byte
/// gating two per-mode fields, plus an unconditional field.
const MUX_SNAPSHOT_DBC: &str = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: Zonal\n\n\
    BO_ 512 Modes: 8 Zonal\n\
    \x20SG_ Mux M : 0|8@1+ (1,0) [0|0] \"\" Zonal\n\
    \x20SG_ ModeA m0 : 8|16@1+ (1,0) [0|0] \"\" Zonal\n\
    \x20SG_ ModeB m1 : 8|16@1+ (0.5,0) [0|0] \"\" Zonal\n\
    \x20SG_ Always : 24|8@1+ (1,0) [0|0] \"\" Zonal\n\
    \nBA_DEF_ SG_ \"CannetDisplay\" STRING ;\n\
    BA_DEF_DEF_ \"CannetDisplay\" \"\";\n\
    BA_ \"CannetDisplay\" SG_ 512 ModeA \"radix=hex\";\n";

/// A `Modes` frame: selector byte + a little-endian 16-bit field +
/// the unconditional byte.
fn modes_frame(ts_ns: u64, sel: u8, field: u16, always: u8) -> RawTraceFrame {
    let [lo, hi] = field.to_le_bytes();
    RawTraceFrame {
        timestamp_ns: ts_ns,
        payload: CanFramePayload::Classic(vec![sel, lo, hi, always, 0, 0, 0, 0]),
        ..dummy_frame(ts_ns, 512)
    }
}

fn mux_snapshot_state() -> AppState {
    let state = test_state();
    state
        .databases
        .lock()
        .unwrap()
        .push(loaded("modes.dbc", MUX_SNAPSHOT_DBC));
    // What add_dbc does after a DBC-set change — installs the
    // trace store's mux-selector extractor.
    invalidate_derived_caches(&state);
    state
}

fn fetch_all_signals(state: &AppState, end: u64) -> Vec<SignalSnapshotRecord> {
    let sel = SignalSelection {
        keys: vec![],
        patterns: vec!["^/Zonal/Modes/".to_string()],
    };
    fetch_signal_page_inner(
        state,
        &sel,
        None,
        0,
        end,
        None,
        None,
        vec![],
        &[],
        None,
        0,
        100,
    )
    .expect("valid pattern")
    .rows
    .iter()
    .filter_map(ipc::SignalPageRow::signal)
    .cloned()
    .collect()
}

#[test]
fn descriptor_snapshot_is_reused_across_calls_and_dropped_on_dbc_change() {
    // Task 41: `fetch_signal_page` must not rebuild the descriptor
    // universe per call — the DBC panel's value column and every signal
    // view poll it a few times a second, and the rebuild is O(signals ×
    // buses) with a sort on top.
    let state = mux_snapshot_state();
    let buses = ["powertrain".to_string()];
    let first = state.scoped_descriptor_snapshot(&buses);
    assert!(!first.is_empty());
    // Same inputs → literally the same allocation, no rebuild.
    assert!(Arc::ptr_eq(
        &first,
        &state.scoped_descriptor_snapshot(&buses)
    ));
    // A different project-bus list is a different universe.
    let other = state.scoped_descriptor_snapshot(&["chassis".to_string()]);
    assert!(!Arc::ptr_eq(&first, &other));
    // A DBC-set change drops it, so a removed DBC's signals can't
    // linger in the snapshot.
    state.databases.lock().unwrap().clear();
    invalidate_derived_caches(&state);
    let after = state.scoped_descriptor_snapshot(&buses);
    assert!(!Arc::ptr_eq(&first, &after));
    assert!(after.is_empty());
}

#[test]
fn fetch_signal_page_scopes_to_source_buses() {
    // A signal view is a sink with `sources` wiring: restricted to
    // specific buses, descriptors outside them (including the
    // unassigned-bus degenerate) don't exist for it.
    let state = mux_snapshot_state();
    let sel = SignalSelection {
        keys: vec![],
        patterns: vec![".".to_string()],
    };
    let page = fetch_signal_page_inner(
        &state,
        &sel,
        None,
        0,
        u64::MAX,
        None,
        None,
        vec![],
        &[],
        Some(&["powertrain".to_string()]),
        0,
        100,
    )
    .unwrap();
    assert_eq!(page.count, 0); // fixture descriptors are unassigned-bus
    let unrestricted = fetch_signal_page_inner(
        &state,
        &sel,
        None,
        0,
        u64::MAX,
        None,
        None,
        vec![],
        &[],
        None,
        0,
        100,
    )
    .unwrap();
    assert_eq!(unrestricted.count, 4);
}

#[test]
fn fetch_signal_page_holds_every_mux_group_simultaneously() {
    // The Task-20 stress case: decoding only the message's latest
    // frame would blank every mux group but the last one seen. Each
    // group must hold its own latest value at the same time.
    let state = mux_snapshot_state();
    state
        .trace_store
        .append(modes_frame(1_000_000_000, 0, 0x1234, 5));
    state
        .trace_store
        .append(modes_frame(2_000_000_000, 1, 0x5678, 9));
    let rows = fetch_all_signals(&state, u64::MAX);
    let by_name = |n: &str| rows.iter().find(|r| r.signal_name == n).unwrap();
    assert_eq!(rows.len(), 4); // Always, ModeA, ModeB, Mux — all present
                               // Both groups hold values simultaneously, each from *its* frame.
    let mode_a = by_name("ModeA");
    assert_eq!(mode_a.value, Some(f64::from(0x1234u16)));
    assert_eq!(mode_a.count, Some(1));
    assert_eq!(mode_a.time_seconds, Some(1.0));
    let mode_b = by_name("ModeB");
    assert_eq!(mode_b.value, Some(f64::from(0x5678u16) * 0.5));
    assert_eq!(mode_b.count, Some(1));
    assert_eq!(mode_b.time_seconds, Some(2.0));
    // Plain signals ride the message's latest frame + statistics.
    let always = by_name("Always");
    assert_eq!(always.value, Some(9.0));
    assert_eq!(always.count, Some(2));
    assert_eq!(always.transmitter.as_deref(), Some("Zonal"));
}

#[test]
fn fetch_signal_page_bounds_mux_groups_to_the_window() {
    let state = mux_snapshot_state();
    state
        .trace_store
        .append(modes_frame(1_000_000_000, 0, 0x1234, 5)); // idx 0
    state
        .trace_store
        .append(modes_frame(2_000_000_000, 1, 0x5678, 9)); // idx 1
                                                           // Window [0, 1): only the selector-0 frame is visible.
    let rows = fetch_all_signals(&state, 1);
    let by_name = |n: &str| rows.iter().find(|r| r.signal_name == n).unwrap();
    assert_eq!(rows.len(), 4); // blank rows stay present
    assert_eq!(by_name("ModeA").value, Some(f64::from(0x1234u16)));
    let mode_b = by_name("ModeB");
    assert_eq!(mode_b.value, None);
    assert_eq!(mode_b.count, None);
    assert_eq!(by_name("Always").value, Some(5.0)); // not the later 9
}

#[test]
fn signal_snapshot_rows_flag_raw_bit_fields() {
    // Same predicates as the trace rows' decoded lines: the signal view
    // and the DBC panel's value column must classify — and hex — the
    // same signals the trace does.
    let state = mux_snapshot_state();
    state
        .trace_store
        .append(modes_frame(1_000_000_000, 0, 0x1234, 5));
    let rows = fetch_all_signals(&state, u64::MAX);
    let by_name = |n: &str| rows.iter().find(|r| r.signal_name == n).unwrap();
    assert!(
        by_name("ModeA").raw_field,
        "unscaled unitless integer -> raw field"
    );
    assert!(!by_name("ModeB").raw_field, "factor 0.5 -> stays decimal");
    // Hex is the DBC's per-signal opt-in, not the classification:
    // `ModeA` carries `CannetDisplay "radix=hex"`, `Always` is just as
    // raw a field and reads base 10.
    assert!(by_name("ModeA").display_hex);
    assert!(by_name("Always").raw_field && !by_name("Always").display_hex);
    assert!(!by_name("ModeB").display_hex);
}

#[test]
fn fetch_signal_page_lists_never_seen_descriptors_as_blank_rows() {
    // An empty capture still yields one row per selected
    // descriptor — a dashboard's dead-ECU rows must not vanish.
    let state = mux_snapshot_state();
    let rows = fetch_all_signals(&state, u64::MAX);
    assert_eq!(rows.len(), 4);
    assert!(rows.iter().all(|r| r.value.is_none() && r.count.is_none()));
}

#[test]
fn fetch_signal_page_pages_and_sorts_host_side() {
    let state = mux_snapshot_state();
    state
        .trace_store
        .append(modes_frame(1_000_000_000, 0, 40, 5));
    let sel = SignalSelection {
        keys: vec![],
        patterns: vec!["^/Zonal/Modes/".to_string()],
    };
    // Sort by value ascending: Mux(0), Always(5), ModeA(40), then
    // blank ModeB last; page [1, 3) of that order.
    let page = fetch_signal_page_inner(
        &state,
        &sel,
        None,
        0,
        u64::MAX,
        Some("value"),
        Some("asc"),
        vec![],
        &[],
        None,
        1,
        2,
    )
    .unwrap();
    assert_eq!(page.count, 4);
    assert_eq!(page.start, 1);
    let names: Vec<&str> = page
        .rows
        .iter()
        .filter_map(|r| r.signal().map(|s| s.signal_name.as_str()))
        .collect();
    assert_eq!(names, vec!["Always", "ModeA"]);
}

#[test]
fn fetch_signal_page_pages_across_section_headers_with_a_fold_aware_count() {
    // The paged-architecture claim behind item 16: header rows are page
    // rows, so `count` is already the fold-aware extent and a page that
    // straddles a section boundary carries the header in its row space.
    let state = mux_snapshot_state();
    state
        .trace_store
        .append(modes_frame(1_000_000_000, 0, 40, 5));
    let sel = SignalSelection {
        keys: vec![],
        patterns: vec!["^/Zonal/Modes/".to_string()],
    };
    let sections = ipc::SignalSections {
        names: vec!["Modes".to_string()],
        assignments: [
            ("*|s:512:ModeA".to_string(), "Modes".to_string()),
            ("*|s:512:ModeB".to_string(), "Modes".to_string()),
        ]
        .into_iter()
        .collect(),
        patterns: std::collections::HashMap::new(),
        folded: vec![],
    };
    let transcript = |sections: &ipc::SignalSections, offset, limit| {
        let page = fetch_signal_page_inner(
            &state,
            &sel,
            Some(sections),
            0,
            u64::MAX,
            Some("signal"),
            Some("asc"),
            vec![],
            &[],
            None,
            offset,
            limit,
        )
        .unwrap();
        let rows: Vec<String> = page
            .rows
            .iter()
            .map(|r| match (r.signal(), r.header()) {
                (Some(s), _) => format!("+{}", s.signal_name),
                (_, Some(h)) => format!("{}({})", h.name, h.signal_count),
                _ => unreachable!(),
            })
            .collect();
        (page.count, page.start, rows)
    };
    // 4 signals + 2 headers: unassigned (Always, Mux) then Modes.
    let (count, start, rows) = transcript(&sections, 0, 100);
    assert_eq!(count, 6);
    assert_eq!(start, 0);
    assert_eq!(
        rows,
        vec!["(2)", "+Always", "+Mux", "Modes(2)", "+ModeA", "+ModeB"],
    );
    // A page straddling the boundary gets the header as an ordinary row.
    let (_, start, rows) = transcript(&sections, 2, 2);
    assert_eq!(start, 2);
    assert_eq!(rows, vec!["+Mux", "Modes(2)"]);
    // Folding Modes drops its two rows from the extent, not its header.
    let folded = ipc::SignalSections {
        folded: vec!["Modes".to_string()],
        ..sections
    };
    let (count, _, rows) = transcript(&folded, 0, 100);
    assert_eq!(count, 4);
    assert_eq!(rows, vec!["(2)", "+Always", "+Mux", "Modes(2)"]);
}

#[test]
fn decode_against_carries_the_transmitter() {
    let db = Database::parse(&tiny_dbc(0x100, "M", "S")).unwrap();
    let dbs = vec![LoadedDbc {
        path: "t.dbc".into(),
        db: Arc::new(db),
        buses: Vec::new(),
    }];
    let decoded = decode_against(&dbs, &frame_with_data(0x100)).unwrap();
    assert_eq!(decoded.transmitter.as_deref(), Some("ECU"));
}

/// A classic frame with a full 8-byte payload — enough that an
/// 8-bit signal at byte 0 actually decodes (an empty payload would
/// be skipped as "outside the payload").
fn frame_with_data(id: u32) -> RawTraceFrame {
    RawTraceFrame {
        payload: CanFramePayload::Classic(vec![0u8; 8]),
        ..dummy_frame(0, id)
    }
}

/// A minimal one-message DBC: arbitration id `id`, message name
/// `name`, one 8-bit signal `sig` at byte 0.
fn tiny_dbc(id: u32, name: &str, sig: &str) -> String {
    format!(
        "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\n\
         BO_ {id} {name}: 8 ECU\n SG_ {sig} : 0|8@1+ (1,0) [0|0] \"\" ECU\n"
    )
}

pub(crate) fn test_state() -> AppState {
    // A process-unique signals dir so concurrently-running tests don't
    // share (and wipe) each other's pyramid files.
    static SIGNALS_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = SIGNALS_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let signals_dir = std::env::temp_dir().join(format!("cannet-test-signals-{n}"));
    AppState {
        databases: Mutex::new(Vec::new()),
        descriptor_snapshot: Mutex::new(None),
        remote_sessions: Mutex::new(HashMap::new()),
        trace_store: Arc::new(TraceStore::new()),
        signal_caches: SignalCacheStore::new(signals_dir),
        system_log: SystemLog::new(),
        notes: NotesStore::new(),
        dbc_watcher: Mutex::new(None),
        local_buses: local_buses::LocalBusRegistry::default(),
        transmit_frames: Mutex::new(transmit_frames::TransmitFrameRegistry::default()),
        // Tests don't run the scheduler thread; the dropped receiver
        // makes `start`/`stop` best-effort no-ops, which is fine —
        // the registry's `running` state is what the tests assert.
        transmit_scheduler: transmit_scheduler::channel().0,
        rbs: Mutex::new(rbs::RbsRuntime::default()),
        verifier: verification::VerificationState::default(),
        filter_index_dir: Mutex::new(std::env::temp_dir().join("cannet-test-filter")),
        filter_index: Mutex::new(None),
        live_tail_rows: std::sync::atomic::AtomicU64::new(0),
        active_project_id: Mutex::new(None),
    }
}

/// A minimal vbus-flavoured session for exercising the session-map
/// seam without gRPC machinery.
fn seam_session(
    sinks: Vec<(u8, std::sync::Arc<std::sync::Mutex<cannet_core::LocalSink>>)>,
) -> RemoteSession {
    RemoteSession {
        handle: None,
        tx: SessionTx::Vbus(sinks),
        channel_to_interface: vec![(0, project::LOCAL_VBUS_INTERFACE.into())],
        channel_to_bus: vec![(0, Some("p".into()))],
        stop: Arc::new(AtomicBool::new(false)),
    }
}

#[test]
fn register_session_hints_routes_changed_and_rejects_duplicates() {
    let (sched, rx) = transmit_scheduler::channel();
    let mut state = test_state();
    state.transmit_scheduler = sched;

    state
        .register_session("addr".into(), seam_session(Vec::new()))
        .unwrap();
    // A successful register hints the scheduler exactly once, so
    // parked periodics can resume without waiting for the probe.
    assert_eq!(
        rx.try_recv().unwrap(),
        transmit_scheduler::SchedulerCmd::RoutesChanged
    );

    let err = state
        .register_session("addr".into(), seam_session(Vec::new()))
        .unwrap_err();
    assert!(err.contains("already connected"), "got: {err}");
    assert!(
        rx.try_recv().is_err(),
        "a rejected register must not hint routes-changed"
    );
    // The original entry survives the rejected duplicate.
    assert!(state.remote_sessions.lock().unwrap().contains_key("addr"));
}

#[test]
fn unregister_sessions_removes_one_or_all() {
    let state = test_state();
    state
        .register_session("a".into(), seam_session(Vec::new()))
        .unwrap();
    state
        .register_session("b".into(), seam_session(Vec::new()))
        .unwrap();

    let removed = state.unregister_sessions(Some("a"));
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].0, "a");

    let removed = state.unregister_sessions(None);
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].0, "b");
    assert!(state.remote_sessions.lock().unwrap().is_empty());
}

#[test]
fn remove_vbus_session_if_dead_keeps_live_sessions() {
    let state = test_state();
    state
        .local_buses
        .create("vbus", "v", cannet_core::BusConfig::classic_500k())
        .unwrap();
    let (sink, _source) = state.local_buses.attach_participant("vbus").unwrap();

    // Live vbus session (one sink left): kept.
    state
        .register_session(
            "live".into(),
            seam_session(vec![(0, std::sync::Arc::new(std::sync::Mutex::new(sink)))]),
        )
        .unwrap();
    assert!(!state.remove_vbus_session_if_dead("live"));
    assert!(state.remote_sessions.lock().unwrap().contains_key("live"));

    // Dead vbus session (no sinks): removed.
    state
        .register_session("dead".into(), seam_session(Vec::new()))
        .unwrap();
    assert!(state.remove_vbus_session_if_dead("dead"));
    assert!(!state.remote_sessions.lock().unwrap().contains_key("dead"));

    // Absent entry counts as dead (pumps may race teardown).
    assert!(state.remove_vbus_session_if_dead("gone"));
}

pub(crate) fn loaded(path: &str, dbc_text: &str) -> LoadedDbc {
    LoadedDbc {
        path: path.into(),
        db: Arc::new(Database::parse(dbc_text).expect("test DBC parses")),
        buses: Vec::new(),
    }
}

pub(crate) fn loaded_scoped(path: &str, dbc_text: &str, buses: &[&str]) -> LoadedDbc {
    LoadedDbc {
        path: path.into(),
        db: Arc::new(Database::parse(dbc_text).expect("test DBC parses")),
        buses: buses.iter().map(|s| (*s).into()).collect(),
    }
}

#[test]
fn dbc_set_change_invalidates_stale_derived_caches() {
    // A signal cache built while the DBC was absent advances its decode
    // cursor to the store tip; without invalidation a DBC loaded later
    // never back-fills (`catch_up` finds no new frames), so a stopped,
    // reloaded capture's plot and filtered view stay empty. Regression
    // for the DBC-arrives-late gap (ADR 0033).
    let state = test_state();
    // Ten 8-byte id-256 frames the DBC's byte-0 signal `S` decodes, at
    // distinct timestamps so they form a real series.
    for i in 0..10u8 {
        let mut f = frame_with_data(256);
        f.timestamp_ns = u64::from(i) * 1_000_000_000;
        if let CanFramePayload::Classic(ref mut d) = f.payload {
            d[0] = i;
        }
        state.trace_store.append(f);
    }
    let slice = |dbs: &[&Database]| {
        state.signal_caches.slice(
            None,
            256,
            false,
            "S",
            0.0,
            100.0,
            0,
            &state.trace_store,
            dbs,
        )
    };
    // Serve with NO DBC loaded: the cache catches up empty and pins its
    // decode cursor at the tip.
    assert!(slice(&[]).is_empty(), "no DBC -> nothing decodes");

    // The DBC arrives; plant an active filter index too (a filtered view
    // would have one) so we can see it reset.
    let db = Database::parse(&tiny_dbc(256, "Msg", "S")).unwrap();
    let fi_dir = std::env::temp_dir().join(format!("cannet-inval-fi-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&fi_dir).unwrap();
    *state.filter_index.lock().unwrap() = Some(ActiveFilterIndex {
        predicate: serde_json::from_str(r#"{"bus": "p"}"#).unwrap(),
        session_start_ns: 0,
        index: cannet_spill::FilterIndex::new(&fi_dir).unwrap(),
        candidates: filter::CandidateSet {
            keys: Vec::new(),
            membership: false,
        },
        decode_ids: HashSet::new(),
        resolved_key_generation: None,
        resolve_count: 0,
    });

    invalidate_derived_caches(&state);

    assert!(
        state.filter_index.lock().unwrap().is_none(),
        "filter index reset on DBC change"
    );
    // The rebuilt cache now decodes the whole series.
    assert_eq!(
        slice(&[&db]).len(),
        10,
        "DBC now back-fills the full series"
    );
    std::fs::remove_dir_all(&fi_dir).ok();
}

#[test]
fn collect_trace_records_uses_absolute_indices() {
    let state = test_state();
    for i in 0u32..10 {
        state
            .trace_store
            .append(dummy_frame(u64::from(i) * 1_000, i));
    }
    let mid = collect_trace_records(&state, 3, 6);
    assert_eq!(
        mid.iter().map(|r| r.index).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert_eq!(mid.iter().map(|r| r.id).collect::<Vec<_>>(), vec![3, 4, 5]);
    // No DBC attached -> nothing decoded.
    assert!(mid.iter().all(|r| r.decoded.is_none()));
}

#[test]
fn wire_signals_flag_only_raw_bit_fields() {
    // Both predicates are DBC facts, so the host computes them and the
    // record carries them: a raw field is an unscaled, unitless integer
    // with no `VAL_` table, and it renders as a bit pattern only where
    // the DBC's `CannetDisplay` asks for it.
    let state = test_state();
    let dbc = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\n\
         BO_ 256 Mixed: 8 ECU\n\
          SG_ Serial : 0|24@1+ (1,0) [0|0] \"\" ECU\n\
          SG_ Flags : 24|8@1+ (1,0) [0|0] \"\" ECU\n\
          SG_ Rpm : 32|16@1+ (0.25,0) [0|0] \"rpm\" ECU\n\
          SG_ Counts : 48|8@1+ (1,0) [0|0] \"count\" ECU\n\
          SG_ Gear : 56|8@1+ (1,0) [0|0] \"\" ECU\n\
         VAL_ 256 Gear 0 \"Park\" 3 \"Drive\" ;\n\
         BA_DEF_ SG_ \"CannetDisplay\" STRING ;\n\
         BA_DEF_DEF_ \"CannetDisplay\" \"\";\n\
         BA_ \"CannetDisplay\" SG_ 256 Serial \"radix=hex\";\n";
    *state.databases.lock().unwrap() = vec![loaded("mixed.dbc", dbc)];
    state.trace_store.append(frame_with_data(256));

    let records = collect_trace_records(&state, 0, 1);
    let decoded = records[0].decoded.as_ref().expect("frame decodes");
    let signal = |name: &str| {
        decoded
            .signals
            .iter()
            .find(|s| s.name == name)
            .unwrap_or_else(|| panic!("signal {name} decoded"))
    };
    let flag = |name: &str| signal(name).raw_field;
    assert!(flag("Serial"), "unscaled unitless integer -> raw field");
    assert!(flag("Flags"), "likewise");
    assert!(!flag("Rpm"), "scaled and united -> stays decimal");
    assert!(!flag("Counts"), "a unit means a measurement, not a pattern");
    assert!(!flag("Gear"), "a VAL_ table key stays decimal");

    let hex = |name: &str| signal(name).display_hex;
    assert!(hex("Serial"), "CannetDisplay radix=hex");
    assert!(!hex("Flags"), "a raw field with no attribute reads base 10");
    assert!(!hex("Rpm"));
}

#[test]
fn decodes_against_the_loaded_dbcs_first_match_wins() {
    let state = test_state();
    // Two DBCs: each owns one unique id (256 / 512) and both define
    // id 768 — with different message names — so we can see "first
    // loaded wins" on the overlap.
    let dbc_a = format!(
        "{}\nBO_ 768 SharedMsg: 8 ECU\n SG_ FromA : 0|8@1+ (1,0) [0|0] \"\" ECU\n",
        tiny_dbc(256, "OnlyInA", "Sa"),
    );
    let dbc_b = format!(
        "{}\nBO_ 768 SharedMsg: 8 ECU\n SG_ FromB : 0|8@1+ (1,0) [0|0] \"\" ECU\n",
        tiny_dbc(512, "OnlyInB", "Sb"),
    );
    *state.databases.lock().unwrap() = vec![loaded("a.dbc", &dbc_a), loaded("b.dbc", &dbc_b)];

    for id in [256u32, 512, 768, 999] {
        state.trace_store.append(frame_with_data(id));
    }
    let r = collect_trace_records(&state, 0, 4);
    let name = |i: usize| r[i].decoded.as_ref().map(|d| d.name.clone());
    assert_eq!(name(0).as_deref(), Some("OnlyInA")); // only DBC A has it
    assert_eq!(name(1).as_deref(), Some("OnlyInB")); // only DBC B has it
    assert_eq!(name(2).as_deref(), Some("SharedMsg")); // both — A first
    assert_eq!(
        r[2].decoded
            .as_ref()
            .map(|d| d.signals[0].name.clone())
            .as_deref(),
        Some("FromA"),
    );
    assert!(r[3].decoded.is_none()); // no DBC knows id 999
}

#[test]
fn per_bus_dbc_scoping_filters_decode() {
    let state = test_state();
    // DBC A scoped to bus "p" (powertrain), DBC B scoped to bus "c"
    // (chassis). Same arbitration id 256, different message names so
    // we can tell which DBC decoded each frame.
    let dbc_a = tiny_dbc(256, "FromBusP", "Sa");
    let dbc_b = tiny_dbc(256, "FromBusC", "Sb");
    *state.databases.lock().unwrap() = vec![
        loaded_scoped("a.dbc", &dbc_a, &["p"]),
        loaded_scoped("b.dbc", &dbc_b, &["c"]),
    ];
    // Three frames, same id, different routing.
    let mut on_p = frame_with_data(256);
    on_p.bus_id = Some("p".into());
    let mut on_c = frame_with_data(256);
    on_c.bus_id = Some("c".into());
    let unassigned = frame_with_data(256); // bus_id: None
    state.trace_store.append(on_p);
    state.trace_store.append(on_c);
    state.trace_store.append(unassigned);

    let r = collect_trace_records(&state, 0, 3);
    let name = |i: usize| r[i].decoded.as_ref().map(|d| d.name.clone());
    assert_eq!(name(0).as_deref(), Some("FromBusP"));
    assert_eq!(name(1).as_deref(), Some("FromBusC"));
    // An unassigned frame doesn't match any scoped DBC.
    assert_eq!(name(2), None);
}

#[test]
fn decode_candidates_resolve_name_and_signal_leaves_to_ids() {
    let dbs = vec![
        loaded("a.dbc", &tiny_dbc(256, "String1JustDetectedFault", "Sa")),
        loaded("b.dbc", &tiny_dbc(512, "BrakeStatus", "Rpm")),
    ];
    let parse = |t: &str| serde_json::from_str::<FilterPredicate>(t).unwrap();

    // Name leaf: only the message whose name matches contributes.
    let by_name = decode_candidate_ids(&dbs, &parse(r#"{"name_regex": "String1JustDetected.*?"}"#));
    assert_eq!(by_name, HashSet::from([256]));

    // Signal leaf: only the message carrying the signal contributes.
    let by_sig = decode_candidate_ids(
        &dbs,
        &parse(r#"{"signal_equals": {"name": "Rpm", "value": 1}}"#),
    );
    assert_eq!(by_sig, HashSet::from([512]));

    // Composition unions the leaves; raw-only predicates resolve empty.
    let both = decode_candidate_ids(
        &dbs,
        &parse(
            r#"{"any": [{"name_regex": "^String1"}, {"signal_equals": {"name": "Rpm", "value": 1}}]}"#,
        ),
    );
    assert_eq!(both, HashSet::from([256, 512]));
    assert!(decode_candidate_ids(&dbs, &parse(r#"{"id_list": [256]}"#)).is_empty());
}

#[test]
fn filtered_scan_with_candidate_gating_matches_unconditional_decode() {
    // The candidate gate must be invisible in the results: a scan
    // that decodes only candidate ids returns exactly what a scan
    // decoding every frame returns.
    let dbs = vec![
        loaded("a.dbc", &tiny_dbc(256, "String1JustDetectedFault", "Sa")),
        loaded("b.dbc", &tiny_dbc(512, "BrakeStatus", "Sb")),
    ];
    let filter: FilterPredicate =
        serde_json::from_str(r#"{"name_regex": "String1JustDetected.*?"}"#).unwrap();
    let frames: Vec<RawTraceFrame> = [256, 512, 999, 256]
        .iter()
        .map(|&id| frame_with_data(id))
        .collect();

    let candidates = decode_candidate_ids(&dbs, &filter);
    let gated: Vec<bool> = frames
        .iter()
        .map(|f| {
            let decoded = if candidates.contains(&f.id) {
                decode_against(&dbs, f)
            } else {
                None
            };
            filter.matches(f, decoded.as_ref())
        })
        .collect();
    let unconditional: Vec<bool> = frames
        .iter()
        .map(|f| filter.matches(f, decode_against(&dbs, f).as_ref()))
        .collect();
    assert_eq!(gated, unconditional);
    assert_eq!(gated, vec![true, false, false, true]);
}

#[test]
fn apply_filter_drops_records_that_dont_pass() {
    // Two records, same id, different buses. A `{bus: "p"}` filter
    // keeps the first only.
    let mut r1 = TraceFrameRecord::from_raw(0, &frame_with_data(256), None);
    r1.bus_id = Some("p".into());
    let mut r2 = TraceFrameRecord::from_raw(1, &frame_with_data(256), None);
    r2.bus_id = Some("c".into());
    let predicate: FilterPredicate = serde_json::from_str(r#"{"bus": "p"}"#).unwrap();
    let filtered = apply_filter_records(vec![r1.clone(), r2], Some(&predicate));
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].bus_id.as_deref(), Some("p"));
}

#[test]
fn apply_filter_none_returns_input_unchanged() {
    let r1 = TraceFrameRecord::from_raw(0, &frame_with_data(1), None);
    let r2 = TraceFrameRecord::from_raw(1, &frame_with_data(2), None);
    let v = apply_filter_records(vec![r1, r2], None);
    assert_eq!(v.len(), 2);
}

#[test]
fn route_channel_translates_via_mapping() {
    let m = vec![
        (0u8, Some("p".to_string())),
        (1, None), // explicit skip
        (2, Some("c".into())),
    ];
    assert_eq!(route_channel(0, &m), Ok(Some("p".into())));
    assert_eq!(route_channel(2, &m), Ok(Some("c".into())));
    assert_eq!(route_channel(1, &m), Err(()));
    // Channel without an entry: unassigned.
    assert_eq!(route_channel(7, &m), Ok(None));
}

#[test]
fn panic_message_extracts_str_and_string_payloads() {
    let p = std::panic::catch_unwind(|| panic!("plain str")).unwrap_err();
    assert_eq!(panic_message(p.as_ref()), "plain str");
    let p = std::panic::catch_unwind(|| panic!("formatted {}", 42)).unwrap_err();
    assert_eq!(panic_message(p.as_ref()), "formatted 42");
    let p = std::panic::catch_unwind(|| std::panic::panic_any(7u32)).unwrap_err();
    assert_eq!(panic_message(p.as_ref()), "non-string panic payload");
}

#[test]
fn trace_grew_skips_only_when_count_and_rate_are_unchanged() {
    // First tick (nothing emitted yet) always emits.
    assert!(should_emit_trace_grew(None, (0, 0.0)));
    // Idle: count frozen and the rate has fully decayed to 0.0 — skip.
    assert!(!should_emit_trace_grew(Some((10, 0.0)), (10, 0.0)));
    // New frames landed — emit.
    assert!(should_emit_trace_grew(Some((10, 0.0)), (11, 0.0)));
    // Count steady but the rate is still decaying (a different read) — emit.
    assert!(should_emit_trace_grew(Some((10, 5.0)), (10, 4.5)));
    // Capture cleared (count dropped) — emit.
    assert!(should_emit_trace_grew(Some((10, 5.0)), (0, 0.0)));
}

#[test]
fn filter_candidate_resolution_is_memoised_until_a_new_id_is_seen() {
    // `ensure_active_filter_index` runs on every filtered page fetch — 4 Hz
    // per open filtered view — and re-resolved the predicate's candidate
    // set and decode-id set each time, walking every loaded DBC's message
    // and signal names. All of it is a pure function of (predicate, DBCs,
    // ids seen), and the first two can't move without the index being
    // dropped, so the only live input is the store's key generation.
    let state = test_state();
    *state.filter_index_dir() =
        std::env::temp_dir().join(format!("cannet-test-fi-memo-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&*state.filter_index_dir()).unwrap();
    let filter: FilterPredicate = serde_json::from_str(r#"{"id_list": [256]}"#).unwrap();

    state.trace_store.append(dummy_frame(1_000, 256));
    drop(crate::trace_query::ensure_active_filter_index(&state, &filter).unwrap());
    assert_eq!(state.filter_index().as_ref().unwrap().resolve_count, 1);

    // More frames of an id already seen: nothing about the resolution can
    // have changed.
    state.trace_store.append(dummy_frame(2_000, 256));
    drop(crate::trace_query::ensure_active_filter_index(&state, &filter).unwrap());
    assert_eq!(state.filter_index().as_ref().unwrap().resolve_count, 1);

    // A previously unseen id can change which candidates exist — resolve.
    state.trace_store.append(dummy_frame(3_000, 512));
    drop(crate::trace_query::ensure_active_filter_index(&state, &filter).unwrap());
    assert_eq!(state.filter_index().as_ref().unwrap().resolve_count, 2);
}

#[test]
fn live_tail_range_is_none_until_something_asks_for_one() {
    // The tail exists for the auto-scrolling chronological view. With no
    // such view open — no trace panel, or all of them by-id / filtered /
    // parked — collecting and decoding 256 frames ten times a second is
    // work for nobody, so the demand starts at zero and stays there.
    assert_eq!(live_tail_range(1_000, 0), None);
    // An empty capture has no tail whatever anyone asked for.
    assert_eq!(live_tail_range(0, 256), None);
    // A declared demand takes the newest `n` frames.
    assert_eq!(live_tail_range(1_000, 64), Some((936, 1_000)));
    // Shorter capture than the demand: everything there is.
    assert_eq!(live_tail_range(10, 64), Some((0, 10)));
    // The declared size is capped, so a frontend cannot ask the host for
    // an unbounded payload per tick.
    assert_eq!(
        live_tail_range(10_000, u64::MAX),
        Some((10_000 - TRACE_GREW_TAIL, 10_000)),
    );
}

#[test]
fn smooth_fps_filters_bursts_but_snaps_to_zero() {
    // First reading has nothing to filter against — passes through.
    assert!((smooth_fps(None, 400.0) - 400.0).abs() < f64::EPSILON);
    // A burst only moves the readout part of the way.
    let stepped = smooth_fps(Some(100.0), 200.0);
    assert!(stepped > 100.0 && stepped < 200.0, "{stepped}");
    // Repeated ticks converge on the raw rate.
    let mut fps = 100.0;
    for _ in 0..50 {
        fps = smooth_fps(Some(fps), 200.0);
    }
    assert!((fps - 200.0).abs() < 0.5, "{fps}");
    // A stalled stream reads *exactly* zero, so the emitter can go quiet
    // instead of trickling asymptotic updates at 10 Hz forever.
    // Bit-compared, because that is exactly how `should_emit_trace_grew`
    // decides an idle session has stopped moving.
    assert_eq!(smooth_fps(Some(123.0), 0.0).to_bits(), 0.0f64.to_bits());
}

#[test]
fn unscoped_dbc_decodes_every_bus() {
    let state = test_state();
    let dbc = tiny_dbc(256, "Anywhere", "Sig");
    *state.databases.lock().unwrap() = vec![loaded("any.dbc", &dbc)];
    let mut on_p = frame_with_data(256);
    on_p.bus_id = Some("p".into());
    let unassigned = frame_with_data(256);
    state.trace_store.append(on_p);
    state.trace_store.append(unassigned);
    let r = collect_trace_records(&state, 0, 2);
    // Both decode against the unscoped DBC.
    assert_eq!(
        r[0].decoded.as_ref().map(|d| d.name.clone()).as_deref(),
        Some("Anywhere"),
    );
    assert_eq!(
        r[1].decoded.as_ref().map(|d| d.name.clone()).as_deref(),
        Some("Anywhere"),
    );
}

#[test]
fn collect_trace_records_clamps_like_slice() {
    let state = test_state();
    for i in 0u32..10 {
        state.trace_store.append(dummy_frame(0, i));
    }
    // Oversized end: the trace-grew tail asks for `[count - TAIL, count)`,
    // and when there are fewer than TAIL frames the start saturates to 0.
    let tail = collect_trace_records(&state, 10u64.saturating_sub(TRACE_GREW_TAIL), 10);
    assert_eq!(tail.len(), 10);
    assert_eq!(tail.first().map(|r| r.index), Some(0));
    assert_eq!(tail.last().map(|r| r.index), Some(9));
    // Entirely past the end -> empty.
    assert!(collect_trace_records(&state, 20, 30).is_empty());
}

#[test]
fn describe_message_inner_finds_standard_and_extended_ids() {
    let state = test_state();
    let standard_dbc = tiny_dbc(0x100, "Std", "Sig");
    // DBC's on-disk BO_ id needs bit 31 set to mark it extended
    // (`can-dbc`'s `MessageId::Extended`); `message_id_parts` masks
    // it back off, so lookups use the plain 0x001A_BCDE id.
    let extended_dbc = tiny_dbc(0x001A_BCDE | 0x8000_0000, "Ext", "Sig");
    *state.databases.lock().unwrap() = vec![
        loaded("std.dbc", &standard_dbc),
        loaded("ext.dbc", &extended_dbc),
    ];

    let std_desc = describe_message_inner(&state, 0x100, false).unwrap();
    assert_eq!(std_desc.name, "Std");

    let ext_desc = describe_message_inner(&state, 0x001A_BCDE, true).unwrap();
    assert_eq!(ext_desc.name, "Ext");

    // The extended id's raw value doesn't collide with a standard
    // lookup at the same message table.
    assert!(describe_message_inner(&state, 0x001A_BCDE, false).is_none());
}

#[test]
fn decode_frame_inner_decodes_standard_and_extended_ids() {
    let state = test_state();
    let standard_dbc = tiny_dbc(0x100, "Std", "Sig");
    // DBC's on-disk BO_ id needs bit 31 set to mark it extended
    // (`can-dbc`'s `MessageId::Extended`); `message_id_parts` masks
    // it back off, so lookups use the plain 0x001A_BCDE id.
    let extended_dbc = tiny_dbc(0x001A_BCDE | 0x8000_0000, "Ext", "Sig");
    *state.databases.lock().unwrap() = vec![
        loaded("std.dbc", &standard_dbc),
        loaded("ext.dbc", &extended_dbc),
    ];
    let data = vec![42u8, 0, 0, 0, 0, 0, 0, 0];

    let std_decoded = decode_frame_inner(&state, 0x100, false, &data).unwrap();
    assert_eq!(std_decoded.name, "Std");

    let ext_decoded = decode_frame_inner(&state, 0x001A_BCDE, true, &data).unwrap();
    assert_eq!(ext_decoded.name, "Ext");
}

#[test]
fn encode_frame_inner_writes_signal_bits_through_first_matching_dbc() {
    // Two-byte signal `Sig` lives in byte 0 (factor 1, offset 0).
    // Encoding physical=42 writes byte 0 = 42 and leaves the rest
    // of base alone.
    let state = test_state();
    let dbc = tiny_dbc(256, "M", "Sig");
    *state.databases.lock().unwrap() = vec![loaded("any.dbc", &dbc)];
    let base = vec![0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11];
    let resp = encode_frame_inner(
        &state,
        256,
        false,
        &[ipc::EncodeFrameSignal {
            name: "Sig".into(),
            physical: 42.0,
        }],
        base,
    )
    .unwrap();
    assert!(resp.skipped.is_empty());
    assert_eq!(resp.bytes[0], 42);
    // Bytes 1..8 preserved.
    assert_eq!(
        &resp.bytes[1..],
        &[0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11]
    );
}

#[test]
fn encode_frame_inner_reports_unknown_signal_in_skipped() {
    let state = test_state();
    let dbc = tiny_dbc(256, "M", "Sig");
    *state.databases.lock().unwrap() = vec![loaded("any.dbc", &dbc)];
    let resp = encode_frame_inner(
        &state,
        256,
        false,
        &[ipc::EncodeFrameSignal {
            name: "NotThere".into(),
            physical: 0.0,
        }],
        vec![0u8; 8],
    )
    .unwrap();
    assert_eq!(resp.skipped.len(), 1);
    assert_eq!(resp.skipped[0].name, "NotThere");
    assert_eq!(resp.skipped[0].reason, "signal_not_found");
}

#[test]
fn encode_frame_inner_errors_when_no_dbc_matches() {
    let state = test_state();
    // No DBCs loaded.
    let err = encode_frame_inner(&state, 0x123, false, &[], vec![0u8; 8]).unwrap_err();
    assert!(err.contains("no DBC matches"));
}

#[test]
fn transmit_frame_inner_appends_tx_confirm_when_not_connected() {
    let state = test_state();
    let req = ipc::TransmitRequest {
        bus_id: "p".into(),
        id: 0x123,
        extended: false,
        kind: ipc::TransmitKind::Classic,
        data: vec![1, 2, 3, 4],
        brs: false,
        esi: false,
        dlc: 0,
    };
    let result = transmit_frame_inner(&state, &req).unwrap();
    assert_eq!(result.tx_confirm_index, 0);
    assert!(
        matches!(result.wire_status, ipc::TransmitWireStatus::NotConnected),
        "expected NotConnected, got {:?}",
        result.wire_status,
    );
    // The trace store now has exactly one frame, with Direction::Tx
    // and the payload we asked for.
    assert_eq!(state.trace_store.len(), 1);
    let only = state.trace_store.slice(0, 1).pop().unwrap();
    assert_eq!(only.direction, Direction::Tx);
    assert_eq!(only.id, 0x123);
    assert!(matches!(&only.payload, CanFramePayload::Classic(d) if d == &[1, 2, 3, 4]));
}

#[test]
fn transmit_frame_inner_routes_through_local_virtual_bus_session() {
    // Two project buses ("p", "q") bound to the same vbus, with
    // an in-process session open against `local-vbus://vbus`.
    // Transmit on "p"; the tx-confirm appends to "p"'s trace
    // immediately, and the SharedBus fans the frame out to "q"'s
    // participant as a Direction::Rx copy. We don't spawn the
    // pump threads here — we drain the LocalSource manually to
    // assert the routing without depending on thread timing.
    let state = test_state();
    state
        .local_buses
        .create("vbus", "v", cannet_core::BusConfig::classic_500k())
        .unwrap();
    let (sink_p, _source_p) = state.local_buses.attach_participant("vbus").unwrap();
    let (_sink_q, mut source_q) = state.local_buses.attach_participant("vbus").unwrap();

    let session = RemoteSession {
        handle: None,
        tx: SessionTx::Vbus(vec![(
            0,
            std::sync::Arc::new(std::sync::Mutex::new(sink_p)),
        )]),
        channel_to_interface: vec![(0, project::LOCAL_VBUS_INTERFACE.into())],
        channel_to_bus: vec![(0, Some("p".into()))],
        stop: Arc::new(AtomicBool::new(false)),
    };
    state
        .remote_sessions
        .lock()
        .unwrap()
        .insert(format!("{}vbus", project::LOCAL_VBUS_URL_SCHEME), session);

    let req = ipc::TransmitRequest {
        bus_id: "p".into(),
        id: 0x321,
        extended: false,
        kind: ipc::TransmitKind::Classic,
        data: vec![9, 8, 7],
        brs: false,
        esi: false,
        dlc: 0,
    };
    let result = transmit_frame_inner(&state, &req).unwrap();
    assert!(
        matches!(result.wire_status, ipc::TransmitWireStatus::Sent { .. }),
        "expected Sent, got {:?}",
        result.wire_status,
    );

    // Tx-confirm landed in the trace store for bus "p".
    assert_eq!(state.trace_store.len(), 1, "expected tx-confirm row");
    let confirm = state.trace_store.slice(0, 1).pop().unwrap();
    assert_eq!(confirm.bus_id.as_deref(), Some("p"));
    assert_eq!(confirm.direction, Direction::Tx);
    assert_eq!(confirm.id, 0x321);

    // The fan-out is delivered to "q"'s LocalSource. Wait briefly
    // for the SharedBus's arbitration worker to run.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let frame_q = loop {
        match source_q.try_next() {
            Ok(Some(cannet_core::ParticipantEvent::Frame { frame, .. })) => break frame,
            Ok(_) => {}
            Err(e) => panic!("q's participant detached unexpectedly: {e:?}"),
        }
        assert!(
            std::time::Instant::now() < deadline,
            "vbus fan-out never arrived on q"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert_eq!(frame_q.direction, Direction::Rx);
    assert_eq!(frame_q.id.raw(), 0x321);
}

/// A frame sent through the transmit panel should land in the
/// signal cache for a plot panel scoped to the same bus — the
/// tx-confirm is the only record on the sending bus (the wire
/// fan-out goes elsewhere), so a plot of "what I just sent on
/// bus X" must include `Direction::Tx` rows.
#[test]
fn tx_confirm_is_visible_via_sample_signals_signal_cache() {
    let state = test_state();

    // One-message DBC: id 0x123, 8-bit signal "Sig" at byte 0.
    let dbc_text = tiny_dbc(0x123, "Msg", "Sig");
    state
        .databases
        .lock()
        .unwrap()
        .push(loaded("test.dbc", &dbc_text));

    // Transmit a frame on bus "p" with payload [42, ...]. No
    // session is required for the tx-confirm row to land.
    let req = ipc::TransmitRequest {
        bus_id: "p".into(),
        id: 0x123,
        extended: false,
        kind: ipc::TransmitKind::Classic,
        data: vec![42, 0, 0, 0, 0, 0, 0, 0],
        brs: false,
        esi: false,
        dlc: 0,
    };
    transmit_frame_inner(&state, &req).unwrap();

    // One tx-confirm row, Direction::Tx, bus_id "p".
    assert_eq!(state.trace_store.len(), 1);
    let row = state.trace_store.slice(0, 1).pop().unwrap();
    assert_eq!(row.direction, Direction::Tx);
    assert_eq!(row.bus_id.as_deref(), Some("p"));

    // The signal cache for `(bus=p, id=0x123, "Sig")` must include
    // the tx-confirm's decoded value (42).
    let dbs_guard = state.databases.lock().unwrap();
    let db_refs: Vec<&Database> = dbs_guard.iter().map(|l| l.db.as_ref()).collect();
    let samples = state.signal_caches.slice(
        Some("p"),
        0x123,
        false,
        "Sig",
        0.0,
        f64::MAX,
        0,
        &state.trace_store,
        &db_refs,
    );
    assert!(
        samples.iter().any(|p| (p.value - 42.0).abs() < 1e-9),
        "expected tx-confirm decoded as Sig=42 in signal cache; got {samples:?}",
    );
}

/// The user's actual scenario: two project buses ("p", "q") both
/// bound to the same vbus. Transmit a frame on "p" through the
/// host's transmit-frame command (so the tx-confirm appends to
/// the trace store as `Direction::Tx` with `bus_id` "p", and the
/// `SharedBus` fans the frame out to "q"'s participant; a pump
/// stamps the fan-out copy with `bus_id` "q" and `Direction::Rx`).
/// A plot scoped to *either* bus must then find the decoded
/// signal in its signal cache — Tx for "p", Rx for "q".
#[test]
#[allow(clippy::too_many_lines)]
fn full_vbus_session_tx_decodes_for_sender_and_receiver_plots() {
    let state = test_state();

    let dbc_text = tiny_dbc(0x456, "Msg", "Sig");
    state
        .databases
        .lock()
        .unwrap()
        .push(loaded("test.dbc", &dbc_text));

    // Set up the vbus and two participants the way
    // `connect_local_vbus` does — one per project bus.
    state
        .local_buses
        .create("vbus", "v", cannet_core::BusConfig::classic_500k())
        .unwrap();
    let (sink_p, _source_p) = state.local_buses.attach_participant("vbus").unwrap();
    let (_sink_q, source_q) = state.local_buses.attach_participant("vbus").unwrap();

    // Spawn the rx pump for "q" — mirrors the per-participant
    // pump `connect_local_vbus` spawns. `LocalSourceFrameSource`
    // forces frame.channel = self.channel; `run_pump` then
    // stamps `bus_id` via `route_channel`. We splice both in
    // manually here so the test doesn't need an `AppHandle`.
    let store_for_pump = state.trace_store.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_pump = stop.clone();
    let pump = std::thread::spawn(move || {
        let mut adapter = LocalSourceFrameSource {
            source: source_q,
            channel: 1,
        };
        let channel_to_bus = vec![(1u8, Some("q".to_string()))];
        while !stop_for_pump.load(Ordering::Relaxed) {
            let Some(frame) = cannet_core::CanFrameSource::next_frame(&mut adapter)
                .ok()
                .flatten()
            else {
                break;
            };
            let mut raw = RawTraceFrame::from(frame);
            if let Ok(bid) = route_channel(raw.channel, &channel_to_bus) {
                raw.bus_id = bid;
                store_for_pump.append(raw);
            }
        }
    });

    // Register a vbus session with `p` on channel 0 (the only
    // sink the transmit path uses).
    let session = RemoteSession {
        handle: None,
        tx: SessionTx::Vbus(vec![(
            0,
            std::sync::Arc::new(std::sync::Mutex::new(sink_p)),
        )]),
        channel_to_interface: vec![
            (0, project::LOCAL_VBUS_INTERFACE.into()),
            (1, project::LOCAL_VBUS_INTERFACE.into()),
        ],
        channel_to_bus: vec![(0, Some("p".into())), (1, Some("q".into()))],
        stop: Arc::new(AtomicBool::new(false)),
    };
    state
        .remote_sessions
        .lock()
        .unwrap()
        .insert(format!("{}vbus", project::LOCAL_VBUS_URL_SCHEME), session);

    // Transmit on bus "p" — payload [7, …] decodes as Sig = 7.
    let req = ipc::TransmitRequest {
        bus_id: "p".into(),
        id: 0x456,
        extended: false,
        kind: ipc::TransmitKind::Classic,
        data: vec![7, 0, 0, 0, 0, 0, 0, 0],
        brs: false,
        esi: false,
        dlc: 0,
    };
    transmit_frame_inner(&state, &req).unwrap();

    // Wait for the pump to absorb the fan-out and the trace store
    // to grow to two rows (tx-confirm + Rx fan-out).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < deadline && state.trace_store.len() < 2 {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(
        state.trace_store.len(),
        2,
        "expected tx-confirm + fan-out; got {} rows",
        state.trace_store.len(),
    );

    // The tx-confirm and the fan-out must share one clock. The plot
    // anchors its x-axis on the window's first-frame timestamp
    // (`frame_timestamps`); if the two rows sit on different clocks
    // the receiver's samples land ~decades off that anchor and the
    // plot stays empty even though both rows appear in the trace.
    // Guard the invariant directly: the rows fall within one
    // coherent span, not wall-clock vs bus-relative.
    let (first_ns, last_ns) = state.trace_store.frame_timestamps(0, 2);
    let spread = last_ns.unwrap().abs_diff(first_ns.unwrap());
    assert!(
        spread < 1_000_000_000,
        "tx-confirm and fan-out are {spread} ns apart — two clocks in one buffer",
    );

    let dbs_guard = state.databases.lock().unwrap();
    let db_refs: Vec<&Database> = dbs_guard.iter().map(|l| l.db.as_ref()).collect();

    // Plot scoped to "p" sees the tx-confirm.
    let samples_p = state.signal_caches.slice(
        Some("p"),
        0x456,
        false,
        "Sig",
        0.0,
        f64::MAX,
        0,
        &state.trace_store,
        &db_refs,
    );
    assert!(
        samples_p.iter().any(|p| (p.value - 7.0).abs() < 1e-9),
        "plot on sender bus 'p' missed the tx-confirm; got {samples_p:?}",
    );

    // Plot scoped to "q" sees the fan-out.
    let samples_q = state.signal_caches.slice(
        Some("q"),
        0x456,
        false,
        "Sig",
        0.0,
        f64::MAX,
        0,
        &state.trace_store,
        &db_refs,
    );
    assert!(
        samples_q.iter().any(|p| (p.value - 7.0).abs() < 1e-9),
        "plot on receiver bus 'q' missed the fan-out; got {samples_q:?}",
    );

    // Tear down the pump cleanly so the test doesn't leak the
    // participant (drop sink → source returns None → pump exits).
    stop.store(true, Ordering::Relaxed);
    drop(dbs_guard);
    assert!(state.local_buses.drop_bus("vbus"));
    let _ = pump.join();
}

/// Round-trip: write the trace-store contents + notes via
/// `write_capture`, then read back via `BlfCanFrameSource` for
/// the frames and `read_notes_from_blf` for the markers. The
/// frame ids and the marker count must match the input.
#[test]
fn write_capture_round_trips_frames_and_notes() {
    use cannet_blf::BlfCanFrameSource;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("cap.blf");

    // Build a small mixed payload: classic + FD + error
    // frames. Modern absolute timestamps so the f64-second
    // round-trip drift behaves the way the writer's docs
    // describe.
    let ts_base = 1_700_000_000_000_000_000u64;
    let f_classic = trace_store::RawTraceFrame {
        timestamp_ns: ts_base,
        channel: 0,
        id: 0x100,
        extended: false,
        direction: Direction::Rx,
        payload: CanFramePayload::Classic(vec![1, 2, 3]),
        bus_id: Some("p".into()),
    };
    let f_fd = trace_store::RawTraceFrame {
        timestamp_ns: ts_base + 1_000,
        channel: 1,
        id: 0x01AB_CDEF,
        extended: true,
        direction: Direction::Tx,
        payload: CanFramePayload::Fd {
            data: vec![0xAA; 12],
            flags: cannet_core::CanFdFlags {
                bitrate_switch: true,
                error_state_indicator: false,
            },
        },
        bus_id: None,
    };
    let f_err = trace_store::RawTraceFrame {
        timestamp_ns: ts_base + 2_000,
        channel: 0,
        id: 0x10,
        extended: false,
        direction: Direction::Rx,
        payload: CanFramePayload::Error,
        bus_id: None,
    };

    let notes_in = vec![
        notes::Note {
            id: "a".into(),
            timestamp_ns: ts_base + 500,
            label: "first".into(),
            kind: notes::EventKind::Note,
            color: Some("#FF8800".into()),
        },
        notes::Note {
            id: "b".into(),
            timestamp_ns: ts_base + 1_500,
            label: "second".into(),
            kind: notes::EventKind::Note,
            color: None,
        },
    ];

    let outcome = write_capture(
        dest.to_str().unwrap(),
        &[f_classic, f_fd, f_err],
        &notes_in,
        &[],
    )
    .unwrap();
    assert_eq!(outcome.frame_count, 3);
    assert_eq!(outcome.marker_count, 2);
    assert!(outcome.byte_size > 0);

    // Frames re-read via the existing reader.
    let mut src = BlfCanFrameSource::open(&dest).unwrap();
    let f1 = src.next_frame().unwrap().unwrap();
    let f2 = src.next_frame().unwrap().unwrap();
    let f3 = src.next_frame().unwrap().unwrap();
    assert!(src.next_frame().unwrap().is_none());
    assert_eq!(f1.id.raw(), 0x100);
    assert_eq!(f1.payload.data(), &[1, 2, 3]);
    assert!(f2.id.is_extended());
    assert_eq!(f2.id.raw(), 0x01AB_CDEF);
    assert!(matches!(
        f2.payload,
        cannet_core::CanFramePayload::Fd { .. }
    ));
    assert!(matches!(f3.payload, cannet_core::CanFramePayload::Error));

    // Notes recovered from in-BLF GLOBAL_MARKERs in
    // chronological order, ids + labels + timestamps intact.
    // No sidecar file is written.
    let recovered = read_notes_from_blf(dest.to_str().unwrap()).unwrap();
    assert_eq!(recovered.len(), 2);
    assert_eq!(recovered[0].id, "a");
    assert_eq!(recovered[0].label, "first");
    // Color round-trips via the marker's foreground color (ADR 0035);
    // the uncolored note reads back uncolored, not as black.
    assert_eq!(recovered[0].color.as_deref(), Some("#FF8800"));
    assert_eq!(recovered[1].id, "b");
    assert_eq!(recovered[1].label, "second");
    assert_eq!(recovered[1].color, None);
    // Timestamps round-trip within ms precision (the SYSTEMTIME
    // header floor that the writer applies); accept the
    // ms-rounded values.
    assert_eq!(
        recovered[0].timestamp_ns / 1_000_000,
        (ts_base + 500) / 1_000_000
    );
    assert_eq!(
        recovered[1].timestamp_ns / 1_000_000,
        (ts_base + 1_500) / 1_000_000
    );
}

/// `write_capture` re-channels each frame by its `bus_id`'s
/// position in the project's ordered bus list. This is how the
/// logical bus assignment round-trips through BLF — the channel
/// number IS the bus index. A frame whose `bus_id` is missing or
/// not in the project's bus list keeps its original wire channel
/// (so we never silently lose data from a partly-mapped capture).
#[test]
fn write_capture_re_channels_frames_by_project_bus_order() {
    use cannet_blf::BlfCanFrameSource;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("multi-bus.blf");

    let ts = 1_700_000_000_000_000_000u64;
    let mk = |bus: Option<&str>, ch: u8, id: u32| trace_store::RawTraceFrame {
        timestamp_ns: ts,
        channel: ch,
        id,
        extended: false,
        direction: Direction::Rx,
        payload: CanFramePayload::Classic(vec![]),
        bus_id: bus.map(str::to_owned),
    };
    // All three frames share wire channel 0 but live on different
    // logical buses. After re-channeling they must come out on
    // distinct BLF channels matching the project's bus order.
    let frames = vec![
        mk(Some("p"), 0, 0x100),
        mk(Some("c"), 0, 0x200),
        mk(Some("p"), 0, 0x300),
    ];
    let buses = vec!["p".to_string(), "c".to_string()];

    let outcome = write_capture(dest.to_str().unwrap(), &frames, &[], &buses).unwrap();
    assert_eq!(outcome.frame_count, 3);

    let mut src = BlfCanFrameSource::open(&dest).unwrap();
    let read: Vec<u8> = std::iter::from_fn(|| src.next_frame().unwrap())
        .map(|f| f.channel)
        .collect();
    assert_eq!(read, vec![0, 1, 0]);
}

/// Frames whose `bus_id` isn't in the project's bus list — either
/// `None` (unassigned, common when a wire-channel binding was
/// missing) or `Some(unknown)` (stale id) — keep their wire-level
/// channel rather than getting silently re-channeled. The user
/// can decide what to do with them on reload via the BLF
/// channel-map modal.
#[test]
fn write_capture_keeps_wire_channel_when_bus_is_unmapped() {
    use cannet_blf::BlfCanFrameSource;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("partial-bus.blf");

    let ts = 1_700_000_000_000_000_000u64;
    let mk = |bus: Option<&str>, ch: u8, id: u32| trace_store::RawTraceFrame {
        timestamp_ns: ts,
        channel: ch,
        id,
        extended: false,
        direction: Direction::Rx,
        payload: CanFramePayload::Classic(vec![]),
        bus_id: bus.map(str::to_owned),
    };
    let frames = vec![
        mk(None, 3, 0x10),
        mk(Some("x"), 4, 0x20), // "x" not in `buses`
        mk(Some("p"), 9, 0x30), // remapped to channel 0
    ];
    let buses = vec!["p".to_string(), "c".to_string()];

    write_capture(dest.to_str().unwrap(), &frames, &[], &buses).unwrap();

    let mut src = BlfCanFrameSource::open(&dest).unwrap();
    let read: Vec<u8> = std::iter::from_fn(|| src.next_frame().unwrap())
        .map(|f| f.channel)
        .collect();
    assert_eq!(read, vec![3, 4, 0]);
}

/// Third-party-written `GLOBAL_MARKER`s (no `description` =
/// no cannet id) get synthetic `blf-marker-N` ids on read, so
/// rename / remove on them still works through the existing
/// id-keyed APIs.
#[test]
fn read_notes_from_blf_mints_synthetic_ids_for_third_party_markers() {
    use cannet_blf::format::marker;
    use cannet_blf::format::writer::BlfFileWriter;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("third-party.blf");
    let mut w = BlfFileWriter::create(&dest).unwrap();
    let abs = 1_700_000_000_000_000_000u64;
    let start = w.set_start_if_unset((abs / 1_000_000) * 1_000_000);
    // Two markers with no description (third-party shape).
    let m1 = marker::build(
        abs - start,
        b"Notes".to_vec(),
        b"first".to_vec(),
        Vec::new(),
    );
    let m2 = marker::build(
        (abs + 1_000_000) - start,
        b"Notes".to_vec(),
        b"second".to_vec(),
        Vec::new(),
    );
    w.append_object(&marker::encode(&m1), abs).unwrap();
    w.append_object(&marker::encode(&m2), abs + 1_000_000)
        .unwrap();
    w.finish().unwrap();

    let read = read_notes_from_blf(dest.to_str().unwrap()).unwrap();
    assert_eq!(read.len(), 2);
    assert_eq!(read[0].id, "blf-marker-0");
    assert_eq!(read[0].label, "first");
    assert_eq!(read[1].id, "blf-marker-1");
    assert_eq!(read[1].label, "second");
}

#[test]
fn transmit_frame_inner_rejects_invalid_id() {
    let state = test_state();
    let req = ipc::TransmitRequest {
        bus_id: "p".into(),
        id: 0xFFFF,
        extended: false,
        kind: ipc::TransmitKind::Classic,
        data: vec![],
        brs: false,
        esi: false,
        dlc: 0,
    };
    assert!(transmit_frame_inner(&state, &req).is_err());
    // And the trace store was not appended to.
    assert_eq!(state.trace_store.len(), 0);
}

#[test]
fn group_wire_batches_preserves_first_seen_group_and_frame_order() {
    // A tick's due frames for one (session, channel, interface)
    // ride one FrameBatch; interleaved destinations must not
    // reorder frames within a destination or shuffle destinations.
    let items = vec![
        (("a", 0u8, "if0"), 1u32),
        (("b", 0u8, "if1"), 2),
        (("a", 0u8, "if0"), 3),
        (("a", 1u8, "if2"), 4),
        (("b", 0u8, "if1"), 5),
    ];
    let grouped = group_wire_batches(items);
    assert_eq!(
        grouped,
        vec![
            (("a", 0u8, "if0"), vec![1, 3]),
            (("b", 0u8, "if1"), vec![2, 5]),
            (("a", 1u8, "if2"), vec![4]),
        ],
    );
}

#[test]
fn next_tick_deadline_is_fixed_rate_not_fixed_delay() {
    let base = std::time::Instant::now();
    let period = Duration::from_millis(100);

    // On-time tick: work finished 4 ms in; the next deadline is
    // still base + 100 ms (the 4 ms of work is absorbed, not added),
    // so the wait is only ~96 ms — the message holds 10 Hz.
    let now = base + Duration::from_millis(4);
    assert_eq!(next_tick_deadline(base, now, period), base + period);

    // Behind schedule: this tick's work overran the period (110 ms).
    // We realign to `now` rather than scheduling in the past (which
    // would fire a catch-up burst). The next deadline is `now`, so
    // the wait is zero and there is no accumulating backlog.
    let now = base + Duration::from_millis(110);
    assert_eq!(next_tick_deadline(base, now, period), now);
}

// ---- Transmit-throughput benchmarks --------------------------------
//
// Not part of the default suite (they're `#[ignore]`d and loop for a
// while). They exist to scope the "arbitrarily many 5–10 ms cyclic
// messages across multiple buses" target with real numbers before we
// rearchitect the scheduler. Run both with:
//
//   cargo test -p cannet-gui -- --ignored --nocapture bench_tx
//
// `bench_tx_model_only` is the model-side ceiling (build a frame +
// append a tx-confirm, no session). `bench_tx_vbus_real_path` is the
// real per-tick cost the scheduler pays: `transmit_frame_inner` over a
// live virtual-bus session, with the loopback pump appending the
// fan-out concurrently (so it captures `trace_store` lock contention).
// Comparing the two tells us whether a slow real tick is the core
// pipeline or the vbus/transport path.

#[test]
#[ignore = "throughput benchmark; run with --ignored --nocapture"]
#[allow(clippy::cast_precision_loss)] // frame counts never approach 2^52
fn bench_tx_model_only() {
    let state = test_state();
    let id = cannet_core::CanId::standard(0x123).unwrap();
    let n: u64 = 500_000;
    let start = std::time::Instant::now();
    for i in 0..n {
        let frame = cannet_core::CanFrame::classic(
            i,
            0,
            id,
            cannet_core::Direction::Tx,
            vec![0, 1, 2, 3, 4, 5, 6, 7],
        )
        .unwrap();
        let mut raw = RawTraceFrame::from(frame);
        raw.bus_id = Some("p".into());
        state.trace_store.append(raw);
    }
    let secs = start.elapsed().as_secs_f64();
    println!(
        "[bench] model-only: {n} frames in {:.1} ms = {:.0} frames/s ({:.3} us/frame)",
        secs * 1e3,
        n as f64 / secs,
        secs * 1e6 / n as f64,
    );
}

#[test]
#[ignore = "throughput benchmark; run with --ignored --nocapture"]
#[allow(clippy::cast_precision_loss)] // frame counts never approach 2^52
fn bench_tx_vbus_real_path() {
    let state = test_state();
    state
        .local_buses
        .create("vbus", "v", cannet_core::BusConfig::classic_500k())
        .unwrap();
    let (sink_p, _source_p) = state.local_buses.attach_participant("vbus").unwrap();
    let (_sink_q, source_q) = state.local_buses.attach_participant("vbus").unwrap();

    // Loopback pump for "q" — mirrors `connect_local_vbus`; drains the
    // fan-out into the trace store, so the benchmark sees the same
    // `trace_store` contention the real scheduler does.
    let store_for_pump = state.trace_store.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_pump = stop.clone();
    let pump = std::thread::spawn(move || {
        let mut adapter = LocalSourceFrameSource {
            source: source_q,
            channel: 1,
        };
        let channel_to_bus = vec![(1u8, Some("q".to_string()))];
        while !stop_for_pump.load(Ordering::Relaxed) {
            let Some(frame) = cannet_core::CanFrameSource::next_frame(&mut adapter)
                .ok()
                .flatten()
            else {
                break;
            };
            let mut raw = RawTraceFrame::from(frame);
            if let Ok(bid) = route_channel(raw.channel, &channel_to_bus) {
                raw.bus_id = bid;
                store_for_pump.append(raw);
            }
        }
    });

    let session = RemoteSession {
        handle: None,
        tx: SessionTx::Vbus(vec![(
            0,
            std::sync::Arc::new(std::sync::Mutex::new(sink_p)),
        )]),
        channel_to_interface: vec![
            (0, project::LOCAL_VBUS_INTERFACE.into()),
            (1, project::LOCAL_VBUS_INTERFACE.into()),
        ],
        channel_to_bus: vec![(0, Some("p".into())), (1, Some("q".into()))],
        stop: Arc::new(AtomicBool::new(false)),
    };
    state
        .remote_sessions
        .lock()
        .unwrap()
        .insert(format!("{}vbus", project::LOCAL_VBUS_URL_SCHEME), session);

    let req = ipc::TransmitRequest {
        bus_id: "p".into(),
        id: 0x123,
        extended: false,
        kind: ipc::TransmitKind::Classic,
        data: vec![0, 1, 2, 3, 4, 5, 6, 7],
        brs: false,
        esi: false,
        dlc: 0,
    };

    let n: u64 = 200_000;
    let start = std::time::Instant::now();
    for _ in 0..n {
        transmit_frame_inner(&state, &req).unwrap();
    }
    let secs = start.elapsed().as_secs_f64();
    println!(
        "[bench] vbus real path: {n} transmits in {:.1} ms = {:.0} frames/s ({:.3} us/transmit)",
        secs * 1e3,
        n as f64 / secs,
        secs * 1e6 / n as f64,
    );

    stop.store(true, Ordering::Relaxed);
    drop(state); // closes the bus → pump's next_frame returns
    let _ = pump.join();
}

/// A DBC declaring calculated fields on `Status` via the cannet
/// attributes — the DBC-defaults layer for the layering tests.
const CALC_ATTR_DBC: &str = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\n\
    BO_ 291 Status: 8 ECU\n\
    \x20SG_ Mode : 0|8@1+ (1,0) [0|255] \"\" ECU\n\
    \x20SG_ AliveCtr : 40|4@1+ (1,0) [0|15] \"\" ECU\n\
    \x20SG_ Ctr2 : 44|4@1+ (1,0) [0|15] \"\" ECU\n\
    \x20SG_ Crc8 : 56|8@1+ (1,0) [0|255] \"\" ECU\n\n\
    BA_DEF_ SG_ \"CannetCounter\" STRING ;\n\
    BA_DEF_ SG_ \"CannetCrc\" STRING ;\n\
    BA_DEF_DEF_ \"CannetCounter\" \"\";\n\
    BA_DEF_DEF_ \"CannetCrc\" \"\";\n\
    BA_ \"CannetCounter\" SG_ 291 AliveCtr \"increment=1;rollover=15\";\n\
    BA_ \"CannetCrc\" SG_ 291 Crc8 \"alg=CRC-8/SAE-J1850;range=0:56\";\n";

fn calc_request(bus: &str, id: u32) -> ipc::TransmitRequest {
    ipc::TransmitRequest {
        bus_id: bus.into(),
        id,
        extended: false,
        kind: ipc::TransmitKind::Classic,
        data: vec![0u8; 8],
        brs: false,
        esi: false,
        dlc: 0,
    }
}

#[test]
fn effective_calc_uses_dbc_defaults_when_no_override() {
    let dbs = vec![loaded("a.dbc", CALC_ATTR_DBC)];
    let resolved = resolve_effective_calc(&dbs, &calc_request("p", 291), None)
        .unwrap()
        .expect("DBC-declared fields resolve");
    // Counter at bits 40..44 (byte 5 low nibble), CRC in byte 7.
    let mut payload = [0u8; 8];
    let mut counter = 0;
    resolved.apply(&mut counter, &mut payload).unwrap();
    assert_eq!(payload[5] & 0x0F, 1);
    assert_ne!(payload[7], 0);
    // A message without any designation resolves to None.
    let dbs2 = vec![loaded("b.dbc", &tiny_dbc(291, "Plain", "S"))];
    assert!(resolve_effective_calc(&dbs2, &calc_request("p", 291), None)
        .unwrap()
        .is_none());
}

#[test]
fn override_replaces_the_dbc_default_per_field() {
    let dbs = vec![loaded("a.dbc", CALC_ATTR_DBC)];
    // Counter override moves the counter to Ctr2; the DBC's CRC
    // default stays in effect (per-field layering, ADR 0027).
    let spec = ipc::CalcFieldsSpec {
        counter: Some(ipc::CounterSpec {
            signal: "Ctr2".into(),
            increment: 2,
            rollover: Some(15),
        }),
        crc: None,
    };
    let resolved = resolve_effective_calc(&dbs, &calc_request("p", 291), Some(&spec))
        .unwrap()
        .unwrap();
    let mut payload = [0u8; 8];
    let mut counter = 0;
    resolved.apply(&mut counter, &mut payload).unwrap();
    assert_eq!(payload[5] >> 4, 2, "override counter (Ctr2, +2) applied");
    assert_eq!(payload[5] & 0x0F, 0, "DBC default counter signal untouched");
    assert_ne!(payload[7], 0, "DBC default CRC still applied");
}

#[test]
fn effective_calc_respects_bus_scoping_and_reports_errors() {
    // The DBC declaring the fields is scoped to bus "q" — a frame
    // on bus "p" doesn't see it.
    let dbs = vec![loaded_scoped("a.dbc", CALC_ATTR_DBC, &["q"])];
    assert!(resolve_effective_calc(&dbs, &calc_request("p", 291), None)
        .unwrap()
        .is_none());
    assert!(resolve_effective_calc(&dbs, &calc_request("q", 291), None)
        .unwrap()
        .is_some());
    // An override naming an unknown signal is an error, not a
    // silent no-op …
    let bad = ipc::CalcFieldsSpec {
        counter: Some(ipc::CounterSpec {
            signal: "Nope".into(),
            increment: 1,
            rollover: None,
        }),
        crc: None,
    };
    assert!(resolve_effective_calc(&dbs, &calc_request("q", 291), Some(&bad)).is_err());
    // … and so is an override on a message no DBC defines.
    assert!(resolve_effective_calc(&dbs, &calc_request("p", 291), Some(&bad)).is_err());
}

/// The spec types round-trip through JSON in ADR 0028's file shape
/// (`snake_case` keys, `range_bits` array, hex-string CRC params).
#[test]
fn calc_spec_serde_matches_the_adr_shapes() {
    let json = r#"{
        "counter": { "signal": "AliveCtr", "increment": 1, "rollover": 15 },
        "crc": { "signal": "Crc8", "algorithm": "CRC-8/SAE-J1850",
                 "range_bits": [0, 56], "prefix": "A3" }
    }"#;
    let spec: ipc::CalcFieldsSpec = serde_json::from_str(json).unwrap();
    let config = spec.to_config().unwrap();
    assert_eq!(config.crc.as_ref().unwrap().prefix, vec![0xA3]);
    assert_eq!(config.crc.as_ref().unwrap().range_bits, (0, 56));
    let back: ipc::CalcFieldsSpec =
        serde_json::from_str(&serde_json::to_string(&spec).unwrap()).unwrap();
    assert_eq!(back, spec);

    // Raw params accept hex strings or numbers and write hex.
    let raw = r#"{ "crc": { "signal": "C", "width": 8, "poly": "0x1D",
                   "init": 255, "range_bits": [0, 56] } }"#;
    let spec: ipc::CalcFieldsSpec = serde_json::from_str(raw).unwrap();
    let config = spec.to_config().unwrap();
    match &config.crc.as_ref().unwrap().algorithm {
        cannet_dbc::CrcAlgorithm::Raw(p) => {
            assert_eq!(p.poly, 0x1D);
            assert_eq!(p.init, 0xFF);
            assert!(!p.refin);
        }
        cannet_dbc::CrcAlgorithm::Named(_) => panic!("expected raw params"),
    }
    let text = serde_json::to_string(&spec).unwrap();
    assert!(text.contains("\"0x1D\""), "{text}");
    // Mixed named + raw is rejected at conversion.
    let mixed = r#"{ "crc": { "signal": "C", "algorithm": "CRC-8/AUTOSAR",
                     "width": 8, "range_bits": [0, 56] } }"#;
    let spec: ipc::CalcFieldsSpec = serde_json::from_str(mixed).unwrap();
    assert!(spec.to_config().is_err());
}

/// The window title is set at runtime by the frontend
/// (`getCurrentWindow().setTitle`), and Tauri's `core:default` grants
/// only the *getter* (`core:window:allow-title`). Without an explicit
/// `core:window:allow-set-title` every call is denied at the ACL, the
/// rejection lands in the frontend rather than anywhere a user looks,
/// and the static `tauri.conf.json` title silently survives — which is
/// exactly how a non-functional title bar shipped once already. Pinned
/// here so the regression cannot be silent a second time.
#[test]
fn the_capability_set_grants_set_title() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("capabilities")
        .join("default.json");
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let granted = json["permissions"]
        .as_array()
        .expect("capability file has a `permissions` array");
    assert!(
        granted.iter().any(|p| p == "core:window:allow-set-title"),
        "capabilities/default.json must grant core:window:allow-set-title          (core:default covers only the title getter). Granted: {granted:?}"
    );
}

/// A webview-requested exit code has to survive the event loop. The wry
/// runtime translates an `AppHandle::exit(code)` request into tao's
/// `ControlFlow::Exit` — an alias for `ExitWithCode(0)` — so the loop's
/// own code is 0 however the exit was asked for, and the requested code
/// is only ever seen on `RunEvent::ExitRequested`. Verified in a real
/// run: a `--connect-on-start --perf-capture-secs` launch that failed to
/// connect invoked `exit_process(1)`, wrote no report, and the shell saw
/// exit 0. ADR 0031's failure contract needs the non-zero code to reach
/// the launching CLI, so the requested code wins here.
#[test]
fn a_requested_exit_code_beats_the_event_loops_own() {
    assert_eq!(final_exit_code(Some(1), 0), 1);
    assert_eq!(final_exit_code(Some(0), 0), 0);
}

/// A normal quit (window close) requests no code, so nothing overrides
/// what the event loop returned.
#[test]
fn an_unrequested_exit_keeps_the_event_loops_code() {
    assert_eq!(final_exit_code(None, 0), 0);
    assert_eq!(final_exit_code(None, 3), 3);
}

// ---- BLF import benchmarks -----------------------------------------
//
// Attribution for the one shared ingest pathway (ADR 0046): where a file
// import's per-frame budget actually goes. Not part of the default suite
// (it synthesizes a multi-million-frame BLF and walks it several times).
// Run with:
//
//   cargo test -p cannet-gui --release bench_blf_import \
//       -- --ignored --nocapture
//
// `CANNET_BENCH_FRAMES` overrides the capture size — a debug-build run
// wants far fewer frames than a release one to finish in the same time,
// and comparing the two is part of what the harness is for.
//
// Every phase walks the *same* synthetic capture, so the numbers
// subtract:
//
//   census   — the pre-pass that builds the channel -> bus mapping
//   markers  — the whole-file second decode the notes pre-pass ran
//   decode   — `next_frame()` alone: inflate + per-object decode
//   convert  — decode + `RawTraceFrame::from` + routing + verifier probe
//   full     — convert + `TraceStore::append` against the disk store
//   full+obs — full, with the flusher and the 10 Hz status/tail readout
//              the running app puts on the same store lock
//
// The capture is synthesized here on purpose — no user capture ever
// enters the repo, and a generated one makes the numbers reproducible on
// any machine.

/// Frame count for [`bench_blf_import`], overridable through
/// `CANNET_BENCH_FRAMES`.
fn bench_frames(default: usize) -> usize {
    std::env::var("CANNET_BENCH_FRAMES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Write a synthetic BLF of `frames` classic frames spread over
/// `channels` wire channels, with `markers` `GLOBAL_MARKER` records
/// interleaved. Returns the path and the file's size in bytes.
///
/// Payload bytes come from a cheap xorshift so the log deflates like a
/// real bus recording rather than like a run of constants — inflate is
/// the reader's single biggest per-byte cost, and an over-compressible
/// fixture would flatter it.
fn synth_import_blf(
    dir: &std::path::Path,
    frames: usize,
    channels: u8,
    markers: usize,
) -> (std::path::PathBuf, u64) {
    use cannet_blf::BlfCaptureWriter;
    let path = dir.join("synthetic.blf");
    let mut writer = BlfCaptureWriter::create(&path).unwrap();
    let base_ns = 1_700_000_000_u64 * 1_000_000_000;
    // 800 ns spacing: the aggregate density of a busy multi-bus capture.
    let step_ns = 800_u64;
    let marker_every = if markers == 0 {
        usize::MAX
    } else {
        frames / markers.max(1)
    };
    let mut rng = 0x2545_F491_4F6C_DD1D_u64;
    for i in 0..frames {
        let ts = base_ns + i as u64 * step_ns;
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let frame = cannet_core::CanFrame::classic(
            ts,
            u8::try_from(i % usize::from(channels)).unwrap(),
            // A few hundred distinct ids, the order a real vehicle bus
            // carries, so the store's per-key maps see a realistic key
            // space rather than a handful of hot entries.
            cannet_core::CanId::standard(0x100 + u32::try_from(i % 512).unwrap()).unwrap(),
            Direction::Rx,
            rng.to_le_bytes().to_vec(),
        )
        .unwrap();
        writer.append(&frame).unwrap();
        if marker_every != usize::MAX && i > 0 && i % marker_every == 0 {
            writer
                .append_marker(ts, &format!("mark {i}"), &format!("m-{i}"), 0)
                .unwrap();
        }
    }
    let outcome = writer.finish().unwrap();
    (path, outcome.byte_size)
}

#[test]
#[ignore = "BLF import benchmark; run with --ignored --nocapture"]
#[allow(clippy::cast_precision_loss, clippy::too_many_lines)]
fn bench_blf_import() {
    use cannet_blf::BlfCanFrameSource;
    use cannet_core::CanFrameSource as _;
    use std::sync::atomic::{AtomicBool, Ordering};

    const CHANNELS: u8 = 4;
    let frames = bench_frames(2_000_000);

    let scratch = tempfile::TempDir::new().unwrap();
    let wrote = std::time::Instant::now();
    let (path, bytes) = synth_import_blf(scratch.path(), frames, CHANNELS, 8);
    println!(
        "[bench] synthesized {frames} frames ({:.0} MiB on disk) in {:.1} s",
        bytes as f64 / (1024.0 * 1024.0),
        wrote.elapsed().as_secs_f64(),
    );
    let blf = path.to_str().unwrap().to_string();

    let report = |phase: &str, secs: f64| {
        println!(
            "[bench] {phase:<10} {:>8.2} s  {:>9.0} frames/s  {:>7.2} us/frame",
            secs,
            frames as f64 / secs,
            secs * 1e6 / frames as f64,
        );
    };

    // -- census: the channel -> bus mapping pre-pass.
    let t = std::time::Instant::now();
    let census = cannet_blf::scan_blf(&blf).unwrap();
    report("census", t.elapsed().as_secs_f64());
    assert_eq!(census.channels.len(), usize::from(CHANNELS));

    // -- markers: the whole-file second decode the notes pre-pass ran.
    let t = std::time::Instant::now();
    let notes = read_notes_from_blf(&blf).unwrap();
    report("markers", t.elapsed().as_secs_f64());
    assert!(!notes.is_empty(), "marker pre-pass must see the markers");

    // -- decode: `next_frame()` alone (inflate + per-object decode).
    let mut source = BlfCanFrameSource::open(&blf).unwrap();
    let t = std::time::Instant::now();
    let mut n = 0usize;
    while let Some(frame) = source.next_frame().unwrap() {
        std::hint::black_box(&frame);
        n += 1;
    }
    report("decode", t.elapsed().as_secs_f64());
    assert_eq!(n, frames);

    // -- convert: + `RawTraceFrame::from`, routing, and the verifier probe.
    let channel_to_bus: Vec<(u8, Option<String>)> = (0..CHANNELS)
        .map(|c| (c, Some(format!("bus{c}"))))
        .collect();
    let verifier = verification::VerificationState::default();
    let mut source = BlfCanFrameSource::open(&blf).unwrap();
    let t = std::time::Instant::now();
    let mut kept = 0usize;
    while let Some(frame) = source.next_frame().unwrap() {
        let mut raw = RawTraceFrame::from(frame);
        let Ok(bid) = route_channel(raw.channel, &channel_to_bus) else {
            continue;
        };
        raw.bus_id = bid;
        let _checked = verifier.wants(&raw).then(|| raw.clone());
        kept += 1;
        std::hint::black_box(&raw);
    }
    report("convert", t.elapsed().as_secs_f64());
    assert_eq!(kept, frames);

    // -- full: the whole shared pump body against the production
    //    disk-spill store, with and without the observers the running
    //    app puts on the same lock.
    for observers in [false, true] {
        let store_dir = tempfile::TempDir::new().unwrap();
        let store = Arc::new(TraceStore::new_disk(store_dir.path()).unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let watchers: Vec<std::thread::JoinHandle<()>> = if observers {
            let flusher = {
                let (store, stop) = (Arc::clone(&store), Arc::clone(&stop));
                std::thread::spawn(move || {
                    let mut last = 0usize;
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        let len = store.len();
                        if len != last {
                            let _ = store.flush_async();
                            last = len;
                        }
                    }
                })
            };
            // The `trace-grew` emitter: one `status_snapshot` plus a
            // live-tail slice every 100 ms, both under the store lock.
            let grew = {
                let (store, stop) = (Arc::clone(&store), Arc::clone(&stop));
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        let snap = store.status_snapshot();
                        let end = snap.len;
                        let begin = end.saturating_sub(200);
                        std::hint::black_box(store.slice(begin, end));
                    }
                })
            };
            vec![flusher, grew]
        } else {
            Vec::new()
        };
        let mut source = BlfCanFrameSource::open(&blf).unwrap();
        let t = std::time::Instant::now();
        let mut first = true;
        while let Some(frame) = source.next_frame().unwrap() {
            let mut raw = RawTraceFrame::from(frame);
            let Ok(bid) = route_channel(raw.channel, &channel_to_bus) else {
                continue;
            };
            raw.bus_id = bid;
            if first {
                store.start_session(raw.timestamp_ns);
                first = false;
            }
            let checked = verifier.wants(&raw).then(|| raw.clone());
            if store.append(raw).is_some() {
                std::hint::black_box(&checked);
            }
        }
        let secs = t.elapsed().as_secs_f64();
        stop.store(true, Ordering::Relaxed);
        for w in watchers {
            w.join().unwrap();
        }
        report(if observers { "full+obs" } else { "full" }, secs);
        assert_eq!(store.len(), frames);
    }
}
