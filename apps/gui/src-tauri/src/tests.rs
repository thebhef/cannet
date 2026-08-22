//! Unit tests for the host crate's command modules.
//!
//! Relocated wholesale from `lib.rs` when that god-file was split; the
//! suite shares helpers (`test_state`, `loaded`, `tiny_dbc`, …) across
//! what are now several modules, so it stays one cohesive `tests` module
//! resolving crate-internal items through `use super::*` at the crate root.

use super::*;
use cannet_core::{CanFramePayload, Direction};

/// The bus test frames arrive on unless a test says otherwise: the
/// store holds no bus-less frame, so every test frame names one.
const TEST_BUS: &str = "bus0";

fn dummy_frame(ts_ns: u64, id: u32) -> RawTraceFrame {
    RawTraceFrame {
        timestamp_ns: ts_ns,
        channel: 0,
        id,
        extended: false,
        direction: Direction::Rx,
        payload: CanFramePayload::Classic(vec![]),
        bus_id: Some(TEST_BUS.to_string()),
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

fn snap(id: u32, channel: u8, rate: f64, bus: &str) -> ByIdSnapshot {
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
            bus_id: bus.into(),
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
        snap(0x200, 1, 0.0, "b"),
        snap(0x100, 0, 0.0, "b"),
        snap(0x100, 2, 0.0, "b"),
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
        snap(0x100, 0, 5.0, "b"),
        snap(0x200, 0, 50.0, "b"),
        snap(0x300, 0, 0.5, "b"),
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
fn sort_by_id_orders_by_bus_name_unknown_buses_by_raw_id() {
    // Sorts by the resolved bus *name*. A bus the project no longer
    // knows falls back to its raw id, which sorts among the names.
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
        snap(0x100, 0, 0.0, "b1"), // Powertrain
        snap(0x200, 0, 0.0, "zz"), // unknown bus -> "zz"
        snap(0x300, 0, 0.0, "b2"), // Chassis
        snap(0x400, 0, 0.0, "z"),  // unknown bus -> "z"
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
        with_ecu(snap(0x100, 0, 0.0, "b"), Some("Zonal")),
        snap(0x200, 0, 0.0, "b"), // undecoded
        with_ecu(snap(0x300, 0, 0.0, "b"), Some("Bms")),
        with_ecu(snap(0x400, 0, 0.0, "b"), None), // Vector__XXX
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
        .push(loaded_scoped("modes.dbc", MUX_SNAPSHOT_DBC, &[TEST_BUS]));
    // What add_dbc does after a DBC-set change — installs the
    // trace store's mux-selector extractor.
    invalidate_derived_caches(&state);
    state
}

fn fetch_all_signals(state: &AppState, end: u64) -> Vec<SignalSnapshotRecord> {
    let sel = SignalSelection {
        keys: vec![],
        // The canonical path starts with the bus segment (ADR 0038), and
        // every frame is on a bus now, so the pattern names it.
        patterns: vec![format!("^{TEST_BUS}/Zonal/Modes/")],
    };
    fetch_signal_page_inner(state, &sel, None, 0, end, None, None, vec![], None, 0, 100)
        .expect("valid pattern")
        .rows
        .iter()
        .filter_map(ipc::SignalPageRow::signal)
        .cloned()
        .collect()
}

#[test]
fn descriptor_snapshot_is_reused_across_calls_and_dropped_on_dbc_change() {
    // `fetch_signal_page` must not rebuild the descriptor universe per
    // call — the DBC panel's value column and every signal view poll
    // it a few times a second, and the rebuild is O(signals × buses)
    // with a sort on top.
    let state = mux_snapshot_state();
    let first = state.scoped_descriptor_snapshot();
    assert!(!first.is_empty());
    // Same inputs → literally the same allocation, no rebuild.
    assert!(Arc::ptr_eq(&first, &state.scoped_descriptor_snapshot()));
    // A DBC-set change drops it, so a removed DBC's signals can't
    // linger in the snapshot.
    state.databases.lock().unwrap().clear();
    invalidate_derived_caches(&state);
    let after = state.scoped_descriptor_snapshot();
    assert!(!Arc::ptr_eq(&first, &after));
    assert!(after.is_empty());
}

#[test]
fn fetch_signal_page_scopes_to_source_buses() {
    // A signal view is a sink with `sources` wiring: restricted to
    // specific buses, descriptors outside them don't exist for it.
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
        Some(&["powertrain".to_string()]),
        0,
        100,
    )
    .unwrap();
    assert_eq!(page.count, 0); // fixture descriptors are on TEST_BUS
    let unrestricted = fetch_signal_page_inner(
        &state,
        &sel,
        None,
        0,
        u64::MAX,
        None,
        None,
        vec![],
        None,
        0,
        100,
    )
    .unwrap();
    assert_eq!(unrestricted.count, 4);
}

#[test]
fn fetch_signal_page_holds_every_mux_group_simultaneously() {
    // The mux-group stress case: decoding only the message's latest
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
        // The canonical path starts with the bus segment (ADR 0038), and
        // every frame is on a bus now, so the pattern names it.
        patterns: vec![format!("^{TEST_BUS}/Zonal/Modes/")],
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
        // The canonical path starts with the bus segment (ADR 0038), and
        // every frame is on a bus now, so the pattern names it.
        patterns: vec![format!("^{TEST_BUS}/Zonal/Modes/")],
    };
    let sections = ipc::SignalSections {
        names: vec!["Modes".to_string()],
        assignments: [
            (format!("{TEST_BUS}|s:512:ModeA"), "Modes".to_string()),
            (format!("{TEST_BUS}|s:512:ModeB"), "Modes".to_string()),
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
        buses: vec![TEST_BUS.to_string()],
    }];
    let decoded = decode_against(&plain_model(&dbs), &frame_with_data(0x100)).unwrap();
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
        split_messages: Mutex::new(None),
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
        import_cancel: Mutex::new(None),
        live_tail_rows: std::sync::atomic::AtomicU64::new(0),
        active_project_id: Mutex::new(None),
        watched_project: Mutex::new(crate::watched_file::WatchedFile::default()),
        view_signals: Mutex::new(crate::view_signals::ViewSignalRegistry::default()),
        signal_dbc_picks: Mutex::new(std::sync::Arc::default()),
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
        channel_to_bus: vec![(0, "p".into())],
        stop: Arc::new(AtomicBool::new(false)),
        clock: None,
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

/// [`TEST_BUS`] as an assignment set, for the tests that hand a
/// `DbcScope` its buses directly.
pub(crate) fn test_bus_scope() -> Vec<String> {
    vec![TEST_BUS.to_string()]
}

/// The loaded set as a decode model with **no** per-signal picks —
/// the load-order default, which is what a test that isn't about
/// ambiguity resolution wants.
pub(crate) fn plain_model(dbs: &[LoadedDbc]) -> crate::signal_fingerprint::DecodeModel<'_> {
    crate::signal_fingerprint::DecodeModel::plain(crate::app_state::dbc_scopes(dbs))
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
    let slice = |dbs: &crate::signal_fingerprint::DecodeModel<'_>| {
        state.signal_caches.slice(
            Some(TEST_BUS),
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
    assert!(
        slice(&crate::signal_fingerprint::DecodeModel::plain(Vec::new())).is_empty(),
        "no DBC -> nothing decodes"
    );

    // The DBC arrives — into the *project*, assigned to the bus the
    // frames are on, because that is the set `invalidate_derived_caches`
    // judges the live caches against. Plant an active filter index too
    // (a filtered view would have one) so we can see it reset.
    let entry = loaded_scoped("late.dbc", &tiny_dbc(256, "Msg", "S"), &[TEST_BUS]);
    let db = entry.db.clone();
    *state.databases.lock().unwrap() = vec![entry];
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
        slice(&crate::signal_fingerprint::DecodeModel::plain(vec![
            crate::signal_fingerprint::DbcScope {
                path: "late.dbc",
                db: db.as_ref(),
                buses: &test_bus_scope(),
            }
        ]))
        .len(),
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
    *state.databases.lock().unwrap() = vec![loaded_scoped("mixed.dbc", dbc, &[TEST_BUS])];
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
    *state.databases.lock().unwrap() = vec![
        loaded_scoped("a.dbc", &dbc_a, &[TEST_BUS]),
        loaded_scoped("b.dbc", &dbc_b, &[TEST_BUS]),
    ];

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
    let elsewhere = frame_with_data(256); // on TEST_BUS, which neither DBC scopes to
    state.trace_store.append(on_p);
    state.trace_store.append(on_c);
    state.trace_store.append(elsewhere);

    let r = collect_trace_records(&state, 0, 3);
    let name = |i: usize| r[i].decoded.as_ref().map(|d| d.name.clone());
    assert_eq!(name(0).as_deref(), Some("FromBusP"));
    assert_eq!(name(1).as_deref(), Some("FromBusC"));
    // A frame from outside every scope matches no DBC.
    assert_eq!(name(2), None);
}

#[test]
fn list_value_tables_inner_resolves_per_bus() {
    // Two DBCs define the same message/signal (256 / "A") with
    // different VAL_ tables, each scoped to a different bus. A
    // bus-scoped lookup must read its own bus's table — not whichever
    // DBC loaded first.
    let state = test_state();
    let dbc_p = format!(
        "{}VAL_ 256 A 0 \"Park\" 1 \"Drive\" ;\n",
        tiny_dbc(256, "Msg", "A"),
    );
    let dbc_c = format!(
        "{}VAL_ 256 A 0 \"Open\" 1 \"Closed\" ;\n",
        tiny_dbc(256, "Msg", "A"),
    );
    *state.databases.lock().unwrap() = vec![
        loaded_scoped("p.dbc", &dbc_p, &["p"]),
        loaded_scoped("c.dbc", &dbc_c, &["c"]),
    ];

    let labels = |bus: Option<&str>| -> Vec<String> {
        list_value_tables_inner(&state, 256, false, "A", false, bus)
            .into_iter()
            .map(|e| e.label)
            .collect()
    };

    assert_eq!(labels(Some("p")), vec!["Park", "Drive"]);
    assert_eq!(labels(Some("c")), vec!["Open", "Closed"]);

    // A lookup that names no bus resolves through no database: every
    // frame has a bus, so "the bus is unknown" is not a state a
    // DBC-backed series can be in, and the old answer (the first
    // database that defines the signal, whatever it is assigned to)
    // could only ever be a guess.
    assert!(labels(None).is_empty());
}

#[test]
fn enum_labels_come_from_the_database_that_defines_the_signal() {
    // Two databases assigned to one bus both define 256 / "A", and
    // only the second carries a `VAL_` table for it. The first
    // defines the signal, so it is the one definition every decoded
    // value of A comes from — and the labels attached to that value
    // are its own (ADR 0054). Borrowing the other file's table would
    // label a value that database never produced.
    let state = test_state();
    let plain = tiny_dbc(256, "Msg", "A");
    let labelled = format!(
        "{}VAL_ 256 A 0 \"Zero\" 1 \"One\" ;\n",
        tiny_dbc(256, "Msg", "A"),
    );
    let labels = |state: &AppState| -> Vec<String> {
        list_value_tables_inner(state, 256, false, "A", false, Some("p"))
            .into_iter()
            .map(|e| e.label)
            .collect()
    };

    *state.databases.lock().unwrap() = vec![
        loaded_scoped("a.dbc", &plain, &["p"]),
        loaded_scoped("b.dbc", &labelled, &["p"]),
    ];
    assert!(
        labels(&state).is_empty(),
        "a.dbc decodes A and names no labels, so A has none",
    );

    // Load order reversed: the labelled database now supplies the
    // definition, so its table is the answer.
    *state.databases.lock().unwrap() = vec![
        loaded_scoped("b.dbc", &labelled, &["p"]),
        loaded_scoped("a.dbc", &plain, &["p"]),
    ];
    assert_eq!(labels(&state), vec!["Zero", "One"]);

    // A database ahead of the winner that does not define the signal
    // at all is not a competing definition — it just isn't in the
    // running, and the first one that *does* define A still answers.
    *state.databases.lock().unwrap() = vec![
        loaded_scoped("other.dbc", &tiny_dbc(512, "Other", "Z"), &["p"]),
        loaded_scoped("b.dbc", &labelled, &["p"]),
    ];
    assert_eq!(labels(&state), vec!["Zero", "One"]);
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
        loaded_scoped(
            "a.dbc",
            &tiny_dbc(256, "String1JustDetectedFault", "Sa"),
            &[TEST_BUS],
        ),
        loaded_scoped("b.dbc", &tiny_dbc(512, "BrakeStatus", "Sb"), &[TEST_BUS]),
    ];
    let filter: FilterPredicate =
        serde_json::from_str(r#"{"name_regex": "String1JustDetected.*?"}"#).unwrap();
    let frames: Vec<RawTraceFrame> = [256, 512, 999, 256]
        .iter()
        .map(|&id| frame_with_data(id))
        .collect();

    let candidates = decode_candidate_ids(&dbs, &filter);
    let model = plain_model(&dbs);
    let gated: Vec<bool> = frames
        .iter()
        .map(|f| {
            let decoded = if candidates.contains(&f.id) {
                decode_against(&model, f)
            } else {
                None
            };
            filter.matches(f, decoded.as_ref())
        })
        .collect();
    let unconditional: Vec<bool> = frames
        .iter()
        .map(|f| filter.matches(f, decode_against(&model, f).as_ref()))
        .collect();
    assert_eq!(gated, unconditional);
    assert_eq!(gated, vec![true, false, false, true]);
}

#[test]
fn apply_filter_drops_records_that_dont_pass() {
    // Two records, same id, different buses. A `{bus: "p"}` filter
    // keeps the first only.
    let mut r1 = TraceFrameRecord::from_raw(0, &frame_with_data(256), None);
    r1.bus_id = "p".into();
    let mut r2 = TraceFrameRecord::from_raw(1, &frame_with_data(256), None);
    r2.bus_id = "c".into();
    let predicate: FilterPredicate = serde_json::from_str(r#"{"bus": "p"}"#).unwrap();
    let filtered = apply_filter_records(vec![r1.clone(), r2], Some(&predicate));
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].bus_id, "p");
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
    let m = vec![(0u8, "p".to_string()), (2, "c".into())];
    assert_eq!(route_channel(0, &m), Some("p".into()));
    assert_eq!(route_channel(2, &m), Some("c".into()));
    // A channel with no entry maps to no bus, so its frames are
    // dropped. The import dialog's "(skip)" and a channel the caller
    // never mentioned are one and the same outcome: there is no third
    // answer where a frame arrives without a bus.
    assert_eq!(route_channel(1, &m), None);
    assert_eq!(route_channel(7, &m), None);
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
fn a_database_assigned_to_no_bus_decodes_nothing_until_it_is_assigned() {
    // Bus assignment is the decode boundary: loading a file makes it
    // available, assigning it to a bus makes it decode. An unassigned
    // database answers for no frame on any bus — it is not the "applies
    // everywhere" default it used to be.
    let state = test_state();
    let dbc = tiny_dbc(256, "Anywhere", "Sig");
    *state.databases.lock().unwrap() = vec![loaded("any.dbc", &dbc)];
    let mut on_p = frame_with_data(256);
    on_p.bus_id = Some("p".into());
    state.trace_store.append(on_p);
    state.trace_store.append(frame_with_data(256));
    let r = collect_trace_records(&state, 0, 2);
    assert!(
        r.iter().all(|row| row.decoded.is_none()),
        "an unassigned database decoded a frame",
    );

    // Assigned to one of the two buses, it decodes that bus's frame —
    // and only that one.
    state.databases()[0].buses = vec!["p".to_string()];
    invalidate_derived_caches(&state);
    let r = collect_trace_records(&state, 0, 2);
    assert_eq!(
        r[0].decoded.as_ref().map(|d| d.name.clone()).as_deref(),
        Some("Anywhere"),
    );
    assert!(r[1].decoded.is_none(), "the other bus stays undecoded");
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
        loaded_scoped("std.dbc", &standard_dbc, &[TEST_BUS]),
        loaded_scoped("ext.dbc", &extended_dbc, &[TEST_BUS]),
    ];
    let on = Some(TEST_BUS);

    let std_desc = describe_message_inner(&state, on, 0x100, false).unwrap();
    assert_eq!(std_desc.name, "Std");

    let ext_desc = describe_message_inner(&state, on, 0x001A_BCDE, true).unwrap();
    assert_eq!(ext_desc.name, "Ext");

    // The extended id's raw value doesn't collide with a standard
    // lookup at the same message table.
    assert!(describe_message_inner(&state, on, 0x001A_BCDE, false).is_none());

    // A transmit row on another bus — or on none at all — describes
    // nothing: only a database assigned to the row's bus may answer.
    assert!(describe_message_inner(&state, Some("elsewhere"), 0x100, false).is_none());
    assert!(describe_message_inner(&state, None, 0x100, false).is_none());
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
        loaded_scoped("std.dbc", &standard_dbc, &[TEST_BUS]),
        loaded_scoped("ext.dbc", &extended_dbc, &[TEST_BUS]),
    ];
    let data = vec![42u8, 0, 0, 0, 0, 0, 0, 0];
    let on = Some(TEST_BUS);

    let std_decoded = decode_frame_inner(&state, on, 0x100, false, &data).unwrap();
    assert_eq!(std_decoded.name, "Std");

    let ext_decoded = decode_frame_inner(&state, on, 0x001A_BCDE, true, &data).unwrap();
    assert_eq!(ext_decoded.name, "Ext");

    // The panel-side decode is scoped exactly like the wire-side one.
    assert!(decode_frame_inner(&state, Some("elsewhere"), 0x100, false, &data).is_none());
    assert!(decode_frame_inner(&state, None, 0x100, false, &data).is_none());
}

#[test]
fn encode_frame_inner_writes_signal_bits_through_first_matching_dbc() {
    // Two-byte signal `Sig` lives in byte 0 (factor 1, offset 0).
    // Encoding physical=42 writes byte 0 = 42 and leaves the rest
    // of base alone.
    let state = test_state();
    let dbc = tiny_dbc(256, "M", "Sig");
    *state.databases.lock().unwrap() = vec![loaded_scoped("any.dbc", &dbc, &[TEST_BUS])];
    let base = vec![0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11];
    let resp = encode_frame_inner(
        &state,
        Some(TEST_BUS),
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

    // A row on a bus the database is not assigned to has no DBC to
    // encode through, the same way it would have none to decode with.
    let err = encode_frame_inner(
        &state,
        Some("elsewhere"),
        256,
        false,
        &[ipc::EncodeFrameSignal {
            name: "Sig".into(),
            physical: 42.0,
        }],
        vec![0u8; 8],
    )
    .unwrap_err();
    assert!(err.contains("no DBC matches"), "{err}");
}

#[test]
fn encode_frame_inner_reports_unknown_signal_in_skipped() {
    let state = test_state();
    let dbc = tiny_dbc(256, "M", "Sig");
    *state.databases.lock().unwrap() = vec![loaded_scoped("any.dbc", &dbc, &[TEST_BUS])];
    let resp = encode_frame_inner(
        &state,
        Some(TEST_BUS),
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
    let err =
        encode_frame_inner(&state, Some(TEST_BUS), 0x123, false, &[], vec![0u8; 8]).unwrap_err();
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
        channel_to_bus: vec![(0, "p".into())],
        stop: Arc::new(AtomicBool::new(false)),
        clock: None,
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
        .push(loaded_scoped("test.dbc", &dbc_text, &["p"]));

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
    let db_refs = state.decode_model(&dbs_guard);
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
        .push(loaded_scoped("test.dbc", &dbc_text, &["p", "q"]));

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
        let channel_to_bus = vec![(1u8, "q".to_string())];
        while !stop_for_pump.load(Ordering::Relaxed) {
            let Some(frame) = cannet_core::CanFrameSource::next_frame(&mut adapter)
                .ok()
                .flatten()
            else {
                break;
            };
            let mut raw = RawTraceFrame::from(frame);
            if let Some(bid) = route_channel(raw.channel, &channel_to_bus) {
                raw.bus_id = Some(bid);
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
        channel_to_bus: vec![(0, "p".into()), (1, "q".into())],
        stop: Arc::new(AtomicBool::new(false)),
        clock: None,
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
    let db_refs = state.decode_model(&dbs_guard);

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

/// Read a BLF's notes exactly the way an import does: drain the frame
/// source with a marker sink attached and project what it hands back.
/// One pass, no second walk — the same shape `open_log` uses, so these
/// round-trip assertions pin the production path rather than a
/// test-only reader.
fn notes_via_import_walk(blf_path: &str) -> Vec<crate::notes::Note> {
    use crate::notes::Note;
    use cannet_core::CanFrameSource as _;
    let collected: Arc<Mutex<Vec<Note>>> = Arc::default();
    let mut source = cannet_blf::BlfCanFrameSource::open(blf_path).unwrap();
    source.on_marker({
        let collected = Arc::clone(&collected);
        let mut synthetic_idx = 0u64;
        move |m| {
            let note = capture::note_from_marker(&m, &mut synthetic_idx);
            collected.lock().unwrap().push(note);
        }
    });
    while source.next_frame().unwrap().is_some() {}
    let notes = collected.lock().unwrap().clone();
    notes
}

/// Round-trip: write the trace-store contents + notes via
/// `write_blf_capture`, then read it back through the import's own
/// one-pass walk — frames from `BlfCanFrameSource`, markers from the
/// sink riding the same pass. The frame ids and the marker count must
/// match the input.
#[test]
fn write_blf_capture_round_trips_frames_and_notes() {
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

    let outcome = write_blf_capture(
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
    let recovered = notes_via_import_walk(dest.to_str().unwrap());
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

/// The import time range (ADR 0046): `open_log` wraps the
/// BLF source in `cannet_core::WindowedSource` ahead of `run_pump`, so
/// the range is a filter at the `CanFrameSource` seam and not a second
/// ingest path. This drives the identical per-frame body `run_pump`
/// runs (windowed source → `RawTraceFrame::from` → `route_channel` →
/// `TraceStore::append`) — the pieces `run_pump` itself is built from —
/// against a real disk-backed `TraceStore`, without needing a Tauri
/// `AppHandle` to call the command. Frames outside the selected range
/// must never reach `TraceStore::append`; the boundary frames (at
/// exactly `start_ns` / `end_ns`) must.
#[test]
fn windowed_import_range_keeps_only_the_selected_frames_out_of_the_trace_store() {
    use cannet_blf::BlfCanFrameSource;
    use cannet_core::{CanFrameSource as _, WindowedSource};

    let dir = tempfile::tempdir().unwrap();
    let blf_path = dir.path().join("windowed-import.blf");
    let ts_base = 1_700_000_000_000_000_000u64;
    let frame_at = |ts: u64| {
        cannet_core::CanFrame::classic(
            ts,
            0,
            cannet_core::CanId::standard(0x100).unwrap(),
            Direction::Rx,
            vec![1],
        )
        .unwrap()
    };
    {
        let mut writer = cannet_blf::BlfCaptureWriter::create(&blf_path).unwrap();
        for offset_us in [0u64, 1_000, 2_000, 3_000, 4_000] {
            writer
                .append(&frame_at(ts_base + offset_us * 1_000))
                .unwrap();
        }
        writer.finish().unwrap();
    }

    let scratch = tempfile::TempDir::new().unwrap();
    let store_dir = scratch.path().join("current");
    std::fs::create_dir_all(&store_dir).unwrap();
    let store = open_trace_store(&store_dir);

    let source = BlfCanFrameSource::open(&blf_path).unwrap();
    // Same bound arithmetic `open_log` hands `WindowedSource`: inclusive
    // start at the second frame, inclusive end at the fourth.
    let mut windowed =
        WindowedSource::new(source, Some(ts_base + 1_000_000), Some(ts_base + 3_000_000));
    // Every channel the fixture writes has to be mapped: an unmapped
    // channel's frames are dropped, so an empty mapping would import
    // nothing at all.
    let channel_to_bus: Vec<(u8, String)> = vec![(0, "b".into())];
    while let Some(frame) = windowed.next_frame().unwrap() {
        let mut raw = trace_store::RawTraceFrame::from(frame);
        let Some(bid) = route_channel(raw.channel, &channel_to_bus) else {
            continue;
        };
        raw.bus_id = Some(bid);
        store.append(raw);
    }

    let kept = store.slice(0, store.len());
    let kept_ts: Vec<u64> = kept.iter().map(|f| f.timestamp_ns).collect();
    assert_eq!(
        kept_ts,
        vec![
            ts_base + 1_000_000,
            ts_base + 2_000_000,
            ts_base + 3_000_000,
        ],
        "only the in-range frames (boundaries inclusive) reached the trace store",
    );
}

/// An import routes the channels its mapping names and **drops the
/// rest**. A CAN frame without a bus is not a thing the store holds, so
/// the import dialog's "(skip)" and a channel the caller never
/// mentioned reach the same end: those frames never get appended.
///
/// Drives the same per-frame body `run_pump` runs (`RawTraceFrame::from`
/// → `route_channel` → `TraceStore::append`) against a real
/// `TraceStore`, without needing a Tauri `AppHandle`.
#[test]
fn an_import_drops_the_frames_of_a_channel_no_bus_is_mapped_to() {
    use cannet_blf::BlfCanFrameSource;
    use cannet_core::CanFrameSource as _;

    let dir = tempfile::tempdir().unwrap();
    let blf_path = dir.path().join("two-channels.blf");
    let ts_base = 1_700_000_000_000_000_000u64;
    {
        let mut writer = cannet_blf::BlfCaptureWriter::create(&blf_path).unwrap();
        for (i, channel) in [0u8, 1, 0, 1].into_iter().enumerate() {
            let frame = cannet_core::CanFrame::classic(
                ts_base + i as u64 * 1_000_000,
                channel,
                cannet_core::CanId::standard(0x100 + u32::from(channel)).unwrap(),
                Direction::Rx,
                vec![1],
            )
            .unwrap();
            writer.append(&frame).unwrap();
        }
        writer.finish().unwrap();
    }

    let store = TraceStore::new();
    // Channel 1 is deliberately absent — the "(skip)" choice.
    let channel_to_bus: Vec<(u8, String)> = vec![(0, "powertrain".into())];
    let mut source = BlfCanFrameSource::open(&blf_path).unwrap();
    while let Some(frame) = source.next_frame().unwrap() {
        let mut raw = trace_store::RawTraceFrame::from(frame);
        let Some(bid) = route_channel(raw.channel, &channel_to_bus) else {
            continue;
        };
        raw.bus_id = Some(bid);
        store.append(raw);
    }

    let kept = store.slice(0, store.len());
    assert_eq!(kept.len(), 2, "only the mapped channel's frames landed");
    assert!(
        kept.iter().all(|f| f.channel == 0),
        "a frame from the unmapped channel reached the store",
    );
    assert!(
        kept.iter()
            .all(|f| f.bus_id.as_deref() == Some("powertrain")),
        "every stored frame carries the bus its channel was mapped to",
    );
}

/// Path to one of the committed `examples/time-origins/` captures — the
/// import-time-origin fixture set (ADR 0024). Small enough to open by
/// hand; regenerated by the `gen_time_origin_fixtures` (cannet-blf) and
/// `gen_mdf_time_origin_fixtures` (cannet-mdf) examples.
fn time_origin_fixture(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../examples/time-origins")
        .join(name)
}

/// 2024-03-01T12:00:00Z — the wall clock both stated-start fixtures
/// carry.
const TIME_ORIGIN_WALL_CLOCK_NS: u64 = 1_709_294_400_000_000_000;

/// An imported capture's origin is the **earliest** timestamp it brings
/// in, not the first one read (ADR 0024).
///
/// `wall-clock-out-of-order.blf` keeps its earliest two frames (+120 ms,
/// +300 ms) at the end of the file, after 99 frames starting at +500 ms.
/// Anchoring on the first frame read put the origin at +500 ms, and then
/// `TraceStore::append`'s pipeline-drain guard dropped both of the
/// earlier frames — the same guard that keeps a stale live frame out of
/// a freshly cleared session. Drives the pump's own anchor
/// (`anchor_replay_session`) over the real file; the suite has no
/// harness for the `AppHandle` `run_pump` itself needs.
#[test]
fn an_out_of_order_blf_anchors_the_session_at_its_earliest_frame_and_keeps_every_one() {
    use cannet_blf::BlfCanFrameSource;
    use cannet_core::CanFrameSource as _;

    let state = test_state();
    let mut source =
        BlfCanFrameSource::open(time_origin_fixture("wall-clock-out-of-order.blf")).unwrap();
    // Every channel the fixture writes has to be mapped: an unmapped
    // channel's frames are dropped, so an empty mapping would import
    // nothing at all.
    let channel_to_bus: Vec<(u8, String)> = vec![(0, "b".into())];
    let mut anchor: Option<u64> = None;
    let mut read = 0u64;
    while let Some(frame) = source.next_frame().unwrap() {
        read += 1;
        let mut raw = trace_store::RawTraceFrame::from(frame);
        let Some(bid) = route_channel(raw.channel, &channel_to_bus) else {
            continue;
        };
        raw.bus_id = Some(bid);
        crate::session::anchor_replay_session(&state, &mut anchor, raw.timestamp_ns);
        state.trace_store.append(raw);
    }

    assert_eq!(read, 121, "the fixture carries 121 frames");
    assert_eq!(
        state.trace_store.len(),
        121,
        "no frame may be dropped for predating the origin"
    );
    assert_eq!(
        state.trace_store.session_start_ns(),
        TIME_ORIGIN_WALL_CLOCK_NS + 120_000_000,
        "the origin is the file's earliest frame, which is its second-to-last object"
    );
    let start = state.trace_store.session_start_ns();
    let frames = state.trace_store.slice(0, state.trace_store.len());
    assert!(
        frames.iter().all(|f| f.timestamp_ns >= start),
        "every frame renders at a non-negative elapsed time (ADR 0024)"
    );
}

/// A capture whose origin is exactly zero is a capture with an origin.
/// `relative-zero.blf` states no measurement start time, so its frames
/// are offsets from zero (ADR 0024) and the session anchors there — the
/// store has to say "started at 0", not "never started".
#[test]
fn a_blf_with_no_stated_start_time_anchors_the_session_at_zero() {
    use cannet_blf::BlfCanFrameSource;
    use cannet_core::CanFrameSource as _;

    let state = test_state();
    assert!(
        !state.trace_store.session_started(),
        "a store with no capture has no origin at all"
    );

    let mut source = BlfCanFrameSource::open(time_origin_fixture("relative-zero.blf")).unwrap();
    // Every channel the fixture writes has to be mapped: an unmapped
    // channel's frames are dropped, so an empty mapping would import
    // nothing at all.
    let channel_to_bus: Vec<(u8, String)> = vec![(0, "b".into())];
    let mut anchor: Option<u64> = None;
    while let Some(frame) = source.next_frame().unwrap() {
        let mut raw = trace_store::RawTraceFrame::from(frame);
        let Some(bid) = route_channel(raw.channel, &channel_to_bus) else {
            continue;
        };
        raw.bus_id = Some(bid);
        crate::session::anchor_replay_session(&state, &mut anchor, raw.timestamp_ns);
        state.trace_store.append(raw);
    }

    assert_eq!(state.trace_store.len(), 120);
    assert_eq!(state.trace_store.session_start_ns(), 0);
    assert!(
        state.trace_store.session_started(),
        "anchored at zero is an origin, not the absence of one"
    );
}

/// A BLF marker can sit before the file's first frame, and it renders on
/// the same timeline the frames do (ADR 0024/0035). Anchoring the session
/// on the frames alone left it at a negative elapsed time, so the
/// annotations are folded into the origin too.
///
/// `wall-clock-out-of-order.blf` carries one marker at +100 ms, 20 ms
/// below its earliest frame.
#[test]
fn a_blf_marker_before_the_first_frame_lowers_the_session_origin_to_itself() {
    use cannet_blf::BlfCanFrameSource;
    use cannet_core::CanFrameSource as _;

    let state = test_state();
    let mut source =
        BlfCanFrameSource::open(time_origin_fixture("wall-clock-out-of-order.blf")).unwrap();
    // The same sink `open_log` installs, so the markers ride the pump's
    // own walk.
    let collected: Arc<Mutex<Vec<crate::notes::Note>>> = Arc::default();
    source.on_marker({
        let collected = Arc::clone(&collected);
        let mut synthetic_idx = 0u64;
        move |m| {
            collected
                .lock()
                .unwrap()
                .push(crate::capture::note_from_marker(&m, &mut synthetic_idx));
        }
    });

    // Every channel the fixture writes has to be mapped: an unmapped
    // channel's frames are dropped, so an empty mapping would import
    // nothing at all.
    let channel_to_bus: Vec<(u8, String)> = vec![(0, "b".into())];
    let mut anchor: Option<u64> = None;
    while let Some(frame) = source.next_frame().unwrap() {
        let mut raw = trace_store::RawTraceFrame::from(frame);
        let Some(bid) = route_channel(raw.channel, &channel_to_bus) else {
            continue;
        };
        raw.bus_id = Some(bid);
        crate::session::anchor_replay_session(&state, &mut anchor, raw.timestamp_ns);
        state.trace_store.append(raw);
    }
    assert_eq!(
        state.trace_store.session_start_ns(),
        TIME_ORIGIN_WALL_CLOCK_NS + 120_000_000,
        "the frames alone anchor 20 ms above the marker"
    );

    let notes = std::mem::take(&mut *collected.lock().unwrap());
    let notes = crate::capture::settle_import_origin(&state, &mut anchor, notes, None, None, None);

    assert_eq!(notes.len(), 1);
    assert_eq!(
        state.trace_store.session_start_ns(),
        TIME_ORIGIN_WALL_CLOCK_NS + 100_000_000,
        "the origin drops to the marker, the earliest thing the import brought in"
    );
    assert!(notes[0].timestamp_ns >= state.trace_store.session_start_ns());
}

/// An import range is what the import brings in (ADR 0046), so an
/// annotation outside it is not part of the capture — dropped rather
/// than kept and anchored around, which would leave the range's own
/// first frame rendering far from zero.
#[test]
fn a_marker_outside_the_import_range_is_dropped_and_does_not_move_the_origin() {
    let state = test_state();
    let mut anchor: Option<u64> = None;
    let note = |ts: u64, id: &str| crate::notes::Note {
        id: id.into(),
        timestamp_ns: ts,
        label: id.into(),
        kind: crate::notes::EventKind::Note,
        color: None,
    };
    crate::session::anchor_replay_session(&state, &mut anchor, 2_000_000_000);

    let kept = crate::capture::settle_import_origin(
        &state,
        &mut anchor,
        vec![
            note(500_000_000, "before"),
            note(2_500_000_000, "inside"),
            note(9_000_000_000, "after"),
        ],
        None,
        Some(2_000_000_000),
        Some(3_000_000_000),
    );

    assert_eq!(
        kept.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
        vec!["inside"]
    );
    assert_eq!(state.trace_store.session_start_ns(), 2_000_000_000);
}

/// An MDF's earliest content is routinely not a frame: a
/// message-independent signal group and an `##EV` can both start before
/// the first `CAN_DataFrame`. `wall-clock-signals.mf4` has its first
/// frame at +500 ms, an event at +100 ms and a signal sample at +0, so
/// anchoring on the frames put both of the others at a negative elapsed
/// time (ADR 0024).
#[test]
fn an_mdf_whose_signals_start_before_its_frames_anchors_on_the_signals() {
    use cannet_core::CanFrameSource as _;
    use cannet_mdf::MdfCanFrameSource;

    let state = test_state();
    let mut source =
        MdfCanFrameSource::open(time_origin_fixture("wall-clock-signals.mf4")).unwrap();
    let groups = source.signal_groups();
    let mut synthetic_idx = 0u64;
    let notes: Vec<crate::notes::Note> = source
        .events()
        .unwrap()
        .iter()
        .map(|e| crate::capture::note_from_event(e, &mut synthetic_idx))
        .collect();

    // Every channel the fixture writes has to be mapped: an unmapped
    // channel's frames are dropped, so an empty mapping would import
    // nothing at all.
    let channel_to_bus: Vec<(u8, String)> = vec![(0, "b".into())];
    let mut anchor: Option<u64> = None;
    while let Some(frame) = source.next_frame().unwrap() {
        let mut raw = trace_store::RawTraceFrame::from(frame);
        let Some(bid) = route_channel(raw.channel, &channel_to_bus) else {
            continue;
        };
        raw.bus_id = Some(bid);
        crate::session::anchor_replay_session(&state, &mut anchor, raw.timestamp_ns);
        state.trace_store.append(raw);
    }
    assert_eq!(
        state.trace_store.session_start_ns(),
        TIME_ORIGIN_WALL_CLOCK_NS + 500_000_000,
        "the frames alone anchor half a second above the file's own start"
    );

    let signal_origin = crate::capture::signal_origin_ns(&groups, None, None);
    let notes =
        crate::capture::settle_import_origin(&state, &mut anchor, notes, signal_origin, None, None);

    let origin = state.trace_store.session_start_ns();
    assert_eq!(
        origin, TIME_ORIGIN_WALL_CLOCK_NS,
        "the origin is the earliest sample, not the first frame"
    );
    assert_eq!(notes.len(), 2);
    assert!(
        notes.iter().all(|n| n.timestamp_ns >= origin),
        "no event renders at a negative elapsed time"
    );
    assert!(
        groups
            .iter()
            .flat_map(|g| &g.signals)
            .flat_map(|s| &s.timestamps_ns)
            .all(|ts| *ts >= origin),
        "no file-backed sample renders at a negative elapsed time"
    );
}

/// The store has to tell "no capture yet" apart from "a capture anchored
/// at zero", because both read `session_start_ns == 0` and only one of
/// them means the renderers have no origin (ADR 0024). The `trace-grew`
/// payload carries the distinction as `Option<f64>`, so a frontend can
/// no longer infer it from the value.
#[test]
fn a_session_anchored_at_zero_is_told_apart_from_no_session_at_all() {
    let store = TraceStore::new();
    assert!(!store.session_started());
    assert!(!store.status_snapshot().session_started);

    store.start_session(0);

    assert!(store.session_started(), "anchored at zero is anchored");
    assert_eq!(store.session_start_ns(), 0);
    let snap = store.status_snapshot();
    assert!(snap.session_started);
    assert_eq!(snap.session_start_ns, 0);
}

/// `lower_session_start` is the only way the origin moves without
/// emptying the buffer — an import learns its earliest timestamp as it
/// goes, and the frames already appended have to survive the correction.
/// It never raises the anchor: raising it would strand appended frames
/// below the origin, which is the negative-time bug it exists to prevent.
#[test]
fn lowering_the_session_start_keeps_the_frames_and_never_raises_the_anchor() {
    let store = TraceStore::new();
    store.start_session(1_000);
    store.append(dummy_frame(1_500, 0x100));
    store.append(dummy_frame(2_000, 0x101));

    store.lower_session_start(400);
    assert_eq!(store.session_start_ns(), 400);
    assert_eq!(store.len(), 2, "the buffer survives the correction");

    store.lower_session_start(9_000);
    assert_eq!(
        store.session_start_ns(),
        400,
        "an anchor is never raised — that would strand appended frames below it"
    );
    assert_eq!(store.len(), 2);
}

/// The rebuild chip's own query on an ordinary session: nothing was
/// restored, so nothing was discarded, so there is nothing to announce.
/// The fast-path silence the chip depends on.
#[test]
fn a_session_with_nothing_restored_is_not_rebuilding_pyramids() {
    let state = test_state();
    assert!(!pyramids_rebuilding_now(&state).rebuilding);
    // …and it stays quiet once frames arrive by the ordinary route: a
    // live capture builds its pyramids for the first time, which is not
    // the loss this announces.
    state.trace_store.append(dummy_frame(0, 0x100));
    assert!(!pyramids_rebuilding_now(&state).rebuilding);
}

/// `cancel_import` with nothing importing is a no-op, not a panic — the
/// busy launcher it backs isn't perfectly synchronized with the pump's
/// own lifetime.
#[test]
fn cancel_import_now_is_a_no_op_with_nothing_importing() {
    let state = test_state();
    assert!(state.import_cancel().is_none());
    cancel_import_now(&state); // must not panic
}

/// `cancel_import` flips whichever flag is registered in
/// `AppState::import_cancel` — the mechanism `open_log`/`import_mdf`
/// install before spawning their pump and `run_pump`'s loop checks.
#[test]
fn cancel_import_now_flips_the_registered_flag() {
    let state = test_state();
    let flag = Arc::new(AtomicBool::new(false));
    *state.import_cancel() = Some(Arc::clone(&flag));

    cancel_import_now(&state);

    assert!(flag.load(Ordering::Relaxed));
}

/// A census walks the whole capture file before the mapping dialog
/// exists, so it is the phase most of a big import's wait is spent in.
/// It must observe the same `cancel_import` flag the pump does, and
/// report nothing when it stops: a half-walked census has no channel
/// set, no frame count and no span, so there is nothing to hand back
/// and nothing to undo.
#[test]
fn a_cancelled_census_reports_nothing_and_clears_the_flag() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cancel-census.blf");
    write_census_fixture(&path, CENSUS_FIXTURE_FRAMES);

    let state = test_state();
    let raiser = &state;
    let mut checkpoints = 0u32;
    let outcome = census_blf(&state, path.to_str().unwrap(), &mut |_| {
        checkpoints += 1;
        cancel_import_now(raiser);
    })
    .unwrap();

    assert!(outcome.is_none(), "a cancelled census must report nothing");
    assert!(checkpoints > 0, "the walk never reached a checkpoint");
    assert!(
        state.import_cancel().is_none(),
        "the census must clear its own flag however it ended",
    );
}

/// The control for the test above: the same census, nothing cancelling
/// it, walks the whole file. Without this the assertion there could be
/// satisfied by a census that always reports nothing.
#[test]
fn an_uncancelled_census_reports_the_whole_file_and_clears_the_flag() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("full-census.blf");
    write_census_fixture(&path, CENSUS_FIXTURE_FRAMES);

    let state = test_state();
    let mut progress = Vec::new();
    let outcome = census_blf(&state, path.to_str().unwrap(), &mut |p| progress.push(p))
        .unwrap()
        .expect("an uncancelled census completes");

    assert_eq!(outcome.frame_count, CENSUS_FIXTURE_FRAMES);
    assert!(state.import_cancel().is_none());
    assert!(
        progress
            .last()
            .is_some_and(|p| p.bytes_read == p.total_bytes),
        "the last progress report must be the whole file: {progress:?}",
    );
}

/// The MDF census is the same phase over a different format, and is
/// stopped by the same flag. Its walk is over the record stream, so the
/// fixture has to be big enough to cross a checkpoint twice for the same
/// reason the BLF one does.
#[test]
fn a_cancelled_mdf_census_reports_nothing_and_clears_the_flag() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cancel-census.mf4");
    write_mdf_census_fixture(&path, CENSUS_FIXTURE_FRAMES);

    let state = test_state();
    let raiser = &state;
    let mut checkpoints = 0u32;
    let outcome = census_mdf(&state, path.to_str().unwrap(), &mut |_| {
        checkpoints += 1;
        cancel_import_now(raiser);
    })
    .unwrap();

    assert!(outcome.is_none(), "a cancelled census must report nothing");
    assert!(checkpoints > 0, "the walk never reached a checkpoint");
    assert!(state.import_cancel().is_none());
}

/// The control for the test above.
#[test]
fn an_uncancelled_mdf_census_reports_the_whole_file_and_clears_the_flag() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("full-census.mf4");
    write_mdf_census_fixture(&path, CENSUS_FIXTURE_FRAMES);

    let state = test_state();
    let outcome = census_mdf(&state, path.to_str().unwrap(), &mut |_| {})
        .unwrap()
        .expect("an uncancelled census completes");

    assert_eq!(outcome.frame_count, CENSUS_FIXTURE_FRAMES);
    assert!(state.import_cancel().is_none());
}

/// The checkpoints behind a load's progress fire thousands of times a
/// second; the status line must not. The pacer is what stands between
/// them, and it lets exactly one report through per cadence period.
#[test]
fn load_progress_is_paced_rather_than_emitted_per_checkpoint() {
    let mut pacer = ProgressPacer::new();
    let start = std::time::Instant::now();

    assert!(
        !pacer.due(start),
        "a report at the instant the pacer started is not due yet",
    );
    let later = start + std::time::Duration::from_secs(10);
    assert!(pacer.due(later), "a report a cadence later is due");
    assert!(
        !pacer.due(later),
        "the slot is consumed: a second report at the same instant is not due",
    );
}

/// The import pump's progress must be paced too, and the pump's loop is
/// hotter than a census's: it looks at the clock only once per stride,
/// so the stride is what stands between a per-frame `Instant::now()` and
/// the loop. Pinned, because a stride of one would be the expensive
/// mistake this exists to avoid.
#[test]
fn the_import_pump_looks_at_the_clock_once_per_stride_not_once_per_frame() {
    let mut progress = ImportProgress::new(1_000_000);
    let mut checkpoints = 0u32;
    for _ in 0..100_000 {
        if progress.checkpoint() {
            checkpoints += 1;
        }
    }
    assert!(
        (1..=16).contains(&checkpoints),
        "100 000 frames produced {checkpoints} clock reads",
    );
}

fn write_mdf_census_fixture(path: &std::path::Path, frames: u64) {
    let ts_base = 1_700_000_000_000_000_000u64;
    let mut writer = cannet_mdf::MdfCaptureWriter::create(
        path,
        cannet_mdf::MdfCaptureLayout {
            start_time_ns: ts_base,
            max_payload_len: 8,
        },
    )
    .unwrap();
    for i in 0..frames {
        writer
            .append_frame(
                &cannet_core::CanFrame::classic(
                    ts_base + i * 1_000,
                    0,
                    cannet_core::CanId::standard(0x100).unwrap(),
                    Direction::Rx,
                    vec![1],
                )
                .unwrap(),
            )
            .unwrap();
    }
    writer.finish().unwrap();
}

/// Enough objects that the census crosses its checkpoint more than
/// once — a cancel raised at the first is only observable at the second.
const CENSUS_FIXTURE_FRAMES: u64 = 40_000;

fn write_census_fixture(path: &std::path::Path, frames: u64) {
    let ts_base = 1_700_000_000_000_000_000u64;
    let mut writer = cannet_blf::BlfCaptureWriter::create(path).unwrap();
    for i in 0..frames {
        writer
            .append(
                &cannet_core::CanFrame::classic(
                    ts_base + i * 1_000,
                    0,
                    cannet_core::CanId::standard(0x100).unwrap(),
                    Direction::Rx,
                    vec![1],
                )
                .unwrap(),
            )
            .unwrap();
    }
    writer.finish().unwrap();
}

/// The cancellation path end to end at the pump-loop level: a click on
/// the busy launcher cooperatively cancels the import, and the partial
/// frames already ingested are exactly the ones read before the flag
/// was flipped — not zero (the pump doesn't discard what it already
/// appended) and not the whole file (the loop actually stopped early).
///
/// Drives the identical per-frame body `run_pump` runs — the same
/// pipeline `windowed_import_range_keeps_only_the_selected_frames_out_of_the_trace_store`
/// above exercises — with the `if stop.load() { break; }` check
/// `run_pump`'s loop opens with, against a real BLF and a real
/// disk-backed `TraceStore`, since the suite has no harness for the
/// `AppHandle` `run_pump` itself needs.
#[test]
fn a_cancelled_import_stops_the_pump_loop_early_leaving_the_frames_already_ingested() {
    use cannet_blf::BlfCanFrameSource;
    use cannet_core::CanFrameSource as _;

    const TOTAL_FRAMES: usize = 10;
    const CANCEL_AFTER: usize = 3;

    let dir = tempfile::tempdir().unwrap();
    let blf_path = dir.path().join("cancel-import.blf");
    let ts_base = 1_700_000_000_000_000_000u64;
    let frame_at = |ts: u64| {
        cannet_core::CanFrame::classic(
            ts,
            0,
            cannet_core::CanId::standard(0x100).unwrap(),
            Direction::Rx,
            vec![1],
        )
        .unwrap()
    };
    {
        let mut writer = cannet_blf::BlfCaptureWriter::create(&blf_path).unwrap();
        for offset_us in 0..TOTAL_FRAMES {
            writer
                .append(&frame_at(ts_base + offset_us as u64 * 1_000))
                .unwrap();
        }
        writer.finish().unwrap();
    }

    let scratch = tempfile::TempDir::new().unwrap();
    let store_dir = scratch.path().join("current");
    std::fs::create_dir_all(&store_dir).unwrap();
    let store = open_trace_store(&store_dir);

    let state = test_state();
    let flag = Arc::new(AtomicBool::new(false));
    *state.import_cancel() = Some(Arc::clone(&flag));

    let mut source = BlfCanFrameSource::open(&blf_path).unwrap();
    // Every channel the fixture writes has to be mapped: an unmapped
    // channel's frames are dropped, so an empty mapping would import
    // nothing at all.
    let channel_to_bus: Vec<(u8, String)> = vec![(0, "b".into())];
    let mut ingested = 0usize;
    loop {
        if flag.load(Ordering::Relaxed) {
            break;
        }
        let Some(frame) = source.next_frame().unwrap() else {
            break;
        };
        let mut raw = trace_store::RawTraceFrame::from(frame);
        if let Some(bid) = route_channel(raw.channel, &channel_to_bus) {
            raw.bus_id = Some(bid);
            store.append(raw);
            ingested += 1;
        }
        // The click that lands mid-stream: the frontend's busy launcher
        // calling `cancel_import` while the pump is still mid-file.
        if ingested == CANCEL_AFTER {
            cancel_import_now(&state);
        }
    }
    // The pump's own end-of-thread cleanup (`open_log`/`import_mdf`),
    // replicated here since this loop stands in for `run_pump`.
    *state.import_cancel() = None;

    assert_eq!(
        ingested, CANCEL_AFTER,
        "the loop must stop on the next check after the flag flips, not run to EOF",
    );
    assert_eq!(store.len(), CANCEL_AFTER);
    assert!(
        store.len() < TOTAL_FRAMES,
        "cancellation must abandon the rest of the file, not finish it",
    );
    assert!(state.import_cancel().is_none());
}

/// Path to one of `cannet-mdf`'s committed phase-1/2 fixtures, shared by
/// every MDF import test below so `import_mdf` / `scan_mdf_channels`
/// exercise the same corpus the reader crate's own suite already pins.
fn mdf_fixture_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../crates/cannet-mdf/tests/fixtures")
        .join(format!("{name}.mf4"))
}

/// MDF import runs the same per-frame pipeline BLF import does
/// (`RawTraceFrame::from` → `route_channel` → `TraceStore::append`,
/// the pieces `run_pump` is built from — see
/// `windowed_import_range_keeps_only_the_selected_frames_out_of_the_trace_store`
/// above), just fed by `MdfCanFrameSource` instead of `BlfCanFrameSource`.
/// `sorted_finalized_classic.mf4` carries 60 frames on `BusChannel` 1
/// (wire channel 0 after the 1-based → 0-based adjustment
/// `cannet_mdf` documents), starting at `hd_start_time_ns`
/// 1709294400000000000 — pinned against the fixture's
/// `expected/sorted_finalized_classic.json`.
#[test]
fn mdf_import_lands_frames_with_absolute_timestamps_and_mapped_buses() {
    use cannet_core::CanFrameSource as _;
    use cannet_mdf::MdfCanFrameSource;

    let path = mdf_fixture_path("sorted_finalized_classic");
    let mut source = MdfCanFrameSource::open(&path).unwrap();

    let scratch = tempfile::TempDir::new().unwrap();
    let store_dir = scratch.path().join("current");
    std::fs::create_dir_all(&store_dir).unwrap();
    let store = open_trace_store(&store_dir);

    let channel_to_bus: Vec<(u8, String)> = vec![(0, "p".into())];
    let mut n = 0u64;
    while let Some(frame) = source.next_frame().unwrap() {
        let mut raw = trace_store::RawTraceFrame::from(frame);
        let Some(bid) = route_channel(raw.channel, &channel_to_bus) else {
            continue;
        };
        raw.bus_id = Some(bid);
        store.append(raw);
        n += 1;
    }
    assert_eq!(n, 60, "measured directly against the fixture, not assumed");

    let kept = store.slice(0, store.len());
    assert_eq!(kept.len(), 60);
    assert!(
        kept.iter().all(|f| f.bus_id.as_deref() == Some("p")),
        "every frame on BusChannel 1 / wire channel 0 must map to the chosen bus"
    );
    assert_eq!(
        kept[0].timestamp_ns, 1_709_294_400_000_000_000,
        "timestamps land absolute (ADR 0024): hd_start_time_ns + the first record's t_ns == 0"
    );
    assert!(
        kept.windows(2)
            .all(|w| w[0].timestamp_ns <= w[1].timestamp_ns),
        "frames must arrive in non-decreasing timestamp order across the whole import"
    );
}

/// The import time range (ADR 0046) applies to MDF exactly the way it
/// applies to BLF: `import_mdf` wraps the source in
/// `cannet_core::WindowedSource` ahead of `run_pump`, so a frame
/// outside `[start_ns, end_ns]` never reaches `TraceStore::append`.
/// Boundaries are the fixture's own 11th/41st frame timestamps
/// (indices 10 and 40), inclusive on both ends — 31 frames.
#[test]
fn mdf_windowed_import_range_keeps_only_the_selected_frames_out_of_the_trace_store() {
    use cannet_core::{CanFrameSource as _, WindowedSource};
    use cannet_mdf::MdfCanFrameSource;

    let path = mdf_fixture_path("sorted_finalized_classic");
    let source = MdfCanFrameSource::open(&path).unwrap();
    let start = 1_709_294_400_020_000_000u64; // frame index 10
    let end = 1_709_294_400_080_000_000u64; // frame index 40
    let mut windowed = WindowedSource::new(source, Some(start), Some(end));

    let scratch = tempfile::TempDir::new().unwrap();
    let store_dir = scratch.path().join("current");
    std::fs::create_dir_all(&store_dir).unwrap();
    let store = open_trace_store(&store_dir);
    // Every channel the fixture writes has to be mapped: an unmapped
    // channel's frames are dropped, so an empty mapping would import
    // nothing at all.
    let channel_to_bus: Vec<(u8, String)> = vec![(0, "b".into())];
    while let Some(frame) = windowed.next_frame().unwrap() {
        let mut raw = trace_store::RawTraceFrame::from(frame);
        let Some(bid) = route_channel(raw.channel, &channel_to_bus) else {
            continue;
        };
        raw.bus_id = Some(bid);
        store.append(raw);
    }

    let kept = store.slice(0, store.len());
    assert_eq!(kept.len(), 31, "boundaries inclusive: indices 10..=40");
    assert!(kept
        .iter()
        .all(|f| f.timestamp_ns >= start && f.timestamp_ns <= end));
}

/// `scan_mdf_channels` projects `cannet_mdf::scan_mdf`'s signal census
/// straight through (`MdfScanResult`), so the mapping dialog can say what
/// a file's signal content is before importing it.
/// `sorted_finalized_dbcdecoded.mf4` carries 18 bus frames plus two
/// per-message decoded groups — message `0x100` with signals
/// `VehSpeed`/`GearPos` (2) and message `0x1a5` with `TankLevel` (1),
/// each group's master ("time") channel excluded from the count.
#[test]
fn mdf_scan_reports_the_files_signal_content_for_the_dialog() {
    let path = mdf_fixture_path("sorted_finalized_dbcdecoded");
    let scan = cannet_mdf::scan_mdf(&path).unwrap();
    assert_eq!(scan.frame_count, 18);
    assert_eq!(scan.decoded_message_groups.len(), 2);
    assert!(scan
        .decoded_message_groups
        .iter()
        .any(|g| g.signal_count == 2));
    assert!(scan
        .decoded_message_groups
        .iter()
        .any(|g| g.signal_count == 1));

    // Every decoded group is signal content the import brings in, so the
    // census counts it alongside the message-independent ones.
    assert_eq!(scan.signal_groups.len(), 2);
    assert_eq!(
        scan.signal_groups
            .iter()
            .map(|g| g.signal_count)
            .sum::<usize>(),
        3
    );

    // `capture::DecodedMessageGroupInfo::from` is the exact projection
    // `scan_mdf_channels` applies to build the wire response — pin the
    // field-for-field mapping here rather than only in the command
    // (which needs an `AppHandle` to call).
    let projected: Vec<capture::DecodedMessageGroupInfo> =
        scan.decoded_message_groups.iter().map(Into::into).collect();
    assert_eq!(projected.len(), 2);
    assert_eq!(
        projected[0].source_path,
        scan.decoded_message_groups[0].source_path
    );
    assert_eq!(
        projected[0].signal_count,
        scan.decoded_message_groups[0].signal_count
    );
}

/// The per-message decoded groups arrive as file-backed signals like any
/// other signal content the file carries — one cache entry per channel,
/// keyed by its group, with the message it was decoded from on the group
/// name.
#[test]
fn mdf_import_fills_file_backed_signals_from_decoded_message_groups() {
    let path = mdf_fixture_path("sorted_finalized_dbcdecoded");
    let source = cannet_mdf::MdfCanFrameSource::open(&path).unwrap();
    let groups = source.signal_groups();
    assert_eq!(groups.len(), 2);

    let dir = tempfile::tempdir().unwrap();
    let caches = SignalCacheStore::new(dir.path());
    let (signals, samples) =
        capture::fill_file_backed_signals(&caches, &groups, None, None, "capture.mf4");
    assert_eq!(signals, 3, "VehSpeed, GearPos and TankLevel");
    assert_eq!(samples, 45, "15 cycles each");

    let held = caches.file_signals();
    let mut names: Vec<&str> = held.iter().map(|s| s.info.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["GearPos", "TankLevel", "VehSpeed"]);
    assert!(
        held.iter().all(|s| s
            .info
            .group_name
            .as_deref()
            .is_some_and(|n| n.contains("message ID="))),
        "each row names the message its group decoded"
    );
}

/// Importing signals without frames leaves nothing to anchor the session
/// on — `run_pump`'s replay origin is the first frame it appends, and
/// there are no frames. The signal content has to supply it, or a series
/// recorded last year lands on a timeline that starts now.
#[test]
fn a_signals_only_import_takes_its_session_origin_from_the_signals() {
    let path = mdf_fixture_path("sorted_finalized_dbcdecoded");
    let source = cannet_mdf::MdfCanFrameSource::open(&path).unwrap();
    let groups = source.signal_groups();

    let earliest = groups
        .iter()
        .flat_map(|g| &g.signals)
        .filter_map(|s| s.timestamps_ns.first().copied())
        .min()
        .unwrap();
    assert_eq!(
        capture::signal_origin_ns(&groups, None, None),
        Some(earliest)
    );

    // The import range clips the origin the same way it clips the
    // samples: an origin outside the window would put the session start
    // before anything the capture holds.
    let later = earliest + 20_000_000;
    let first_in_window = groups
        .iter()
        .flat_map(|g| &g.signals)
        .flat_map(|s| s.timestamps_ns.iter().copied())
        .filter(|t| *t >= later)
        .min();
    assert!(first_in_window > Some(earliest));
    assert_eq!(
        capture::signal_origin_ns(&groups, Some(later), None),
        first_in_window
    );

    // A file whose signals are all outside the window has no origin to
    // offer, and the caller keeps the session start it already had.
    assert_eq!(
        capture::signal_origin_ns(&groups, Some(u64::MAX), None),
        None
    );
}

/// An MDF can carry the databases its capture was recorded against as
/// `##AT` attachments — ours does, on every Save Capture. Import streams
/// them straight into the loaded set, so the definitions are usable
/// without extracting anything to disk (ADR 0010).
#[test]
fn an_embedded_database_loads_from_the_capture_without_touching_the_disk() {
    let state = test_state();
    let dbc = cannet_mdf::MdfAttachment {
        file_name: "powertrain.dbc".into(),
        mime_type: "application/vnd.vector.dbc".into(),
        data: tiny_dbc(0x1a5, "EngineData", "EngineSpeed").into_bytes(),
    };
    // Not a database: an image rides along in the same chain.
    let other = cannet_mdf::MdfAttachment {
        file_name: "dashboard.png".into(),
        mime_type: "image/png".into(),
        data: vec![0x89, b'P', b'N', b'G'],
    };
    // An *external* attachment names a file instead of carrying one, so
    // there is nothing here to parse — chasing the reference would be
    // the sidecar this project does not do.
    let external = cannet_mdf::MdfAttachment {
        file_name: "elsewhere.dbc".into(),
        mime_type: "application/vnd.vector.dbc".into(),
        data: Vec::new(),
    };

    let loaded = capture::install_embedded_databases(
        &state,
        r"C:\captures\run.mf4",
        &[dbc, other, external],
    );
    assert_eq!(loaded.len(), 1, "one database, and only the database");
    assert_eq!(loaded[0].message_count, 1);
    assert!(loaded[0].warnings.is_empty());

    // The identity is the capture plus the attachment's own name: it is
    // not a path, and it must not read as one.
    let list = state.databases();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].path, r"C:\captures\run.mf4#powertrain.dbc");
    assert_eq!(list[0].db.message_count(), 1);
    assert!(
        list[0].buses.is_empty(),
        "an embedded database is assigned to nothing, like any freshly added one"
    );
}

/// Re-importing the same capture replaces the database it carries rather
/// than stacking a second copy of it — the same reload-in-place rule
/// `add_dbc` applies to a path it already holds.
#[test]
fn re_importing_a_capture_replaces_its_embedded_database() {
    let state = test_state();
    let attachment = |sig: &str| cannet_mdf::MdfAttachment {
        file_name: "powertrain.dbc".into(),
        mime_type: "application/vnd.vector.dbc".into(),
        data: tiny_dbc(0x1a5, "EngineData", sig).into_bytes(),
    };
    capture::install_embedded_databases(&state, "run.mf4", &[attachment("EngineSpeed")]);
    capture::install_embedded_databases(&state, "run.mf4", &[attachment("EngineTorque")]);
    let list = state.databases();
    assert_eq!(list.len(), 1);
    assert_eq!(
        list[0].db.signals().first().map(|s| s.signal_name.clone()),
        Some("EngineTorque".to_owned())
    );
}

/// A DBC that will not parse is reported, not installed — the capture's
/// frames and signals are still worth importing.
#[test]
fn an_unparseable_embedded_database_is_reported_and_left_out() {
    let state = test_state();
    let loaded = capture::install_embedded_databases(
        &state,
        "run.mf4",
        &[cannet_mdf::MdfAttachment {
            file_name: "broken.dbc".into(),
            mime_type: "application/vnd.vector.dbc".into(),
            data: b"this is not a DBC".to_vec(),
        }],
    );
    assert_eq!(loaded.len(), 1);
    assert!(loaded[0].error.is_some());
    assert!(state.databases().is_empty());
}

/// Saving to BLF drops file-backed signals — the format carries frames
/// and nothing else can hold them — so the save path says so. A warning,
/// not a refusal: BLF is still the right save for a capture whose frames
/// are the point.
#[test]
fn a_blf_save_warns_about_the_file_backed_signals_it_drops() {
    let state = file_backed_state();
    let warning = capture::dropped_file_backed_warning(&state.signal_caches.file_signals())
        .expect("a capture with file-backed signals warns");
    assert!(
        warning.contains("2 file-backed signal(s) will not be in the saved file"),
        "{warning}"
    );
    assert!(warning.contains("Analog/EngineSpeed"), "{warning}");
    assert!(warning.contains("Analog/CoolantTemp"), "{warning}");
}

/// The full round-trip contract for an MDF save: import → export →
/// re-import preserves frame content bit for bit (id + extended,
/// payload, FD flags, remote and error frames), frame-accurate absolute
/// timestamps (ADR 0024), the bus mapping via the ordered project bus
/// list ↔ `BusChannel` rule (ADR 0023), the trace's event markers, and
/// the file-backed signal series with their names and units.
///
/// Drives `write_mdf_capture` — the exact body `save_capture` runs for
/// `SaveFormat::Mdf` — against a real `AppState`, and reads the result
/// back through the same calls `import_mdf` makes. The Tauri command
/// itself needs an `AppHandle` the suite has no harness for, so this
/// tests one layer under it, as the BLF save tests do.
#[test]
#[allow(clippy::too_many_lines)] // one contract, asserted end to end
fn an_mdf_save_round_trips_everything_the_model_holds() {
    use cannet_core::CanFrameSource as _;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("capture.mf4");
    let dbc_path = dir.path().join("modes.dbc");
    std::fs::write(&dbc_path, MUX_SNAPSHOT_DBC).unwrap();

    let state = file_backed_state();
    state.databases.lock().unwrap().clear();
    state
        .databases
        .lock()
        .unwrap()
        .push(loaded(dbc_path.to_str().unwrap(), MUX_SNAPSHOT_DBC));

    // Two buses, both addressing modes, and every payload kind.
    let ts = 1_700_000_000_000_000_000u64;
    let buses = vec!["powertrain".to_string(), "chassis".to_string()];
    let frames_in = vec![
        trace_store::RawTraceFrame {
            timestamp_ns: ts + 7,
            channel: 0,
            id: 0x100,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(vec![1, 2, 3, 4, 5, 6, 7, 8]),
            bus_id: Some("powertrain".into()),
        },
        trace_store::RawTraceFrame {
            timestamp_ns: ts + 1_000_037,
            channel: 0,
            id: 0x01AB_CDEF,
            extended: true,
            direction: Direction::Tx,
            payload: CanFramePayload::Fd {
                data: vec![0xAA; 48],
                flags: cannet_core::CanFdFlags {
                    bitrate_switch: true,
                    error_state_indicator: true,
                },
            },
            bus_id: Some("chassis".into()),
        },
        trace_store::RawTraceFrame {
            timestamp_ns: ts + 2_000_000_003,
            channel: 0,
            id: 0x10,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Error,
            bus_id: Some("powertrain".into()),
        },
        trace_store::RawTraceFrame {
            timestamp_ns: ts + 3_000_000_009,
            channel: 0,
            id: 0x7FF,
            extended: false,
            direction: Direction::Tx,
            payload: CanFramePayload::Remote { dlc: 6 },
            bus_id: Some("chassis".into()),
        },
    ];
    for frame in &frames_in {
        state.trace_store.append(frame.clone());
    }

    let notes_in = vec![
        notes::Note {
            id: "note-a".into(),
            timestamp_ns: ts + 500_000,
            label: "first".into(),
            kind: notes::EventKind::Note,
            color: Some("#FF8800".into()),
        },
        notes::Note {
            id: "note-b".into(),
            timestamp_ns: ts + 2_500_000_000,
            label: "second & last".into(),
            kind: notes::EventKind::Note,
            color: None,
        },
    ];

    let outcome =
        capture::write_mdf_capture(dest.to_str().unwrap(), &state, &notes_in, &buses).unwrap();
    assert_eq!(outcome.frame_count, 4);
    assert_eq!(outcome.marker_count, 2);
    assert_eq!(outcome.max_timestamp_drift_ns, 0);

    // --- frames, bit for bit, on the buses the project list implies ---
    let mut source = cannet_mdf::MdfCanFrameSource::open(&dest).unwrap();
    let mut back = Vec::new();
    while let Some(frame) = source.next_frame().unwrap() {
        back.push(frame);
    }
    assert_eq!(back.len(), frames_in.len());
    for (got, want) in back.iter().zip(&frames_in) {
        assert_eq!(got.timestamp_ns, want.timestamp_ns, "{want:?}");
        assert_eq!(got.id.raw(), want.id);
        assert_eq!(got.id.is_extended(), want.extended);
        assert_eq!(got.direction, want.direction);
        assert_eq!(got.payload, want.payload);
        // `BusChannel` carries the bus list position, so a re-import maps
        // the frame back onto the same logical bus (ADR 0023).
        assert_eq!(
            buses[got.channel as usize],
            want.bus_id.clone().unwrap(),
            "{want:?}"
        );
    }

    // --- markers ---
    let mut synthetic_idx = 0u64;
    let notes_back: Vec<notes::Note> = source
        .events()
        .unwrap()
        .iter()
        .map(|e| capture::note_from_event(e, &mut synthetic_idx))
        .collect();
    assert_eq!(notes_back, notes_in);

    // --- file-backed signals ---
    let groups = source.signal_groups();
    let filled = state.signal_caches.file_signal_series();
    assert_eq!(groups.len(), filled.len());
    for (group, (info, points)) in groups.iter().zip(&filled) {
        assert_eq!(group.name, info.group_name);
        assert_eq!(group.signals.len(), 1);
        let got = &group.signals[0];
        assert_eq!(got.name, info.name);
        assert_eq!(got.unit.clone().unwrap_or_default(), info.unit);
        assert_eq!(
            got.values,
            points.iter().map(|p| p.value).collect::<Vec<_>>()
        );
        for (back, point) in got.timestamps_ns.iter().zip(points) {
            // The signal cache stores sample times as f64 seconds since
            // the epoch, so a file-backed series' resolution is the
            // model's ~0.24 µs, not the frame timeline's nanosecond.
            let want = capture::sample_ns(point.t_seconds);
            assert!(back.abs_diff(want) <= 1_000, "{back} vs {want}");
        }
    }

    // --- the project DBC, embedded (ADR 0010) ---
    let attachments = source.attachments().unwrap();
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0].file_name, "modes.dbc");
    assert_eq!(attachments[0].data, MUX_SNAPSHOT_DBC.as_bytes());
}

/// The committed demo capture (`examples/cannet-demo.mf4`) is the MDF
/// twin of `cannet-demo.blf` — the same 10 s of traffic, plus the two
/// things an MDF carries that a BLF cannot. It imports cleanly: frames,
/// file-backed signals and event markers all arrive, through the same
/// calls `import_mdf` makes.
#[test]
fn the_demo_mdf_imports_frames_signals_and_markers() {
    use cannet_core::CanFrameSource as _;

    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/cannet-demo.mf4");

    // What the mapping dialog would show: one bus channel, the whole
    // capture's span, and the file's markers.
    let scan = cannet_mdf::scan_mdf(&path).expect("the demo MDF scans");
    assert_eq!(scan.channels, vec![0], "the demo trace is single-bus");
    assert_eq!(scan.frame_count, 1810);
    assert!(!scan.unfinalized);
    assert_eq!(scan.signal_groups.len(), 2);
    assert!(scan.decoded_message_groups.is_empty());
    assert_eq!(scan.events.len(), 4);

    // What the pump would ingest.
    let mut source = cannet_mdf::MdfCanFrameSource::open(&path).expect("the demo MDF opens");
    let mut frames = 0u64;
    let mut fd = 0u64;
    let mut extended = 0u64;
    let mut last_ts = 0u64;
    while let Some(frame) = source.next_frame().expect("every demo frame decodes") {
        frames += 1;
        fd += u64::from(frame.payload.is_fd());
        extended += u64::from(frame.id.is_extended());
        assert!(frame.timestamp_ns >= last_ts, "frames climb in time");
        last_ts = frame.timestamp_ns;
        assert_eq!(frame.channel, 0);
    }
    assert_eq!(frames, scan.frame_count);
    assert!(
        fd > 0 && extended > 0,
        "the demo covers FD and extended ids"
    );

    // What `import_mdf` fills the signal caches with.
    let state = test_state();
    let (signals, samples) = capture::fill_file_backed_signals(
        &state.signal_caches,
        &source.signal_groups(),
        None,
        None,
        "demo.mf4",
    );
    assert_eq!(signals, 4);
    assert!(samples > 0);
    let listed = state.signal_caches.file_signals();
    let names: Vec<&str> = listed.iter().map(|e| e.info.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "AmbientTemp",
            "CabinHumidity",
            "ChargerPower",
            "ContactorState"
        ]
    );
    assert_eq!(listed[0].info.unit, "degC");
    assert_eq!(listed[0].info.group_name.as_deref(), Some("Ambient"));

    // The coded channel arrives with its value→text table — the demo's
    // one file-backed enum lane, labels intact.
    let contactor = &listed[3].info;
    assert_eq!(contactor.group_name.as_deref(), Some("Charger"));
    let table: Vec<(i64, &str)> = contactor
        .value_table
        .iter()
        .map(|e| (e.raw, e.label.as_str()))
        .collect();
    assert_eq!(table, [(0, "Open"), (1, "Precharge"), (2, "Closed")]);
    for analog in &listed[..3] {
        assert!(analog.info.value_table.is_empty());
    }

    // And what it puts in the notes store.
    let mut synthetic_idx = 0u64;
    let notes: Vec<notes::Note> = source
        .events()
        .expect("the demo MDF's events read")
        .iter()
        .map(|e| capture::note_from_event(e, &mut synthetic_idx))
        .collect();
    assert_eq!(synthetic_idx, 0, "every demo event carries its own id");
    let labels: Vec<&str> = notes.iter().map(|n| n.label.as_str()).collect();
    assert_eq!(labels, ["run start", "gear shift", "GPS fix", "run end"]);
    assert_eq!(notes[0].id, "demo-0");
    assert_eq!(notes[1].color.as_deref(), Some("#FF8800"));
    assert_eq!(notes[0].timestamp_ns, source.start_unix_nanos());
}

/// An event another tool wrote carries no `cannet.id`, so the import
/// mints a deterministic one — the same rule a third-party BLF marker
/// gets, and what keeps its rename/remove paths working.
#[test]
fn an_mdf_event_without_a_cannet_id_gets_a_synthetic_one() {
    let mut idx = 0u64;
    let plain = cannet_mdf::MdfEvent {
        timestamp_ns: 1_700_000_000_000_000_000,
        name: "someone else's marker".into(),
        properties: vec![],
    };
    let first = capture::note_from_event(&plain, &mut idx);
    let second = capture::note_from_event(&plain, &mut idx);
    assert_eq!(first.id, "mdf-event-0");
    assert_eq!(second.id, "mdf-event-1");
    assert_eq!(first.label, "someone else's marker");
    assert_eq!(first.color, None);
}

/// And a capture with none is saved without a word about it — a warning
/// every save emits is one nobody reads.
#[test]
fn a_blf_save_of_a_frames_only_capture_warns_about_nothing() {
    let state = test_state();
    assert!(capture::dropped_file_backed_warning(&state.signal_caches.file_signals()).is_none());
}

/// A scan of a capture whose writer never finalized it earns exactly
/// one line, and that line says how much came back and what did not.
#[test]
fn a_recovered_capture_says_what_it_recovered() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("killed.blf");
    let mut writer = cannet_blf::BlfCaptureWriter::create(&path).unwrap();
    for i in 0..20_000u64 {
        writer
            .append(
                &cannet_core::CanFrame::classic(
                    1_700_000_000_u64 * 1_000_000_000 + i * 1_000_000,
                    0,
                    cannet_core::CanId::standard(0x100).unwrap(),
                    cannet_core::Direction::Rx,
                    vec![1, 2, 3, 4, 5, 6, 7, 8],
                )
                .unwrap(),
            )
            .unwrap();
    }
    // A hard kill: neither `finish` nor `Drop` runs, so the partial
    // file keeps the placeholder header its writer stamped at open.
    std::mem::forget(writer);
    let part = dir.path().join("killed.blf.part");

    let scan = cannet_blf::scan_blf(&part).unwrap();
    let line = capture::recovered_capture_warning(&scan)
        .expect("a capture with a placeholder header is worth a line");
    assert!(line.contains("never finalized"), "{line}");
    assert!(
        line.contains(&format!("{} frame(s)", scan.frame_count)),
        "{line}"
    );
    assert!(line.contains("wall clock"), "{line}");
    assert!(
        !line.contains("incomplete record"),
        "our writer's containers go out whole: {line}"
    );

    // Truncate it the way a buffered writer's death does, and the same
    // line names the fragment too.
    let mut bytes = std::fs::read(&part).unwrap();
    bytes.truncate(bytes.len() - 4096);
    let torn = dir.path().join("torn.blf");
    std::fs::write(&torn, &bytes).unwrap();
    let scan = cannet_blf::scan_blf(&torn).unwrap();
    let line = capture::recovered_capture_warning(&scan).expect("a torn capture warns");
    assert!(line.contains("incomplete record"), "{line}");
    assert!(
        line.contains(&format!("{} frame(s)", scan.frame_count)),
        "{line}"
    );
}

/// And an intact capture is scanned without a word about it — a warning
/// every import emits is one nobody reads.
#[test]
fn an_intact_capture_is_scanned_without_a_recovery_warning() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("whole.blf");
    let mut writer = cannet_blf::BlfCaptureWriter::create(&path).unwrap();
    writer
        .append(
            &cannet_core::CanFrame::classic(
                1_700_000_000_u64 * 1_000_000_000,
                0,
                cannet_core::CanId::standard(0x100).unwrap(),
                cannet_core::Direction::Rx,
                vec![1],
            )
            .unwrap(),
        )
        .unwrap();
    writer.finish().unwrap();
    let scan = cannet_blf::scan_blf(&path).unwrap();
    assert!(capture::recovered_capture_warning(&scan).is_none());
}

/// A capture holding two file-backed signals, one DBC loaded beside
/// them so both provenances are in play at once.
#[allow(clippy::cast_precision_loss)] // ten small integers
fn file_backed_state() -> AppState {
    let state = test_state();
    state
        .databases
        .lock()
        .unwrap()
        .push(loaded_scoped("modes.dbc", MUX_SNAPSHOT_DBC, &[TEST_BUS]));
    invalidate_derived_caches(&state);
    for (name, unit, base) in [("EngineSpeed", "rpm", 800.0), ("CoolantTemp", "degC", 70.0)] {
        let info = signal_cache::FileSignalInfo {
            source_path: "analog.mf4".into(),
            group: 1,
            group_name: Some("Analog".into()),
            name: name.into(),
            unit: unit.into(),
            value_table: Vec::new(),
        };
        let points: Vec<(u64, f64)> = (0..10u64)
            .map(|i| {
                (
                    1_700_000_000_000_000_000 + i * 1_000_000_000,
                    base + i as f64,
                )
            })
            .collect();
        state.signal_caches.fill_file_backed(&info, &points);
    }
    state
}

/// Every file-backed signal the capture holds, as `fetch_signal_page`
/// serves them to the signal grid for `selection`.
fn file_backed_rows(state: &AppState, patterns: &[&str]) -> Vec<SignalSnapshotRecord> {
    let sel = SignalSelection {
        keys: vec![],
        patterns: patterns.iter().map(|p| (*p).to_string()).collect(),
    };
    fetch_signal_page_inner(
        state,
        &sel,
        None,
        0,
        u64::MAX,
        None,
        None,
        vec![],
        None,
        0,
        100,
    )
    .expect("valid pattern")
    .rows
    .iter()
    .filter_map(ipc::SignalPageRow::signal)
    .filter(|r| r.file_backed)
    .cloned()
    .collect()
}

/// The catalog lists file-backed signals beside DBC-backed ones,
/// marked by source and labelled by their channel group. A picker that
/// couldn't see them would leave imported signals unplottable.
#[test]
fn list_signals_offers_file_backed_signals_marked_by_source() {
    let state = file_backed_state();
    // `list_signals` itself needs a Tauri `State`, so exercise the
    // projection it appends — the one place a file-backed catalog row
    // is built.
    let rows: Vec<ipc::SignalDescriptorRecord> = state
        .signal_caches
        .file_signals()
        .into_iter()
        .map(signal_snapshot::file_backed_descriptor)
        .collect();
    assert_eq!(
        rows.iter()
            .map(|r| (
                r.signal_name.as_str(),
                r.message_name.as_str(),
                r.unit.as_str(),
                r.file_backed
            ))
            .collect::<Vec<_>>(),
        vec![
            ("CoolantTemp", "Analog", "degC", true),
            ("EngineSpeed", "Analog", "rpm", true),
        ],
    );
    // The catalog identity is the group index in the message slot,
    // never a bus — nothing puts a file-backed signal on one.
    assert!(rows.iter().all(|r| r.bus_id.is_none() && r.message_id == 1));
}

/// The signal grid serves file-backed rows through the same paged
/// command as DBC-backed ones, selected by the same canonical-path
/// patterns (ADR 0038) with empty bus and ECU segments, and marked by
/// source. Their statistics describe the whole imported series, since
/// no frame in the trace window carries them.
#[test]
#[allow(clippy::float_cmp)]
fn fetch_signal_page_serves_file_backed_rows_marked_by_source() {
    let state = file_backed_state();
    let rows = file_backed_rows(&state, &["^//Analog/"]);
    assert_eq!(
        rows.iter()
            .map(|r| (r.signal_name.as_str(), r.unit.as_str(), r.count))
            .collect::<Vec<_>>(),
        vec![
            ("CoolantTemp", "degC", Some(10)),
            ("EngineSpeed", "rpm", Some(10))
        ],
    );
    let engine = rows
        .iter()
        .find(|r| r.signal_name == "EngineSpeed")
        .unwrap();
    assert_eq!(engine.value, Some(809.0), "the newest sample of the series");
    assert_eq!(engine.rate, Some(1.0));
    assert_eq!(engine.message_name, "Analog");
    assert!(engine.bus_id.is_none() && engine.transmitter.is_none());
    // A pattern that doesn't match their path leaves them out, exactly
    // as it would a DBC-backed descriptor.
    assert!(file_backed_rows(&state, &["^/powertrain/"]).is_empty());
    // And a manual pick reaches one without any pattern at all.
    let sel = SignalSelection {
        keys: vec![ipc::SignalQuery {
            bus_id: None,
            message_id: 1,
            extended: false,
            signal_name: "EngineSpeed".into(),
            file_backed: true,
        }],
        patterns: vec![],
    };
    let picked =
        signal_snapshot::select_file_backed(&state.signal_caches.file_signals(), &sel, None)
            .unwrap();
    assert_eq!(picked.len(), 1);
    assert_eq!(picked[0].signal_name, "EngineSpeed");
}

/// A capture holding one coded file-backed series: three enumerators
/// and one sample of each, newest last. `EngineSpeed` rides along on
/// the same group index a DBC message would use for a different signal,
/// which is what keeps the two namespaces honest.
fn coded_file_backed_state() -> AppState {
    let state = test_state();
    let ts = 1_700_000_000_000_000_000u64;
    let table = |rows: &[(i64, &str)]| -> Vec<ipc::ValueTableEntryRecord> {
        rows.iter()
            .map(|(raw, label)| ipc::ValueTableEntryRecord {
                raw: *raw,
                label: (*label).to_string(),
            })
            .collect()
    };
    for (name, rows) in [
        (
            "CurrentState",
            table(&[(0, "Startup"), (1, "Idle"), (7, "Fault")]),
        ),
        ("AtRest", Vec::new()),
    ] {
        let info = signal_cache::FileSignalInfo {
            source_path: "coded.mf4".into(),
            group: 4,
            group_name: Some("BMS".into()),
            name: name.into(),
            unit: String::new(),
            value_table: rows,
        };
        let points: Vec<(u64, f64)> = [0.0, 1.0, 7.0]
            .iter()
            .enumerate()
            .map(|(i, v)| (ts + i as u64 * 1_000_000_000, *v))
            .collect();
        state.signal_caches.fill_file_backed(&info, &points);
    }
    state
}

/// The labels of a coded file-backed channel are served through the
/// same command a DBC signal's `VAL_` table goes out on — the frontend
/// has one value-table path and both kinds of signal reach it.
#[test]
fn a_coded_file_backed_signals_table_is_served_like_a_dbc_signals() {
    let state = coded_file_backed_state();
    assert_eq!(
        state
            .signal_caches
            .file_signal_value_table(4, "CurrentState"),
        vec![
            ipc::ValueTableEntryRecord {
                raw: 0,
                label: "Startup".into()
            },
            ipc::ValueTableEntryRecord {
                raw: 1,
                label: "Idle".into()
            },
            ipc::ValueTableEntryRecord {
                raw: 7,
                label: "Fault".into()
            },
        ],
    );
    // A series with no conversion behind it has no table, and neither
    // has a group/name pair no file-backed series answers to.
    assert!(state
        .signal_caches
        .file_signal_value_table(4, "AtRest")
        .is_empty());
    assert!(state
        .signal_caches
        .file_signal_value_table(9, "CurrentState")
        .is_empty());
}

/// A coded file-backed signal reads as an enum wherever a DBC-backed
/// one does: the catalog marks it, and the signal view's value column
/// shows the label beside the code instead of the code alone.
#[test]
fn a_coded_file_backed_signal_carries_its_label_into_the_values_views() {
    let state = coded_file_backed_state();
    let descriptors: Vec<ipc::SignalDescriptorRecord> = state
        .signal_caches
        .file_signals()
        .into_iter()
        .map(signal_snapshot::file_backed_descriptor)
        .collect();
    assert_eq!(
        descriptors
            .iter()
            .map(|d| (d.signal_name.as_str(), d.is_enum))
            .collect::<Vec<_>>(),
        vec![("AtRest", false), ("CurrentState", true)],
    );

    let sel = SignalSelection {
        keys: vec![],
        patterns: vec!["^//BMS/".to_string()],
    };
    let rows = signal_snapshot::select_file_backed(&state.signal_caches.file_signals(), &sel, None)
        .unwrap();
    let coded = rows
        .iter()
        .find(|r| r.signal_name == "CurrentState")
        .unwrap();
    assert!(coded.is_enum);
    assert_eq!(coded.value, Some(7.0), "the newest sample of the series");
    assert_eq!(
        coded.label.as_deref(),
        Some("Fault"),
        "the code's own label, looked up by the model",
    );
    let plain = rows.iter().find(|r| r.signal_name == "AtRest").unwrap();
    assert!(!plain.is_enum && plain.label.is_none());
}

/// A view wired to specific buses excludes file-backed signals for the
/// same reason it excludes an unassigned-bus descriptor: nothing puts
/// them on a bus.
#[test]
fn a_bus_wired_view_has_no_file_backed_rows() {
    let state = file_backed_state();
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
        Some(&["powertrain".to_string()]),
        0,
        100,
    )
    .unwrap();
    assert_eq!(page.count, 0);
}

/// A DBC reload drops every decoded pyramid (ADR 0033) and must leave
/// the file-backed rows exactly where they were — same signals, same
/// samples, same statistics.
#[test]
fn a_dbc_reload_leaves_the_file_backed_rows_untouched() {
    let state = file_backed_state();
    let before = file_backed_rows(&state, &["^//Analog/"]);
    assert_eq!(before.len(), 2);

    state.databases.lock().unwrap().clear();
    invalidate_derived_caches(&state);

    let after = file_backed_rows(&state, &["^//Analog/"]);
    assert_eq!(
        after
            .iter()
            .map(|r| (r.signal_name.clone(), r.value, r.count))
            .collect::<Vec<_>>(),
        before
            .iter()
            .map(|r| (r.signal_name.clone(), r.value, r.count))
            .collect::<Vec<_>>(),
    );
}

/// An MDF's message-independent signal channel groups land as
/// **file-backed signals** (`docs/CONTEXT.md`): one signal-cache entry
/// per channel, filled once and complete. `sorted_finalized_mixed.mf4`
/// is the logger file that carries one such group — `Analog`, with
/// `EngineSpeed` (rpm) and `CoolantTemp` (degC), 20 samples each,
/// pinned against the fixture's `expected/sorted_finalized_mixed.json`.
#[test]
fn mdf_import_fills_file_backed_signals_from_the_signal_channel_groups() {
    let path = mdf_fixture_path("sorted_finalized_mixed");
    let source = cannet_mdf::MdfCanFrameSource::open(&path).unwrap();
    let groups = source.signal_groups();

    let dir = tempfile::TempDir::new().unwrap();
    let caches = SignalCacheStore::new(dir.path());
    let (signals, samples) =
        capture::fill_file_backed_signals(&caches, &groups, None, None, &path.to_string_lossy());
    assert_eq!((signals, samples), (2, 40));

    let listed = caches.file_signals();
    assert_eq!(
        listed
            .iter()
            .map(|e| (
                e.info.name.as_str(),
                e.info.unit.as_str(),
                e.info.group_label(),
                e.sample_count
            ))
            .collect::<Vec<_>>(),
        vec![
            ("CoolantTemp", "degC", "Analog".to_string(), 20),
            ("EngineSpeed", "rpm", "Analog".to_string(), 20),
        ],
        "both channels of the file's one signal group, with their metadata",
    );
    // Timestamps are absolute (ADR 0024): the group's master channel is
    // seconds off `hd_start_time_ns`, re-absolutized by the reader.
    let engine = listed
        .iter()
        .find(|e| e.info.name == "EngineSpeed")
        .unwrap();
    let latest = engine.latest.as_ref().unwrap();
    assert!(
        (latest.t_seconds - 1_709_294_400.228).abs() < 1e-6,
        "last sample at hd_start + 228 ms, got {}",
        latest.t_seconds
    );
    assert!((latest.value - 1037.5).abs() < 1e-9);

    // A second import of the same file replaces the series rather than
    // appending to it — a re-import is not a doubling.
    capture::fill_file_backed_signals(&caches, &groups, None, None, &path.to_string_lossy());
    assert_eq!(
        caches
            .file_signals()
            .iter()
            .map(|e| e.sample_count)
            .collect::<Vec<_>>(),
        vec![20, 20],
    );
}

/// The import records **which file** each series came from, and the
/// Database view's catalog command arranges the capture's file-backed
/// signals under it (ADR 0052): source file → channel group → signal.
#[test]
fn file_backed_catalog_branches_under_the_file_the_import_read() {
    let path = mdf_fixture_path("sorted_finalized_mixed");
    let source = cannet_mdf::MdfCanFrameSource::open(&path).unwrap();
    let groups = source.signal_groups();

    let dir = tempfile::TempDir::new().unwrap();
    let caches = SignalCacheStore::new(dir.path());
    let source_path = path.to_string_lossy().to_string();
    capture::fill_file_backed_signals(&caches, &groups, None, None, &source_path);

    let content = signal_snapshot::file_backed_content(caches.file_signals());
    assert_eq!(content.len(), 1, "one branch, for the one imported file");
    assert_eq!(content[0].source_path, source_path);
    assert_eq!(content[0].groups.len(), 1);
    assert_eq!(content[0].groups[0].label, "Analog");
    assert_eq!(
        content[0].groups[0]
            .signals
            .iter()
            .map(|s| (s.name.as_str(), s.unit.as_str()))
            .collect::<Vec<_>>(),
        vec![("CoolantTemp", "degC"), ("EngineSpeed", "rpm")],
    );

    // The catalog is the capture's, so discarding the capture empties
    // it — the branches live and die with the capture, never with the
    // project.
    caches.clear();
    assert!(signal_snapshot::file_backed_content(caches.file_signals()).is_empty());
}

/// The import range (ADR 0046) bounds the file-backed fill exactly as
/// `WindowedSource` bounds the frames — otherwise a windowed import
/// would put a whole-file series on the same plot as a sliced trace.
/// The fixture's `Analog` group samples every 12 ms from
/// `hd_start_time_ns`; `[+24 ms, +60 ms]` is four of them, boundaries
/// inclusive.
#[test]
fn mdf_import_range_bounds_the_file_backed_fill_too() {
    let path = mdf_fixture_path("sorted_finalized_mixed");
    let source = cannet_mdf::MdfCanFrameSource::open(&path).unwrap();
    let groups = source.signal_groups();
    let base = 1_709_294_400_000_000_000u64;

    let dir = tempfile::TempDir::new().unwrap();
    let caches = SignalCacheStore::new(dir.path());
    let (signals, samples) = capture::fill_file_backed_signals(
        &caches,
        &groups,
        Some(base + 24_000_000),
        Some(base + 60_000_000),
        &path.to_string_lossy(),
    );
    assert_eq!((signals, samples), (2, 8), "four samples per channel");

    // A window the file has nothing in fills nothing at all, rather than
    // leaving empty series claiming the capture has those signals.
    let empty_dir = tempfile::TempDir::new().unwrap();
    let empty = SignalCacheStore::new(empty_dir.path());
    assert_eq!(
        capture::fill_file_backed_signals(&empty, &groups, Some(base + 10_000_000_000), None, ""),
        (0, 0)
    );
    assert!(empty.file_signals().is_empty());
}

/// A pure logger file has no signal channel groups, so an import of one
/// fills nothing — the file-backed path costs a capture that doesn't
/// use it nothing at all.
#[test]
fn mdf_import_of_a_pure_logger_file_fills_no_file_backed_signals() {
    let path = mdf_fixture_path("sorted_finalized_classic");
    let source = cannet_mdf::MdfCanFrameSource::open(&path).unwrap();
    let dir = tempfile::TempDir::new().unwrap();
    let caches = SignalCacheStore::new(dir.path());
    assert_eq!(
        capture::fill_file_backed_signals(&caches, &source.signal_groups(), None, None, ""),
        (0, 0)
    );
}

/// A signal-shape MF4 (a post-processed measurement with no bus-logging
/// group at all) imports through the signals path. The scan reports no
/// channels and no frames — so the dialog offers Signals and no
/// CAN-messages content — the file's series land file-backed, and the
/// session origin comes from the earliest sample, there being no first
/// frame to take it from.
#[test]
fn mdf_signal_only_file_imports_through_the_signals_path() {
    let path = mdf_fixture_path("signal_only");

    let scan = cannet_mdf::scan_mdf(&path).unwrap();
    assert!(scan.channels.is_empty(), "no frames, so no wire channels");
    assert_eq!(scan.frame_count, 0);
    assert_eq!(scan.signal_groups.len(), 2);
    assert_eq!(
        scan.signal_groups
            .iter()
            .map(|g| g.signal_count)
            .sum::<usize>(),
        3,
    );

    let source = cannet_mdf::MdfCanFrameSource::open(&path).unwrap();
    let groups = source.signal_groups();
    let dir = tempfile::TempDir::new().unwrap();
    let caches = SignalCacheStore::new(dir.path());
    let (signals, samples) =
        capture::fill_file_backed_signals(&caches, &groups, None, None, &path.to_string_lossy());
    assert_eq!((signals, samples), (3, 72), "every channel of both groups");
    assert_eq!(
        caches
            .file_signals()
            .iter()
            .map(|e| (e.info.name.clone(), e.info.group_label()))
            .collect::<Vec<_>>(),
        vec![
            ("AxleTorque".to_string(), "Powertrain".to_string()),
            ("DriveState".to_string(), "Powertrain".to_string()),
            ("BatteryVolts".to_string(), "Electrical".to_string()),
        ],
    );

    // The leg `import_mdf` takes when no frames are imported (ADR 0024).
    assert_eq!(
        capture::signal_origin_ns(&groups, None, None),
        Some(1_709_294_400_000_000_000),
    );
}

/// Writes a one-signal MF4 into `dir` whose channel carries a
/// value-to-text conversion — the shape a tool writes a DBC enumeration
/// as, synthesised here rather than taken from any recording.
fn coded_signal_mdf(dir: &std::path::Path, table: &[(i64, String)]) -> std::path::PathBuf {
    let dest = dir.join("coded.mf4");
    let start_ns = 1_709_294_400_000_000_000u64;
    let mut writer = cannet_mdf::MdfCaptureWriter::create(
        &dest,
        cannet_mdf::MdfCaptureLayout {
            start_time_ns: start_ns,
            max_payload_len: 8,
        },
    )
    .unwrap();
    writer.add_signal(
        Some("BMS".to_owned()),
        cannet_mdf::FileSignal {
            name: "CurrentState".to_owned(),
            unit: None,
            conversion: None,
            value_table: table.to_vec(),
            timestamps_ns: (0..4u64).map(|i| start_ns + i * 10_000_000).collect(),
            values: vec![0.0, 1.0, 7.0, 1.0],
        },
    );
    writer.finish().unwrap();
    dest
}

/// A coded channel's labels are in the file and nowhere else — the DBC
/// it was decoded against is the recording tool's. The import has to
/// carry the table onto the file-backed series, and saving the session
/// back out has to write it again, or the round trip loses the half of
/// the signal that says what its codes mean.
#[test]
fn mdf_import_carries_a_coded_channels_value_table_onto_the_series() {
    use cannet_mdf::MdfCanFrameSource;

    let table = vec![
        (0, "Startup".to_owned()),
        (1, "Idle".to_owned()),
        (7, "Fault".to_owned()),
    ];
    let dir = tempfile::tempdir().unwrap();
    let path = coded_signal_mdf(dir.path(), &table);

    let source = MdfCanFrameSource::open(&path).unwrap();
    let groups = source.signal_groups();
    let state = test_state();
    let (signals, samples) = capture::fill_file_backed_signals(
        &state.signal_caches,
        &groups,
        None,
        None,
        &path.to_string_lossy(),
    );
    assert_eq!((signals, samples), (1, 4));

    let held = state.signal_caches.file_signals();
    assert_eq!(held.len(), 1);
    let pairs = |info: &signal_cache::FileSignalInfo| {
        info.value_table
            .iter()
            .map(|e| (e.raw, e.label.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        pairs(&held[0].info),
        table,
        "the enumerators travel with the series",
    );

    // ... and back out again: a save that dropped them would hand the
    // next reader codes with nothing to read them by.
    let dest = dir.path().join("saved.mf4");
    capture::write_mdf_capture(dest.to_str().unwrap(), &state, &[], &[]).unwrap();
    let saved = MdfCanFrameSource::open(&dest).unwrap();
    assert_eq!(saved.signal_groups()[0].signals[0].value_table, table);
}

/// `write_blf_capture` re-channels each frame by its `bus_id`'s
/// position in the project's ordered bus list. This is how the
/// logical bus assignment round-trips through BLF — the channel
/// number IS the bus index. A frame whose `bus_id` is missing or
/// not in the project's bus list keeps its original wire channel
/// (so we never silently lose data from a partly-mapped capture).
#[test]
fn write_blf_capture_re_channels_frames_by_project_bus_order() {
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

    let outcome = write_blf_capture(dest.to_str().unwrap(), &frames, &[], &buses).unwrap();
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
fn write_blf_capture_keeps_wire_channel_when_bus_is_unmapped() {
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

    write_blf_capture(dest.to_str().unwrap(), &frames, &[], &buses).unwrap();

    let mut src = BlfCanFrameSource::open(&dest).unwrap();
    let read: Vec<u8> = std::iter::from_fn(|| src.next_frame().unwrap())
        .map(|f| f.channel)
        .collect();
    assert_eq!(read, vec![3, 4, 0]);
}

/// Save → reload keeps **every** timestamp of an out-of-order capture.
///
/// `examples/time-origins/wall-clock-out-of-order.blf` carries its three
/// earliest frames at the *end* of the file (ADR 0024: arrival order is
/// not timestamp order), so a save that anchored the file on its first
/// frame wrote those three 380 ms late. `write_blf_capture` declares the
/// capture's minimum before the first append, so the reloaded file is
/// timestamp-for-timestamp the capture it was written from.
#[test]
fn write_blf_capture_preserves_every_timestamp_of_an_out_of_order_capture() {
    use cannet_blf::BlfCanFrameSource;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("out-of-order.blf");

    // Read the fixture as the session buffer would hold it: in file
    // (arrival) order, dip and all.
    let mut src =
        BlfCanFrameSource::open(time_origin_fixture("wall-clock-out-of-order.blf")).unwrap();
    let frames: Vec<trace_store::RawTraceFrame> = std::iter::from_fn(|| src.next_frame().unwrap())
        .map(|f| trace_store::RawTraceFrame {
            timestamp_ns: f.timestamp_ns,
            channel: f.channel,
            id: f.id.raw(),
            extended: f.id.is_extended(),
            direction: f.direction,
            payload: f.payload.clone(),
            bus_id: None,
        })
        .collect();
    let written: Vec<u64> = frames.iter().map(|f| f.timestamp_ns).collect();
    assert_eq!(written.len(), 121);
    assert!(
        written.last().unwrap() < written.first().unwrap(),
        "the fixture's last frame precedes its first — the case that used to clamp",
    );

    // A note at the capture's *latest* event. Notes are merged into the
    // object stream in timestamp order, so a note at the minimum would
    // be appended first and would anchor the file correctly all by
    // itself — hiding the very defect this test exists to catch.
    let earliest = *written.iter().min().unwrap();
    let latest = *written.iter().max().unwrap();
    let notes_in = vec![notes::Note {
        id: "n".into(),
        timestamp_ns: latest,
        label: "end".into(),
        kind: notes::EventKind::Note,
        color: None,
    }];

    let outcome = write_blf_capture(dest.to_str().unwrap(), &frames, &notes_in, &[]).unwrap();
    assert_eq!(outcome.frame_count, 121);

    let mut back = BlfCanFrameSource::open(&dest).unwrap();
    let read_back: Vec<u64> = std::iter::from_fn(|| back.next_frame().unwrap())
        .map(|f| f.timestamp_ns)
        .collect();
    assert_eq!(
        read_back, written,
        "every timestamp survives the save, in the order it was written",
    );
    assert_eq!(
        notes_via_import_walk(dest.to_str().unwrap())[0].timestamp_ns,
        latest,
        "the note rides the same timeline",
    );

    // The header's own span covers the capture rather than inverting.
    let stats = *back.file_statistics();
    assert_eq!(stats.measurement_start_time.to_unix_nanos(), earliest);
    assert_eq!(stats.last_object_time.to_unix_nanos(), latest);
}

/// The clamp that survives by design — a caller appending without a
/// declared anchor — is described, never silent. `write_blf_capture`
/// declares one, so in the GUI this warning does not fire; it guards
/// the next caller.
#[test]
fn a_clamped_timestamp_is_named_with_the_frame_and_the_error() {
    use cannet_blf::{ClampedEvent, FinishedCapture};
    let clean = FinishedCapture {
        frame_count: 3,
        marker_count: 0,
        byte_size: 400,
        max_timestamp_drift_ns: 0,
        clamped_count: 0,
        worst_clamp: None,
    };
    assert!(capture::clamped_timestamp_warning(&clean).is_none());

    let clamped = FinishedCapture {
        clamped_count: 2,
        worst_clamp: Some(ClampedEvent {
            timestamp_ns: 1_700_000_000_500_000_000,
            error_ns: 1_500_000_000,
            frame: Some((1, 0x1AB)),
        }),
        ..clean
    };
    let warning = capture::clamped_timestamp_warning(&clamped).expect("a clamp is reported");
    assert!(warning.contains('2'), "{warning}");
    assert!(warning.contains("1500.000 ms"), "{warning}");
    assert!(warning.contains("channel 1"), "{warning}");
    assert!(warning.contains("0x1AB"), "{warning}");
    assert!(warning.contains("1700000000500000000"), "{warning}");

    // A marker carries neither channel nor id, so it is named as what
    // it is rather than as a frame with blank fields.
    let note_clamped = FinishedCapture {
        clamped_count: 1,
        worst_clamp: Some(ClampedEvent {
            timestamp_ns: 1_700_000_000_000_000_000,
            error_ns: 250_000,
            frame: None,
        }),
        ..clean
    };
    let warning = capture::clamped_timestamp_warning(&note_clamped).expect("a clamp is reported");
    assert!(warning.contains("a note"), "{warning}");
    assert!(warning.contains("0.250 ms"), "{warning}");
}

/// Third-party-written `GLOBAL_MARKER`s (no `description` =
/// no cannet id) get synthetic `blf-marker-N` ids on read, so
/// rename / remove on them still works through the existing
/// id-keyed APIs.
#[test]
fn the_import_walk_mints_synthetic_ids_for_third_party_markers() {
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

    let read = notes_via_import_walk(dest.to_str().unwrap());
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
        let channel_to_bus = vec![(1u8, "q".to_string())];
        while !stop_for_pump.load(Ordering::Relaxed) {
            let Some(frame) = cannet_core::CanFrameSource::next_frame(&mut adapter)
                .ok()
                .flatten()
            else {
                break;
            };
            let mut raw = RawTraceFrame::from(frame);
            if let Some(bid) = route_channel(raw.channel, &channel_to_bus) {
                raw.bus_id = Some(bid);
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
        channel_to_bus: vec![(0, "p".into()), (1, "q".into())],
        stop: Arc::new(AtomicBool::new(false)),
        clock: None,
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
    let dbs = vec![loaded_scoped("a.dbc", CALC_ATTR_DBC, &["p"])];
    let resolved = resolve_effective_calc(&plain_model(&dbs), &calc_request("p", 291), None)
        .unwrap()
        .expect("DBC-declared fields resolve");
    // Counter at bits 40..44 (byte 5 low nibble), CRC in byte 7.
    let mut payload = [0u8; 8];
    let mut counter = 0;
    resolved.apply(&mut counter, &mut payload).unwrap();
    assert_eq!(payload[5] & 0x0F, 1);
    assert_ne!(payload[7], 0);
    // A message without any designation resolves to None.
    let dbs2 = vec![loaded_scoped("b.dbc", &tiny_dbc(291, "Plain", "S"), &["p"])];
    assert!(
        resolve_effective_calc(&plain_model(&dbs2), &calc_request("p", 291), None)
            .unwrap()
            .is_none()
    );
}

#[test]
fn override_replaces_the_dbc_default_per_field() {
    let dbs = vec![loaded_scoped("a.dbc", CALC_ATTR_DBC, &["p"])];
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
    let resolved = resolve_effective_calc(&plain_model(&dbs), &calc_request("p", 291), Some(&spec))
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
    assert!(
        resolve_effective_calc(&plain_model(&dbs), &calc_request("p", 291), None)
            .unwrap()
            .is_none()
    );
    assert!(
        resolve_effective_calc(&plain_model(&dbs), &calc_request("q", 291), None)
            .unwrap()
            .is_some()
    );
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
    assert!(
        resolve_effective_calc(&plain_model(&dbs), &calc_request("q", 291), Some(&bad)).is_err()
    );
    // … and so is an override on a message no DBC defines.
    assert!(
        resolve_effective_calc(&plain_model(&dbs), &calc_request("p", 291), Some(&bad)).is_err()
    );
}

#[test]
fn a_malformed_calculated_field_attribute_warns_instead_of_vanishing() {
    // A typo in a `CannetCounter` value costs the designation, and
    // the only other symptom is a message that has no counter — which
    // is indistinguishable from one that was never given one. The
    // load surfaces the file, the message, the signal and the
    // attribute text so the reason is on the system log.
    let state = test_state();
    let typo = CALC_ATTR_DBC.replace("increment=1;rollover=15", "rolover=15");
    let installed = crate::dbc_commands::install_dbc(&state, "typo.dbc", &typo).unwrap();
    let warning = installed
        .warnings
        .iter()
        .find(|w| w.contains("CannetCounter"))
        .expect("the malformed designation warns");
    assert!(warning.contains("Status.AliveCtr"), "{warning}");
    assert!(warning.contains("rolover=15"), "{warning}");
    // Control: the same DBC without the typo loads clean, so the
    // warning is the typo's and not the file's.
    let clean = crate::dbc_commands::install_dbc(&state, "clean.dbc", CALC_ATTR_DBC).unwrap();
    assert!(clean.warnings.is_empty(), "{:?}", clean.warnings);
}

/// 291 `Status` with `AliveCtr` at `ctr_start`, and the cannet
/// counter / CRC attributes only when `with_attrs`.
fn calc_placement_dbc(ctr_start: u32, with_attrs: bool) -> String {
    let attrs = if with_attrs {
        "BA_DEF_ SG_ \"CannetCounter\" STRING ;\n\
         BA_DEF_ SG_ \"CannetCrc\" STRING ;\n\
         BA_DEF_DEF_ \"CannetCounter\" \"\";\n\
         BA_DEF_DEF_ \"CannetCrc\" \"\";\n\
         BA_ \"CannetCounter\" SG_ 291 AliveCtr \"increment=1;rollover=15\";\n\
         BA_ \"CannetCrc\" SG_ 291 Crc8 \"alg=CRC-8/SAE-J1850;range=0:56\";\n"
    } else {
        ""
    };
    format!(
        "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\n\
         BO_ 291 Status: 8 ECU\n\
         \x20SG_ Mode : 0|8@1+ (1,0) [0|255] \"\" ECU\n\
         \x20SG_ AliveCtr : {ctr_start}|4@1+ (1,0) [0|15] \"\" ECU\n\
         \x20SG_ Crc8 : 56|8@1+ (1,0) [0|255] \"\" ECU\n\n{attrs}"
    )
}

#[test]
fn a_transmit_rows_calculated_fields_come_from_the_defining_database() {
    // `a.dbc` defines 291 and designates nothing; `b.dbc`, behind it
    // on the same bus, defines 291 and designates a counter and a CRC.
    // The row transmits a.dbc's message, so a.dbc's designations —
    // none — are the ones in force (ADR 0054).
    let dbs = vec![
        loaded_scoped("a.dbc", &calc_placement_dbc(48, false), &["p"]),
        loaded_scoped("b.dbc", &calc_placement_dbc(40, true), &["p"]),
    ];
    assert!(
        resolve_effective_calc(&plain_model(&dbs), &calc_request("p", 291), None)
            .unwrap()
            .is_none(),
        "b.dbc's designations are not borrowed onto a.dbc's message",
    );

    // With an override, the signal it names is placed where the
    // defining database puts it: bit 48, byte 6's low nibble.
    let spec = ipc::CalcFieldsSpec {
        counter: Some(ipc::CounterSpec {
            signal: "AliveCtr".into(),
            increment: 1,
            rollover: Some(15),
        }),
        crc: None,
    };
    let resolved = resolve_effective_calc(&plain_model(&dbs), &calc_request("p", 291), Some(&spec))
        .unwrap()
        .expect("the override configures the message");
    let mut payload = [0u8; 8];
    let mut counter = 0;
    resolved.apply(&mut counter, &mut payload).unwrap();
    assert_eq!(payload, [0, 0, 0, 0, 0, 0, 1, 0]);

    // Reversed, b.dbc defines the message and both of its designations
    // apply — which is what makes the two assertions above evidence.
    let dbs = vec![
        loaded_scoped("b.dbc", &calc_placement_dbc(40, true), &["p"]),
        loaded_scoped("a.dbc", &calc_placement_dbc(48, false), &["p"]),
    ];
    let resolved = resolve_effective_calc(&plain_model(&dbs), &calc_request("p", 291), None)
        .unwrap()
        .expect("b.dbc designates a counter and a CRC");
    let mut payload = [0u8; 8];
    let mut counter = 0;
    resolved.apply(&mut counter, &mut payload).unwrap();
    assert_eq!(payload[5] & 0x0F, 1, "b.dbc's counter, four bits away");
    assert_ne!(payload[7], 0, "and the CRC it designates");
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
//   full/mem — convert + `TraceStore::append` against the in-RAM raw
//              store; the gap to `full` is the disk-spill write
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

    // -- markers: the whole-file second decode the notes pre-pass used
    //    to run before the pump started, kept here (and only here) as
    //    the cost the one-pass import removed. The import itself now
    //    collects markers on the pump's own walk, which is what the
    //    `decode` phase below already covers.
    let t = std::time::Instant::now();
    let mut reader = cannet_blf::format::reader::BlfReader::open(&blf).unwrap();
    let mut markers = 0usize;
    while let Some(obj) = reader.next_object().unwrap() {
        if matches!(obj, cannet_blf::format::reader::BlfObject::GlobalMarker(_)) {
            markers += 1;
        }
    }
    report("markers*", t.elapsed().as_secs_f64());
    assert!(markers > 0, "the removed pre-pass saw the markers");

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
    let channel_to_bus: Vec<(u8, String)> = (0..CHANNELS).map(|c| (c, format!("bus{c}"))).collect();
    let verifier = verification::VerificationState::default();
    let mut source = BlfCanFrameSource::open(&blf).unwrap();
    let t = std::time::Instant::now();
    let mut kept = 0usize;
    while let Some(frame) = source.next_frame().unwrap() {
        let mut raw = RawTraceFrame::from(frame);
        let Some(bid) = route_channel(raw.channel, &channel_to_bus) else {
            continue;
        };
        raw.bus_id = Some(bid);
        let _checked = verifier.wants(&raw).then(|| raw.clone());
        kept += 1;
        std::hint::black_box(&raw);
    }
    report("convert", t.elapsed().as_secs_f64());
    assert_eq!(kept, frames);

    // -- full/mem: the same body against the in-RAM raw store. The
    //    difference from `full` is what the disk-spill segment write
    //    costs; what's left is the store's derived state (the per-key
    //    maps, the retention clone, the rate trackers).
    let store = TraceStore::new();
    let mut source = BlfCanFrameSource::open(&blf).unwrap();
    let t = std::time::Instant::now();
    let mut first = true;
    while let Some(frame) = source.next_frame().unwrap() {
        let mut raw = RawTraceFrame::from(frame);
        let Some(bid) = route_channel(raw.channel, &channel_to_bus) else {
            continue;
        };
        raw.bus_id = Some(bid);
        if first {
            store.start_session(raw.timestamp_ns);
            first = false;
        }
        let checked = verifier.wants(&raw).then(|| raw.clone());
        if store.append(raw).is_some() {
            std::hint::black_box(&checked);
        }
    }
    report("full/mem", t.elapsed().as_secs_f64());
    assert_eq!(store.len(), frames);
    drop(store);

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
            let Some(bid) = route_channel(raw.channel, &channel_to_bus) else {
                continue;
            };
            raw.bus_id = Some(bid);
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

// ---- Replacing a DBC: what survives -------------------------------
//
// The three paths a DBC "load" can take, and what each leaves of the
// derived state:
//
// - **Reload in place** — `install_dbc` under a path already loaded.
//   The slot's `db` is swapped and its bus scoping is left alone.
// - **The watcher reload** — `dbc_watcher::reload_one`. Swaps the same
//   slot the same way, then calls the same
//   [`invalidate_derived_caches`] and the same announcement every other
//   path makes (ADR 0053 §2), so nothing a view can see distinguishes
//   it from the reload above. Not exercised here: it takes an
//   `AppHandle`, and this crate has no Tauri mock-app harness.
// - **Replace** — a *different* file installed and the old one removed.
//   Two DBC-set changes, with both databases loaded in between.
//
// All three end at `invalidate_derived_caches`, so the pyramids are
// judged per signal by their encoding fingerprint (ADR 0047) rather
// than dropped wholesale. What these tests pin is what that judgement
// actually produces when the replacement is *nearly* the file it
// replaced.

/// Message 256 with `A` in bytes 0-1 and `B` in bytes 2-3, each at a
/// nameable scale — the one decode input a near-identical replacement
/// moves.
fn ab_dbc_text(a_factor: u32, b_factor: u32) -> String {
    format!(
        "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\nBO_ 256 Msg: 8 ECU\n \
         SG_ A : 0|16@1+ ({a_factor},0) [0|0] \"\" Vector__XXX\n \
         SG_ B : 16|16@1+ ({b_factor},0) [0|0] \"\" Vector__XXX\n"
    )
}

/// A frame of message 256 carrying `A` in bytes 0-1 and `B` in 2-3.
fn ab_frame_256(ts_ns: u64, a: u16, b: u16) -> RawTraceFrame {
    let ([a0, a1], [b0, b1]) = (a.to_le_bytes(), b.to_le_bytes());
    RawTraceFrame {
        timestamp_ns: ts_ns,
        payload: CanFramePayload::Classic(vec![a0, a1, b0, b1, 0, 0, 0, 0]),
        ..dummy_frame(ts_ns, 256)
    }
}

/// An `AppState` whose pyramid scratch is this test's own directory
/// (`test_state`'s is reused across runs, so a manifest an earlier run
/// left behind would be *staged* and block `persist`), holding `n`
/// decodable frames of message 256 on `bus`, or on [`TEST_BUS`] when
/// the test does not care which — the store holds no bus-less frame.
#[allow(clippy::cast_possible_truncation)]
fn ab_state(scratch: &std::path::Path, bus: Option<&str>, n: u64) -> AppState {
    let state = test_state();
    state.signal_caches.reroot(scratch);
    for i in 0..n {
        let mut f = ab_frame_256(i * 1_000_000_000, (i % 50) as u16, (i % 40) as u16);
        f.bus_id = Some(bus.unwrap_or(TEST_BUS).to_owned());
        state.trace_store.append(f);
    }
    state
}

/// Serve `signal` out of `state`'s pyramids, decoded through the DBC
/// set `state` currently holds. `store` is a parameter so a test can
/// serve against a capture nothing decodes — anything that comes back
/// then came from a pyramid, not from a rebuild.
fn ab_serve(state: &AppState, store: &TraceStore, bus: Option<&str>, signal: &str) -> usize {
    let dbcs = state.databases();
    let scopes = state.decode_model(&dbcs);
    state
        .signal_caches
        .slice(
            bus,
            256,
            false,
            signal,
            f64::MIN,
            f64::MAX,
            0,
            store,
            &scopes,
        )
        .len()
}

/// A capture of `n` frames no DBC decodes, the same length as the one
/// the pyramids were built over — so a serve against it advances no
/// cursor and returns only what a pyramid already holds.
fn ab_cold_store(n: u64) -> TraceStore {
    let store = TraceStore::new();
    for i in 0..n {
        store.append(dummy_frame(i * 1_000_000_000, 999));
    }
    store
}

/// Assign a loaded database to [`TEST_BUS`] — what the Database panel's
/// bus checkbox does, through the command's own body, and what makes it
/// decode at all.
fn ab_assign(state: &AppState, path: &str) {
    assert!(
        state.databases().iter().any(|d| d.path == path),
        "the database is loaded",
    );
    crate::dbc_commands::set_dbc_buses_inner(state, path, test_bus_scope());
}

/// Drop a loaded database from the project, through the command's own
/// body rather than a copy of it.
fn ab_remove(state: &AppState, path: &str) {
    crate::dbc_commands::remove_dbc_inner(state, path).expect("the database was loaded");
}

#[test]
fn a_reload_in_place_keeps_the_unchanged_signals_pyramid_and_rebuilds_the_changed_one() {
    // The first of the three paths, and the cheapest: `add_dbc` under a
    // path already loaded swaps that slot's parsed database and leaves
    // everything else about the entry — its position in the priority
    // order, its bus scoping — where it was. So a signal the edit did
    // not touch keeps a candidate chain identical to the one it was
    // decoded under, and its pyramid never even leaves the live set.
    let scratch = tempfile::TempDir::new().unwrap();
    let state = ab_state(scratch.path(), None, 200);
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    ab_assign(&state, "a.dbc");
    assert_eq!(
        ab_serve(&state, &state.trace_store, Some(TEST_BUS), "A"),
        200
    );
    assert_eq!(
        ab_serve(&state, &state.trace_store, Some(TEST_BUS), "B"),
        200
    );

    // Re-export the same file with `B` rescaled and reload it in place.
    let reloaded = crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 2)).unwrap();
    assert!(
        reloaded.reloaded,
        "same path -> a reload, not a second entry"
    );
    assert_eq!(state.databases().len(), 1, "and no second entry");

    let usage = state.signal_caches.usage();
    assert_eq!(usage.live, 1, "A never left the live set");
    assert_eq!(usage.retained, 1, "B is parked, not deleted");
    assert_eq!(usage.revivals, 0, "and A did not have to be handed back");

    // Proof rather than counting: served against a capture nothing
    // decodes, `A` still answers with its 200 samples (they are the
    // pyramid's, since no frame here can produce one) and `B` answers
    // with nothing (its pyramid went with its definition).
    let cold = ab_cold_store(200);
    assert_eq!(
        ab_serve(&state, &cold, Some(TEST_BUS), "A"),
        200,
        "A's samples stand"
    );
    assert_eq!(
        ab_serve(&state, &cold, Some(TEST_BUS), "B"),
        0,
        "B's are gone"
    );
}

#[test]
fn replacing_a_dbc_with_a_near_identical_file_keeps_the_unchanged_signals_pyramid() {
    // The third path, and the one the design question is about: a
    // *different* file added and the old one removed. It is two DBC-set
    // changes with both databases loaded in between — and neither of
    // them touches the signal the replacement defines exactly as the
    // file it stands in for did. A value depends on the definition that
    // decodes it and on nothing else (ADR 0054), so the newcomer is
    // inert while the incumbent is in front of it, and taking the
    // incumbent away leaves `A` decoding what it already decoded. Only
    // `B`, which the replacement rescales, is a change of definition.
    let scratch = tempfile::TempDir::new().unwrap();
    let state = ab_state(scratch.path(), None, 200);
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    ab_assign(&state, "a.dbc");
    assert_eq!(
        ab_serve(&state, &state.trace_store, Some(TEST_BUS), "A"),
        200
    );
    assert_eq!(
        ab_serve(&state, &state.trace_store, Some(TEST_BUS), "B"),
        200
    );

    // Step 1: the replacement is installed alongside. `A` is defined
    // exactly as before; `B` is rescaled. Loading it changes nothing
    // yet — an unassigned database is no part of any chain.
    crate::dbc_commands::install_dbc(&state, "b.dbc", &ab_dbc_text(1, 2)).unwrap();
    let loaded_only = state.signal_caches.usage();
    assert_eq!(
        (loaded_only.live, loaded_only.retained),
        (2, 0),
        "loading a file decodes nothing, so no chain moved",
    );
    // Assigning it to the bus does not either: it is behind the file
    // that already decodes both signals, so it supplies no sample.
    ab_assign(&state, "b.dbc");
    let mid = state.signal_caches.usage();
    assert_eq!(
        (mid.live, mid.retained),
        (2, 0),
        "the incumbent still decodes both, so neither pyramid moves",
    );

    // Step 2: the old file is removed, so the replacement is now the
    // definition — the same one for `A`, another one for `B`.
    ab_remove(&state, "a.dbc");
    let usage = state.signal_caches.usage();
    assert_eq!(usage.live, 1, "A's definition is what it was, so A stands");
    assert_eq!(usage.revivals, 0, "…without ever having left for the pool");
    assert_eq!(usage.retained, 1, "B stays parked against its return");

    let cold = ab_cold_store(200);
    assert_eq!(
        ab_serve(&state, &cold, Some(TEST_BUS), "A"),
        200,
        "A's samples stand"
    );
    assert_eq!(
        ab_serve(&state, &cold, Some(TEST_BUS), "B"),
        0,
        "B's are gone"
    );

    // The view-config half. Plot series, signal-view patterns and RBS
    // entries name a signal by identity — bus, message id, name — never
    // by the database that defined it, so a replacement defining the
    // same messages leaves every one of them resolving. The descriptor
    // universe every such view resolves through is rebuilt by the same
    // invalidation, against the database now loaded.
    let named: Vec<(Option<String>, u32, String)> = state
        .scoped_descriptor_snapshot()
        .iter()
        .map(|(bus, d)| (bus.clone(), d.message_id, d.signal_name.clone()))
        .collect();
    assert_eq!(
        named,
        vec![
            (Some(TEST_BUS.to_string()), 256, "A".to_string()),
            (Some(TEST_BUS.to_string()), 256, "B".to_string()),
        ],
        "both signals still resolve, on the same identity, after the replace",
    );
}

#[test]
fn a_replacement_dbc_does_not_inherit_the_bus_scoping_of_the_file_it_replaced() {
    // The half of a replace that does *not* survive. `install_dbc`
    // gives a newly-added entry an empty bus list — assigned to
    // nothing — because it has no way to know this file is standing in
    // for another. So even a byte-identical replacement decodes
    // differently (it answers for no bus at all until it is assigned),
    // the encoding fingerprint moves with it, and every pyramid the
    // replaced file backed rebuilds. The pool keeps the samples against
    // the user assigning it, which is what puts the chain back.
    let scratch = tempfile::TempDir::new().unwrap();
    let state = ab_state(scratch.path(), Some("pt"), 200);
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    state.databases()[0].buses = vec!["pt".to_string()];
    invalidate_derived_caches(&state);
    assert_eq!(ab_serve(&state, &state.trace_store, Some("pt"), "A"), 200);
    assert_eq!(ab_serve(&state, &state.trace_store, Some("pt"), "B"), 200);

    // A byte-identical file under a new name, installed and the old one
    // removed — the same content, the same signals, the same scale.
    crate::dbc_commands::install_dbc(&state, "b.dbc", &ab_dbc_text(1, 1)).unwrap();
    ab_remove(&state, "a.dbc");
    assert!(
        state.databases()[0].buses.is_empty(),
        "the replacement is unassigned, whatever the file it replaced was",
    );
    let usage = state.signal_caches.usage();
    assert_eq!(
        (usage.live, usage.retained, usage.revivals),
        (0, 2, 0),
        "so nothing is reused: both pyramids are parked and rebuild",
    );

    // Re-scoping it the way the replaced file was scoped puts the chain
    // back where it was, and the pool answers for both.
    state.databases()[0].buses = vec!["pt".to_string()];
    invalidate_derived_caches(&state);
    let usage = state.signal_caches.usage();
    assert_eq!(
        (usage.live, usage.retained, usage.revivals),
        (2, 0, 2),
        "the samples were never lost, only unreferenced",
    );
    let cold = ab_cold_store(200);
    assert_eq!(ab_serve(&state, &cold, Some("pt"), "A"), 200);
    assert_eq!(ab_serve(&state, &cold, Some("pt"), "B"), 200);
}

// ---- Assignment is the cache lifecycle boundary --------------------

#[test]
fn unassigning_a_database_parks_its_caches_and_re_assigning_revives_them() {
    // `set_dbc_buses` is where the pool is consulted (ADR 0047).
    // Unassigning a database takes it out of every candidate chain it
    // was in, so the pyramids it decoded are re-encoded and park;
    // assigning it puts the chains back, so the same call hands them
    // home rather than re-decoding a capture. There is no second
    // mechanism: a bus change is a DBC-set change.
    let scratch = tempfile::TempDir::new().unwrap();
    let state = ab_state(scratch.path(), Some("pt"), 200);
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);
    assert_eq!(ab_serve(&state, &state.trace_store, Some("pt"), "A"), 200);
    assert_eq!(ab_serve(&state, &state.trace_store, Some("pt"), "B"), 200);

    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", Vec::new());
    let usage = state.signal_caches.usage();
    assert_eq!(
        (usage.live, usage.retained, usage.revivals),
        (0, 2, 0),
        "unassigned: both pyramids parked, neither deleted",
    );

    // The view it was configured for keeps asking — a plot panel does
    // not stop polling because a database was unassigned — so an empty
    // live cache is minted under each key while the park waits. That
    // must not strand the park: the re-assign re-encodes the empty
    // caches first (they hold nothing, so they are wiped rather than
    // parked) and only then consults the pool, which is why the keys
    // are free when the revival looks for them.
    let cold = ab_cold_store(200);
    assert_eq!(
        ab_serve(&state, &cold, Some("pt"), "A"),
        0,
        "an unassigned database decodes nothing",
    );
    assert_eq!(ab_serve(&state, &cold, Some("pt"), "B"), 0);
    assert_eq!(state.signal_caches.usage().live, 2, "…but the view asked");

    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);
    let usage = state.signal_caches.usage();
    assert_eq!(
        (usage.live, usage.retained, usage.revivals),
        (2, 0, 2),
        "re-assigned: both came out of the pool",
    );
    // Proof rather than counting: nothing here decodes, so the samples
    // are the parked ones.
    assert_eq!(ab_serve(&state, &cold, Some("pt"), "A"), 200);
    assert_eq!(ab_serve(&state, &cold, Some("pt"), "B"), 200);
}

#[test]
fn a_view_is_restored_by_the_signal_and_its_samples_by_the_fingerprint() {
    // The guarantee is by signal and fingerprint, **not** by file
    // identity (owner ruling). A view config names
    // `bus | message id : signal` and carries no DBC path, so any
    // assigned database defining that signal restores the view; cache
    // revival keys on the encoding, so a database defining it the way
    // the samples were decoded restores the samples too — and one
    // defining it differently restores the view alone.
    //
    // Both halves are exercised against a file the samples never came
    // from: the database that decoded them is unassigned, then removed
    // from the project outright, before the replacement arrives.
    let scratch = tempfile::TempDir::new().unwrap();
    let state = ab_state(scratch.path(), Some("pt"), 200);
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);
    assert_eq!(ab_serve(&state, &state.trace_store, Some("pt"), "A"), 200);
    assert_eq!(ab_serve(&state, &state.trace_store, Some("pt"), "B"), 200);

    // Unassigned, then gone. The view keeps its configuration — nothing
    // here touches it — and resolves nothing, because no assigned
    // database provides the signals.
    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", Vec::new());
    ab_remove(&state, "a.dbc");
    assert!(
        state.databases().is_empty(),
        "the file the samples were decoded from is out of the project",
    );
    assert_eq!(state.signal_caches.usage().retained, 2, "both parked");
    assert!(
        state.scoped_descriptor_snapshot().is_empty(),
        "and the universe a view resolves through is empty",
    );

    // A different file. `A` is defined exactly as the parked samples
    // were decoded; `B` is rescaled, so it is the same *signal* under a
    // different *encoding*.
    crate::dbc_commands::install_dbc(&state, "b.dbc", &ab_dbc_text(1, 2)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "b.dbc", vec!["pt".to_string()]);

    // The view comes back whole, on signal identity alone.
    let named: Vec<(Option<String>, u32, String)> = state
        .scoped_descriptor_snapshot()
        .iter()
        .map(|(bus, d)| (bus.clone(), d.message_id, d.signal_name.clone()))
        .collect();
    assert_eq!(
        named,
        vec![
            (Some("pt".to_string()), 256, "A".to_string()),
            (Some("pt".to_string()), 256, "B".to_string()),
        ],
        "both signals resolve again, from a file that never decoded them",
    );

    // The samples come back only where the fingerprint answers.
    let usage = state.signal_caches.usage();
    assert_eq!(
        (usage.live, usage.retained, usage.revivals),
        (1, 1, 1),
        "A revived by fingerprint; B is the same signal differently encoded",
    );
    let cold = ab_cold_store(200);
    assert_eq!(
        ab_serve(&state, &cold, Some("pt"), "A"),
        200,
        "A's samples came out of the pool, not off the frames",
    );
    assert_eq!(
        ab_serve(&state, &cold, Some("pt"), "B"),
        0,
        "B's park stays parked: its encoding is not the one on disk",
    );
}

// ---- A `VAL_` renamed on disk -------------------------------------
//
// The watcher's `reload_one` is `install_dbc` under the path already
// loaded, plus the announcement (ADR 0053 §2) — and the announcement
// needs an `AppHandle`, which this crate cannot build in a test (see
// the module note under `dbc_watcher::tests`). What *is* testable here
// is the half the frontend depends on: that after the swap the host
// answers with the new label rather than the one it was serving a
// moment ago. The half that carries it to a view is pinned
// frontend-side.

/// Message 256 with one enum signal `Mode`, whose raw `0` is named
/// `zero_label` — the one thing a `VAL_` rename moves.
fn mode_dbc_text(zero_label: &str) -> String {
    format!(
        "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\nBO_ 256 Msg: 8 ECU\n \
         SG_ Mode : 0|8@1+ (1,0) [0|0] \"\" Vector__XXX\n\n\
         VAL_ 256 Mode 0 \"{zero_label}\" 1 \"On\" ;\n"
    )
}

fn mode_labels(state: &AppState) -> Vec<String> {
    crate::dbc_commands::list_value_tables_inner(state, 256, false, "Mode", false, Some(TEST_BUS))
        .into_iter()
        .map(|e| e.label)
        .collect()
}

#[test]
fn a_val_rename_reloaded_in_place_is_what_the_value_table_lookup_answers() {
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "mode.dbc", &mode_dbc_text("Off")).unwrap();
    ab_assign(&state, "mode.dbc");
    assert_eq!(mode_labels(&state), vec!["Off", "On"]);

    // The file is edited outside the app and re-read under the same
    // identity — what `dbc_watcher::reload_one` does to the loaded set.
    let installed =
        crate::dbc_commands::install_dbc(&state, "mode.dbc", &mode_dbc_text("Standby")).unwrap();
    assert!(
        installed.reloaded,
        "same identity -> a swap, not a second entry"
    );
    assert_eq!(
        mode_labels(&state),
        vec!["Standby", "On"],
        "the lookup answers off the swapped database, with no cache in the way",
    );
}

// ---- Unassigning stops what it was driving -------------------------
//
// The counterpart to ADR 0053 §1's uncommanded-send rule: a periodic
// the user started is putting frames on a real bus, and once no
// database assigned to that bus defines the message any more, those
// frames come from definitions the project no longer applies. The
// unassign is a deliberate gesture, so it proceeds — and the periodic
// stops, through the same path the user's own Stop takes.

/// A periodic project transmit row on `bus` for `can_id`, already
/// firing — `start_periodic_transmit`'s registry half, which is all the
/// stop rule reads (the scheduler thread does not run under test).
fn running_row(state: &AppState, row_id: &str, bus: &str, can_id: u32) {
    let mut registry = state.transmit_frames();
    registry.set(crate::transmit_frames::TransmitFrame {
        id: row_id.to_string(),
        description: String::new(),
        request: crate::ipc::TransmitRequest {
            bus_id: bus.to_string(),
            id: can_id,
            extended: false,
            kind: crate::ipc::TransmitKind::Classic,
            data: vec![0; 8],
            brs: false,
            esi: false,
            dlc: 0,
        },
        cycle_ms: 100,
        mode: crate::transmit_frames::TransmitMode::Periodic,
        source: crate::transmit_frames::TransmitSource::Project,
        calc: None,
    });
    assert_eq!(
        registry.begin_periodic(row_id),
        Ok(true),
        "the row starts firing",
    );
}

#[test]
fn unassigning_a_database_stops_the_periodics_it_was_driving() {
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);
    // One row the database defines, one raw row it never did — a user
    // may transmit an id no DBC on the bus describes, and a database
    // leaving the bus says nothing about that row.
    running_row(&state, "from-dbc", "pt", 256);
    running_row(&state, "hand-typed", "pt", 0x555);

    let stopped = crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", Vec::new());

    assert_eq!(stopped, vec!["from-dbc".to_string()]);
    let registry = state.transmit_frames();
    assert!(!registry.is_running("from-dbc"));
    assert!(
        registry.is_running("hand-typed"),
        "a row no database was driving is none of the unassign's business",
    );
    // The state the panel reads is the one the user's own Stop leaves:
    // the row is still in the pool, still periodic, not running.
    let view = registry
        .list()
        .into_iter()
        .find(|v| v.frame.id == "from-dbc")
        .expect("the row keeps its configuration");
    assert!(!view.running);
    assert_eq!(
        view.frame.mode,
        crate::transmit_frames::TransmitMode::Periodic
    );
    assert_eq!(view.frame.cycle_ms, 100);
}

#[test]
fn a_row_another_assigned_database_still_defines_keeps_firing() {
    // "Built from a database that is unassigned" is measured against
    // what the bus can still decode, not against file identity: a
    // second database on the bus defining the same message means the
    // definitions the row transmits from are still applied.
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::install_dbc(&state, "b.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);
    crate::dbc_commands::set_dbc_buses_inner(&state, "b.dbc", vec!["pt".to_string()]);
    running_row(&state, "row", "pt", 256);

    let stopped = crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", Vec::new());

    assert!(stopped.is_empty(), "{stopped:?}");
    assert!(state.transmit_frames().is_running("row"));
}

#[test]
fn a_row_on_another_bus_is_untouched_by_an_unassign() {
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(
        &state,
        "a.dbc",
        vec!["pt".to_string(), "ch".to_string()],
    );
    running_row(&state, "pt-row", "pt", 256);
    running_row(&state, "ch-row", "ch", 256);

    // Narrowed to `pt`: only the row on the bus the database left stops.
    let stopped = crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);

    assert_eq!(stopped, vec!["ch-row".to_string()]);
    assert!(state.transmit_frames().is_running("pt-row"));
    assert!(!state.transmit_frames().is_running("ch-row"));
}

#[test]
fn assigning_a_database_stops_nothing() {
    // The rule is one-directional. Assigning only ever adds candidates
    // to a bus, so nothing can lose the database behind it.
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    running_row(&state, "row", "pt", 256);

    let stopped = crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);

    assert!(stopped.is_empty(), "{stopped:?}");
    assert!(state.transmit_frames().is_running("row"));
}

#[test]
fn assigning_a_database_that_becomes_the_new_winner_stops_the_row() {
    // The rule is "the mapping the user armed is no longer the mapping
    // that would transmit", and the mapping is the *winning definition*
    // (ADR 0054) — not merely whether one exists. `first.dbc` is loaded
    // ahead of `second.dbc`, so assigning it to the bus makes it the
    // winner for a message the row is already firing from `second.dbc`,
    // and the next frame out would carry a different encoding.
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "first.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::install_dbc(&state, "second.dbc", &ab_dbc_text(2, 2)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "second.dbc", vec!["pt".to_string()]);
    running_row(&state, "row", "pt", 256);

    let stopped =
        crate::dbc_commands::set_dbc_buses_inner(&state, "first.dbc", vec!["pt".to_string()]);

    assert_eq!(stopped, vec!["row".to_string()]);
    assert!(!state.transmit_frames().is_running("row"));
}

#[test]
fn assigning_a_database_that_loses_the_priority_contest_stops_nothing() {
    // The control that makes the case above mean something: the *same*
    // gesture on the *same* row, with only the load order swapped, so
    // the newly assigned database defines the message and still does
    // not win it. The winner did not move, so neither did the mapping,
    // and a rule that stopped on any DBC touch would fail here.
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "first.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::install_dbc(&state, "second.dbc", &ab_dbc_text(2, 2)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "first.dbc", vec!["pt".to_string()]);
    running_row(&state, "row", "pt", 256);

    let stopped =
        crate::dbc_commands::set_dbc_buses_inner(&state, "second.dbc", vec!["pt".to_string()]);

    assert!(stopped.is_empty(), "{stopped:?}");
    assert!(state.transmit_frames().is_running("row"));
}

#[test]
fn assigning_a_database_to_another_bus_stops_nothing() {
    // The second control: the assignment lands somewhere the row does
    // not live, so it cannot move the row's winner however early in
    // load order it sits.
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "first.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::install_dbc(&state, "second.dbc", &ab_dbc_text(2, 2)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "second.dbc", vec!["pt".to_string()]);
    running_row(&state, "row", "pt", 256);

    let stopped =
        crate::dbc_commands::set_dbc_buses_inner(&state, "first.dbc", vec!["ch".to_string()]);

    assert!(stopped.is_empty(), "{stopped:?}");
    assert!(state.transmit_frames().is_running("row"));
}

#[test]
fn a_row_that_was_not_firing_is_not_reported_as_stopped() {
    // One log line records what *stopped*; a row parked in Manual mode,
    // or one the user had already stopped, stopped nothing.
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);
    running_row(&state, "row", "pt", 256);
    state.transmit_frames().stop_periodic("row");

    let stopped = crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", Vec::new());

    assert!(stopped.is_empty(), "{stopped:?}");
}

#[test]
fn removing_a_database_stops_the_periodics_it_was_driving() {
    // Removing a database removes it from its assigned buses (the
    // task's model, rule 3), so it reaches the same rule by the same
    // route — a row transmitting definitions the project has dropped.
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);
    running_row(&state, "row", "pt", 256);

    let stopped = crate::dbc_commands::remove_dbc_inner(&state, "a.dbc");

    assert_eq!(stopped, Some(vec!["row".to_string()]));
    assert!(!state.transmit_frames().is_running("row"));
}

// ---- Reloading a database stops what it was driving ----------------
//
// The same uncommanded send, reached the other way round: a database
// reloaded in place can change or drop the very definitions a periodic
// is transmitting from, and the user did not type the gesture — which
// makes it more surprising than an unassign, not less. The reload
// itself still applies (ADR 0053 §1 governs the swap); the stop happens
// first.

/// One message with one signal, so a reload can *add* an id the
/// database did not define before.
fn one_message_dbc_text(can_id: u32) -> String {
    format!(
        "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\nBO_ {can_id} Msg: 8 ECU\n \
         SG_ S : 0|8@1+ (1,0) [0|0] \"\" Vector__XXX\n"
    )
}

/// A reload in place, as every reload path performs it: snapshot what
/// the set is driving, swap, then stop what the reloaded database was
/// driving. Returns the ids stopped.
fn reload_in_place(state: &AppState, path: &str, text: &str) -> Vec<String> {
    let backed_before = crate::transmit_commands::dbc_backed_running_periodics(state);
    let installed = crate::dbc_commands::install_dbc(state, path, text).unwrap();
    assert!(
        installed.reloaded,
        "same identity -> a swap, not a new entry"
    );
    crate::transmit_commands::stop_periodics_driven_by(state, &backed_before, path)
}

#[test]
fn reloading_a_database_stops_the_periodics_it_was_driving() {
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);
    running_row(&state, "from-dbc", "pt", 256);
    // A raw id no database on the bus describes, and a row the database
    // does define but that the user already stopped: neither is the
    // reload's business, and neither may be counted.
    running_row(&state, "hand-typed", "pt", 0x555);
    running_row(&state, "parked", "pt", 256);
    state.transmit_frames().stop_periodic("parked");

    let stopped = reload_in_place(&state, "a.dbc", &ab_dbc_text(2, 1));

    assert_eq!(stopped, vec!["from-dbc".to_string()]);
    let registry = state.transmit_frames();
    assert!(!registry.is_running("from-dbc"));
    assert!(
        registry.is_running("hand-typed"),
        "a row no database was driving is none of the reload's business",
    );
    // The state the panel reads is the one the user's own Stop leaves.
    let view = registry
        .list()
        .into_iter()
        .find(|v| v.frame.id == "from-dbc")
        .expect("the row keeps its configuration");
    assert!(!view.running);
    assert_eq!(
        view.frame.mode,
        crate::transmit_frames::TransmitMode::Periodic
    );
    assert_eq!(view.frame.cycle_ms, 100);
    drop(registry);
    // And the reload itself applied: the swapped scale is what the bus
    // now answers with.
    let dbs = state.databases();
    let a_factor = state
        .decode_model(&dbs)
        .message_source(Some("pt"), 256, false)
        .and_then(|d| {
            d.db.describe_message(cannet_core::CanId::new(256, false).unwrap())
        })
        .expect("the reloaded database still backs the bus")
        .signals
        .into_iter()
        .find(|s| s.name == "A")
        .expect("A is still defined")
        .factor;
    assert!((a_factor - 2.0).abs() < f64::EPSILON, "{a_factor}");
}

#[test]
fn a_row_a_different_database_defines_survives_a_reload() {
    // "Driven by the database that reloaded" is the same per-bus
    // priority scan the transmit panel's own queries use: the winner
    // for this id is `b.dbc`, so reloading `a.dbc` changes nothing the
    // row transmits.
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "b.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "b.dbc", vec!["pt".to_string()]);
    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);
    running_row(&state, "row", "pt", 256);

    let stopped = reload_in_place(&state, "a.dbc", &ab_dbc_text(2, 1));

    assert!(stopped.is_empty(), "{stopped:?}");
    assert!(state.transmit_frames().is_running("row"));
}

#[test]
fn a_reload_that_takes_over_a_message_stops_the_row_it_now_drives() {
    // The scan is asked either side of the swap, so a reload that makes
    // the database the *new* winner for an id is caught too: the row's
    // definitions moved underneath it just the same.
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "a.dbc", &one_message_dbc_text(0x111)).unwrap();
    crate::dbc_commands::install_dbc(&state, "b.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);
    crate::dbc_commands::set_dbc_buses_inner(&state, "b.dbc", vec!["pt".to_string()]);
    running_row(&state, "row", "pt", 256);

    let stopped = reload_in_place(&state, "a.dbc", &ab_dbc_text(3, 1));

    assert_eq!(stopped, vec!["row".to_string()]);
    assert!(!state.transmit_frames().is_running("row"));
}

#[test]
fn reloading_a_database_assigned_to_no_bus_stops_nothing() {
    // A database assigned to nothing decodes nothing and drives
    // nothing, so its content changing cannot reach a row.
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    running_row(&state, "row", "pt", 256);

    let stopped = reload_in_place(&state, "a.dbc", &ab_dbc_text(2, 1));

    assert!(stopped.is_empty(), "{stopped:?}");
    assert!(state.transmit_frames().is_running("row"));
}

// ---- The Database panel warns on a duplicate id ---------------------
//
// Priority stays one project-wide load order; assignment filters it
// (`DecodeModel::eligible`). Two databases assigned to one bus
// that define the same id is a weird case, but it warns rather than
// silently deciding for the user which one wins.

#[test]
fn set_dbc_buses_wires_up_a_bus_collision_the_real_load_and_assign_path_produces() {
    // Through `install_dbc` / `set_dbc_buses_inner` — the same calls
    // the panel's Add / bus-checkbox actions make — rather than
    // building `LoadedDbc`s by hand, so a wiring mistake between the
    // two would show up here even if `dbc_collisions` itself is right.
    let state = test_state();
    crate::dbc_commands::install_dbc(&state, "a.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::install_dbc(&state, "b.dbc", &ab_dbc_text(1, 2)).unwrap();
    // c.dbc defines the same signals but never shares a bus with
    // either — it must collide with neither.
    crate::dbc_commands::install_dbc(&state, "c.dbc", &ab_dbc_text(1, 1)).unwrap();
    crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", vec!["pt".to_string()]);
    crate::dbc_commands::set_dbc_buses_inner(&state, "b.dbc", vec!["pt".to_string()]);
    crate::dbc_commands::set_dbc_buses_inner(&state, "c.dbc", vec!["ch".to_string()]);

    let dbs = state.databases();
    let collisions = crate::signal_snapshot::dbc_collisions(
        dbs.iter()
            .map(|d| (d.path.as_str(), d.db.as_ref(), d.buses.as_slice())),
        &crate::signal_fingerprint::SignalDbcPicks::new(),
    );
    drop(dbs);

    let mut names: Vec<&str> = collisions.iter().map(|c| c.signal_name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["A", "B"], "a.dbc and b.dbc collide on both");
    assert!(collisions.iter().all(|c| c.bus_id == "pt"));
    assert!(collisions.iter().all(|c| c.winner_path == "a.dbc"));
    assert!(collisions.iter().all(|c| c.loser_path == "b.dbc"));
}

// ---- Whose definition supplies the multiplexor selector ------------

/// 512 `Modes`, multiplexed, with the selector byte at `sel_bit` and
/// two one-byte arms behind it.
fn mux_at(sel_bit: u32) -> String {
    format!(
        "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: Zonal\n\n\
         BO_ 512 Modes: 8 Zonal\n\
         \x20SG_ Mux M : {sel_bit}|8@1+ (1,0) [0|0] \"\" Zonal\n\
         \x20SG_ ModeA m0 : 16|8@1+ (1,0) [0|0] \"\" Zonal\n\
         \x20SG_ ModeB m1 : 16|8@1+ (1,0) [0|0] \"\" Zonal\n"
    )
}

/// The selector values the mux index found for 512 over the whole
/// trace.
fn selectors_seen(state: &AppState) -> Vec<u64> {
    let mut found: Vec<u64> = state
        .trace_store
        .latest_mux_in_window(Some(TEST_BUS), 512, false, &[0, 1, 7, 9], 0, usize::MAX)
        .into_keys()
        .collect();
    found.sort_unstable();
    found
}

#[test]
fn the_mux_selector_comes_from_the_database_that_defines_the_multiplexor() {
    // Two databases on one bus define 512 multiplexed, each reading
    // the selector from a different byte. The first defines `Mux`, so
    // its reading is the one the mux index carries (ADR 0054).
    let state = test_state();
    *state.databases.lock().unwrap() = vec![
        loaded_scoped("a.dbc", &mux_at(8), &[TEST_BUS]),
        loaded_scoped("b.dbc", MUX_SNAPSHOT_DBC, &[TEST_BUS]),
    ];
    invalidate_derived_caches(&state);
    // Byte 0 reads 1 (b.dbc's selector), byte 1 reads 7 (a.dbc's).
    state.trace_store.append(modes_frame(0, 1, 7, 9));
    assert_eq!(selectors_seen(&state), vec![7]);

    // Order reversed, b.dbc's byte-0 selector is the definition.
    let state = test_state();
    *state.databases.lock().unwrap() = vec![
        loaded_scoped("b.dbc", MUX_SNAPSHOT_DBC, &[TEST_BUS]),
        loaded_scoped("a.dbc", &mux_at(8), &[TEST_BUS]),
    ];
    invalidate_derived_caches(&state);
    state.trace_store.append(modes_frame(0, 1, 7, 9));
    assert_eq!(selectors_seen(&state), vec![1]);
}

#[test]
fn the_mux_selector_comes_from_the_database_the_pick_names() {
    // The cure for a selector read against the wrong file: pin `Mux`
    // in the signal-mapping panel and the mux index follows, the same
    // way every other decoded value does (ADR 0054). Without the pick
    // the same set answers 7, so this is a choice being honoured.
    let mux_state = |order: [&str; 2], pick: Option<&str>| -> AppState {
        let state = test_state();
        *state.databases.lock().unwrap() = order
            .iter()
            .map(|p| {
                if *p == "a.dbc" {
                    loaded_scoped("a.dbc", &mux_at(8), &[TEST_BUS])
                } else {
                    loaded_scoped("b.dbc", MUX_SNAPSHOT_DBC, &[TEST_BUS])
                }
            })
            .collect();
        if let Some(p) = pick {
            let mut picks = crate::signal_fingerprint::SignalDbcPicks::new();
            picks.insert(
                crate::signal_snapshot::signal_identity(Some(TEST_BUS), 512, false, "Mux", false),
                p.to_owned(),
            );
            *state.signal_dbc_picks.lock().unwrap() = std::sync::Arc::new(picks);
        }
        invalidate_derived_caches(&state);
        // Byte 0 reads 1 (b.dbc's selector), byte 1 reads 7 (a.dbc's).
        state.trace_store.append(modes_frame(0, 1, 7, 9));
        state
    };
    assert_eq!(
        selectors_seen(&mux_state(["a.dbc", "b.dbc"], None)),
        vec![7]
    );
    assert_eq!(
        selectors_seen(&mux_state(["a.dbc", "b.dbc"], Some("b.dbc"))),
        vec![1],
        "the pick moves it off load order",
    );
    // Reversed, with the pick reversed to match: the same
    // discrimination the other way round.
    assert_eq!(
        selectors_seen(&mux_state(["b.dbc", "a.dbc"], None)),
        vec![1]
    );
    assert_eq!(
        selectors_seen(&mux_state(["b.dbc", "a.dbc"], Some("a.dbc"))),
        vec![7],
    );
    // A pick naming the database load order already chose changes
    // nothing.
    assert_eq!(
        selectors_seen(&mux_state(["a.dbc", "b.dbc"], Some("a.dbc"))),
        vec![7],
    );
}

#[test]
fn a_multiplexor_only_one_database_defines_is_still_that_databases_to_supply() {
    // `a.dbc` is ahead on the bus and defines 512 with no multiplexor
    // at all, so it defines no `Mux`, `ModeA` or `ModeB` — those
    // signals have exactly one definition on this bus and it is
    // b.dbc's. Reading the selector from b.dbc is therefore the rule
    // applied, not skipped: resolution is per signal, and a database
    // that does not define a signal is not a candidate for it.
    let state = test_state();
    let plain = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: Zonal\n\n\
        BO_ 512 Modes: 8 Zonal\n\
        \x20SG_ Always : 24|8@1+ (1,0) [0|0] \"\" Zonal\n";
    *state.databases.lock().unwrap() = vec![
        loaded_scoped("a.dbc", plain, &[TEST_BUS]),
        loaded_scoped("b.dbc", MUX_SNAPSHOT_DBC, &[TEST_BUS]),
    ];
    invalidate_derived_caches(&state);
    state.trace_store.append(modes_frame(0, 1, 7, 9));
    assert_eq!(selectors_seen(&state), vec![1]);
}

#[test]
fn a_selector_the_winner_withholds_is_read_from_the_next_database() {
    // A measured exposure, pinned so a change to it has to be
    // deliberate. `a.dbc` defines 512's multiplexor and is ahead of
    // `b.dbc` on the bus, so `Mux` is a.dbc's signal — but its
    // selector sits in byte 7, and a three-byte frame does not carry
    // it. The extractor asks the next eligible database instead, and
    // the mux index ends up holding a selector a.dbc never produced.
    //
    // Under ADR 0054 a payload the winning definition cannot read a
    // value out of has no value, so this fall-through is wrong. Fixing
    // it changes what the per-signal latest-value view shows — the
    // same decision as the per-frame fall-through in the sampler — so
    // it is recorded rather than taken here.
    let state = test_state();
    *state.databases.lock().unwrap() = vec![
        loaded_scoped("a.dbc", &mux_at(56), &[TEST_BUS]),
        loaded_scoped("b.dbc", MUX_SNAPSHOT_DBC, &[TEST_BUS]),
    ];
    invalidate_derived_caches(&state);
    let short = RawTraceFrame {
        timestamp_ns: 0,
        payload: CanFramePayload::Classic(vec![1, 7, 0]),
        ..dummy_frame(0, 512)
    };
    state.trace_store.append(short);
    assert_eq!(
        selectors_seen(&state),
        vec![1],
        "b.dbc's byte-0 selector, from a database that does not define this Mux",
    );
}

/// Two databases that both define `256/"Msg"` and its signal `A`, and
/// differ in every answer that hangs off it: `a.dbc` reads `A` at unit
/// scale, names no labels and designates no calculated fields; `b.dbc`
/// reads it x10, carries a `VAL_` table for it, designates a counter
/// and a CRC, and adds a signal `Y` that `a.dbc` has never heard of.
/// So whichever database resolves the collision is visible in the
/// decoded row, in the plotted samples, in the value table and in the
/// calculated-field default alike.
fn collide_a() -> String {
    format!(
        "{}\x20SG_ Ctr : 40|4@1+ (1,0) [0|15] \"\" ECU\n\
         \x20SG_ Crc8 : 56|8@1+ (1,0) [0|255] \"\" ECU\n",
        tiny_dbc_named(256, "Msg", "A : 0|16@1+ (1,0) [0|0] \"\" ECU"),
    )
}

fn collide_b() -> String {
    format!(
        "{}\x20SG_ Ctr : 40|4@1+ (1,0) [0|15] \"\" ECU\n\
         \x20SG_ Crc8 : 56|8@1+ (1,0) [0|255] \"\" ECU\n\
         \x20SG_ Y : 16|16@1+ (1,0) [0|0] \"\" ECU\n\
         VAL_ 256 A 0 \"Zero\" 3 \"Three\" ;\n\
         BA_DEF_ SG_ \"CannetCounter\" STRING ;\n\
         BA_DEF_ SG_ \"CannetCrc\" STRING ;\n\
         BA_DEF_DEF_ \"CannetCounter\" \"\";\n\
         BA_DEF_DEF_ \"CannetCrc\" \"\";\n\
         BA_ \"CannetCounter\" SG_ 256 Ctr \"increment=1;rollover=15\";\n\
         BA_ \"CannetCrc\" SG_ 256 Crc8 \"alg=CRC-8/SAE-J1850;range=0:56\";\n",
        tiny_dbc_named(256, "Msg", "A : 0|16@1+ (10,0) [0|0] \"\" ECU"),
    )
}

/// A one-message DBC header plus one `SG_` line spelled out in full,
/// for the fixtures that need the signal's placement and scaling to
/// differ between two databases.
fn tiny_dbc_named(id: u32, name: &str, sig_line: &str) -> String {
    format!(
        "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\n\
         BO_ {id} {name}: 8 ECU\n SG_ {sig_line}\n"
    )
}

/// A frame of the collision fixture's message: `A` raw 3, `Y` raw 100.
fn collide_frame() -> RawTraceFrame {
    RawTraceFrame {
        payload: CanFramePayload::Classic(vec![3, 0, 100, 0, 0, 0, 0, 0]),
        ..dummy_frame(0, 256)
    }
}

/// The collision fixture as live host state: the two databases in the
/// given load order, both assigned to [`TEST_BUS`], one frame in the
/// store, and `pick` (if any) recorded as the per-signal choice for
/// `A`.
fn collide_state(order: [&str; 2], pick: Option<&str>) -> AppState {
    let (a, b) = (collide_a(), collide_b());
    let state = test_state();
    *state.databases.lock().unwrap() = order
        .iter()
        .map(|p| {
            let text = if *p == "a.dbc" { &a } else { &b };
            loaded_scoped(p, text, &[TEST_BUS])
        })
        .collect();
    if let Some(p) = pick {
        let mut picks = crate::signal_fingerprint::SignalDbcPicks::new();
        picks.insert(
            crate::signal_snapshot::signal_identity(Some(TEST_BUS), 256, false, "A", false),
            p.to_owned(),
        );
        *state.signal_dbc_picks.lock().unwrap() = std::sync::Arc::new(picks);
    }
    state.trace_store.append(collide_frame());
    state
}

/// One signal's value in the chronological trace's decoded row — the
/// whole serve path, not just the decode helper.
fn row_value_of(state: &AppState, signal: &str) -> Option<f64> {
    collect_trace_records(state, 0, 1)[0]
        .decoded
        .as_ref()?
        .signals
        .iter()
        .find(|s| s.name == signal)
        .map(|s| s.value)
}

/// One signal's plotted samples — the per-signal cache, which is the
/// resolution rule's reference implementation.
fn plot_values_of(state: &AppState, signal: &str) -> Vec<f64> {
    let dbs = state.databases();
    let model = state.decode_model(&dbs);
    state
        .signal_caches
        .slice(
            Some(TEST_BUS),
            256,
            false,
            signal,
            f64::MIN,
            f64::MAX,
            0,
            &state.trace_store,
            &model,
        )
        .iter()
        .map(|p| p.value)
        .collect()
}

#[test]
#[allow(clippy::float_cmp)]
fn a_collision_resolves_to_one_database_in_the_row_the_plot_the_tables_and_the_calc_fields() {
    // Both databases define `256/A`; load order settles it. Every view
    // that answers a question about that value has to name the *same*
    // definition, because there is only one (ADR 0054) — so all four
    // channels move together when the order is reversed, and none of
    // them borrows from the database that lost.
    let labels = |state: &AppState| -> Vec<String> {
        list_value_tables_inner(state, 256, false, "A", false, Some(TEST_BUS))
            .into_iter()
            .map(|e| e.label)
            .collect()
    };
    let calc_designated = |state: &AppState| -> bool {
        let dbs = state.databases();
        resolve_effective_calc(
            &state.decode_model(&dbs),
            &calc_request(TEST_BUS, 256),
            None,
        )
        .unwrap()
        .is_some()
    };

    // a.dbc first: unit scale, no labels, no designations.
    let state = collide_state(["a.dbc", "b.dbc"], None);
    assert_eq!(row_value_of(&state, "A"), Some(3.0), "the row");
    assert_eq!(plot_values_of(&state, "A"), vec![3.0], "the plot");
    assert!(labels(&state).is_empty(), "the value table");
    assert!(!calc_designated(&state), "the calculated fields");

    // Reversed: x10, labelled, designated. The same four answers, all
    // from the database that now supplies the definition.
    let state = collide_state(["b.dbc", "a.dbc"], None);
    assert_eq!(row_value_of(&state, "A"), Some(30.0), "the row");
    assert_eq!(plot_values_of(&state, "A"), vec![30.0], "the plot");
    assert_eq!(labels(&state), vec!["Zero", "Three"], "the value table");
    assert!(calc_designated(&state), "the calculated fields");
}

#[test]
#[allow(clippy::float_cmp)]
fn a_trace_rows_picked_signal_comes_from_the_database_the_pick_names() {
    // The trace row decoded per *message* while the plot resolves per
    // *signal*, so the two could disagree about one value: a pick moved
    // the samples and left the row reading the other database's
    // definition. One value, one definition (ADR 0054) — the pick has
    // to move both.
    let state = collide_state(["a.dbc", "b.dbc"], Some("b.dbc"));
    assert_eq!(row_value_of(&state, "A"), Some(30.0));
    assert_eq!(plot_values_of(&state, "A"), vec![30.0]);
    // The label travels with the definition too: `A`'s decoded value
    // now carries b.dbc's `VAL_` entry, which a.dbc never declared.
    assert_eq!(
        collect_trace_records(&state, 0, 1)[0]
            .decoded
            .as_ref()
            .unwrap()
            .signals
            .iter()
            .find(|s| s.name == "A")
            .unwrap()
            .label
            .as_deref(),
        Some("Three"),
    );

    // Reversed load order, pick reversed with it: the same
    // discrimination the other way round, so the reading above is a
    // choice being honoured rather than an order being followed.
    let state = collide_state(["b.dbc", "a.dbc"], Some("a.dbc"));
    assert_eq!(row_value_of(&state, "A"), Some(3.0));
    assert_eq!(plot_values_of(&state, "A"), vec![3.0]);

    // A pick naming the database load order already chose changes
    // nothing.
    let state = collide_state(["a.dbc", "b.dbc"], Some("a.dbc"));
    assert_eq!(row_value_of(&state, "A"), Some(3.0));
    assert_eq!(plot_values_of(&state, "A"), vec![3.0]);
}

#[test]
#[allow(clippy::float_cmp)]
fn a_signal_only_a_later_database_defines_reaches_the_row_whether_or_not_anything_is_picked() {
    // `Y` is b.dbc's alone, so it has exactly one definition whatever
    // the load order and whatever anyone picked. The row reported it
    // only when the message carried a pick, which made *whether a
    // signal appears* depend on a choice made about a different signal
    // — a second resolution rule wearing a fast path's clothes. Two
    // databases define 256, so the message resolves per signal, and it
    // is the same answer the plot has always given.
    let unpicked = collide_state(["a.dbc", "b.dbc"], None);
    assert_eq!(row_value_of(&unpicked, "Y"), Some(100.0), "the row");
    assert_eq!(plot_values_of(&unpicked, "Y"), vec![100.0], "the plot");

    let picked = collide_state(["a.dbc", "b.dbc"], Some("b.dbc"));
    assert_eq!(row_value_of(&picked, "Y"), Some(100.0));
    assert_eq!(plot_values_of(&picked, "Y"), vec![100.0]);

    // Reversed, `Y` is the *first* database's and the row reported it
    // all along — the control that says the reading above is the
    // resolution rule and not the order.
    let reversed = collide_state(["b.dbc", "a.dbc"], None);
    assert_eq!(row_value_of(&reversed, "Y"), Some(100.0));
}

#[test]
fn a_pick_reaches_the_value_tables_and_the_calculated_fields() {
    // A pick names the file that describes this traffic, so everything
    // derived from the message follows it, not just the decoded number:
    // b.dbc's `VAL_` labels and its `CannetCounter` / `CannetCrc`
    // designation reach a project that chose b.dbc.
    let labels = |state: &AppState| -> Vec<String> {
        list_value_tables_inner(state, 256, false, "A", false, Some(TEST_BUS))
            .into_iter()
            .map(|e| e.label)
            .collect()
    };
    let calc_designated = |state: &AppState| -> bool {
        let dbs = state.databases();
        resolve_effective_calc(
            &state.decode_model(&dbs),
            &calc_request(TEST_BUS, 256),
            None,
        )
        .unwrap()
        .is_some()
    };

    let state = collide_state(["a.dbc", "b.dbc"], Some("b.dbc"));
    assert_eq!(labels(&state), vec!["Zero", "Three"], "the value table");
    assert!(calc_designated(&state), "the calculated fields");

    // Reversed load order with the pick reversed to match: b.dbc now
    // wins on order and a.dbc is chosen, so both answers go away again.
    // The reading above is a choice being honoured, not an order.
    let state = collide_state(["b.dbc", "a.dbc"], Some("a.dbc"));
    assert!(labels(&state).is_empty(), "the value table");
    assert!(!calc_designated(&state), "the calculated fields");
}

#[test]
#[allow(clippy::float_cmp)]
fn the_transmit_panels_message_queries_follow_the_pick() {
    // Describe, decode and encode all asked "first assigned database
    // that answers" for themselves. They now resolve through the same
    // message_source, so the panel cannot describe a row out of one
    // file while encoding it against another — and a pick moves all
    // three together.
    let described = |state: &AppState| -> (usize, bool) {
        let d = crate::dbc_commands::describe_message_inner(state, Some(TEST_BUS), 256, false)
            .expect("256 is defined on this bus");
        (d.signals.len(), d.calc_fields.is_some())
    };
    let decoded = |state: &AppState| -> f64 {
        crate::dbc_commands::decode_frame_inner(
            state,
            Some(TEST_BUS),
            256,
            false,
            &[3, 0, 100, 0, 0, 0, 0, 0],
        )
        .expect("256 decodes")
        .signals
        .iter()
        .find(|s| s.name == "A")
        .expect("A is decoded")
        .value
    };
    let encoded = |state: &AppState| -> u8 {
        crate::dbc_commands::encode_frame_inner(
            state,
            Some(TEST_BUS),
            256,
            false,
            &[ipc::EncodeFrameSignal {
                name: "A".into(),
                physical: 30.0,
            }],
            vec![0u8; 8],
        )
        .expect("256 encodes")
        .bytes[0]
    };

    // a.dbc supplies the message: three signals, no designation, unit
    // scale both ways.
    let state = collide_state(["a.dbc", "b.dbc"], None);
    assert_eq!(described(&state), (3, false));
    assert_eq!(decoded(&state), 3.0);
    assert_eq!(encoded(&state), 30);

    // Pinned to b.dbc: four signals, a designation, and x10 both ways.
    let state = collide_state(["a.dbc", "b.dbc"], Some("b.dbc"));
    assert_eq!(described(&state), (4, true));
    assert_eq!(decoded(&state), 30.0);
    assert_eq!(encoded(&state), 3);

    // Reversed load order with the pick reversed to match: the same
    // discrimination the other way round.
    let state = collide_state(["b.dbc", "a.dbc"], Some("a.dbc"));
    assert_eq!(described(&state), (3, false));
    assert_eq!(decoded(&state), 3.0);
    assert_eq!(encoded(&state), 30);
}

#[test]
fn a_designation_the_defining_database_never_declared_is_not_borrowed() {
    // The ingest verifier's *default* config index used to enumerate
    // only the messages that declare calculated fields, so a database
    // behind the winner could designate a counter on a message it does
    // not supply. a.dbc defines 256 and designates nothing; b.dbc,
    // behind it, designates both a counter and a CRC — and the value
    // being verified decodes from a.dbc, so there is nothing to verify
    // (ADR 0054).
    let configured = |order: [&str; 2]| -> bool {
        let state = collide_state(order, None);
        crate::app_state::rebuild_verification(&state);
        state.verifier.wants(&collide_frame())
    };
    assert!(!configured(["a.dbc", "b.dbc"]), "a.dbc supplies 256");
    // Reversed, b.dbc supplies the message and its designation applies
    // — which is what makes the clean reading above a discrimination.
    assert!(configured(["b.dbc", "a.dbc"]), "b.dbc supplies 256");
}

#[test]
#[allow(clippy::float_cmp)]
fn a_snapshot_rows_picked_signal_comes_from_the_database_the_pick_names() {
    // The per-signal latest-value view decodes per message too, so the
    // pick has to reach it for the same reason: its cell and the
    // plotted series are the same value.
    let latest = |state: &AppState| -> Option<f64> {
        let sel = SignalSelection {
            keys: vec![],
            patterns: vec![format!("^{TEST_BUS}/ECU/Msg/A$")],
        };
        fetch_signal_page_inner(state, &sel, None, 0, 1, None, None, vec![], None, 0, 100)
            .expect("valid pattern")
            .rows
            .iter()
            .filter_map(ipc::SignalPageRow::signal)
            .find(|r| r.signal_name == "A")?
            .value
    };
    assert_eq!(latest(&collide_state(["a.dbc", "b.dbc"], None)), Some(3.0));
    assert_eq!(
        latest(&collide_state(["a.dbc", "b.dbc"], Some("b.dbc"))),
        Some(30.0),
    );
    assert_eq!(
        latest(&collide_state(["b.dbc", "a.dbc"], Some("a.dbc"))),
        Some(3.0),
    );
}

#[test]
fn a_signal_the_picked_database_withholds_has_no_value_in_the_row() {
    // The pick names the definition, and a definition that produces no
    // value for this payload leaves the row with none — rather than
    // falling through to the database behind it, which would put a
    // value under a definition that never produced it.
    let plain = tiny_dbc_named(256, "Msg", "A : 0|16@1+ (1,0) [0|0] \"\" ECU");
    // Same message and same signal name, but only in multiplexor arm 1;
    // the frame below selects arm 0, so this database withholds `A`.
    let muxed = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\n\
         BO_ 256 Msg: 8 ECU\n\
         \x20SG_ Sel M : 32|8@1+ (1,0) [0|255] \"\" ECU\n\
         \x20SG_ A m1 : 0|16@1+ (10,0) [0|0] \"\" ECU\n";
    let state = test_state();
    *state.databases.lock().unwrap() = vec![
        loaded_scoped("a.dbc", &plain, &[TEST_BUS]),
        loaded_scoped("b.dbc", muxed, &[TEST_BUS]),
    ];
    let mut picks = crate::signal_fingerprint::SignalDbcPicks::new();
    picks.insert(
        crate::signal_snapshot::signal_identity(Some(TEST_BUS), 256, false, "A", false),
        "b.dbc".to_owned(),
    );
    *state.signal_dbc_picks.lock().unwrap() = std::sync::Arc::new(picks);
    // Selector byte (bit 32) is 0, so b.dbc's arm-1 `A` is not in this
    // frame.
    state.trace_store.append(RawTraceFrame {
        payload: CanFramePayload::Classic(vec![3, 0, 0, 0, 0, 0, 0, 0]),
        ..dummy_frame(0, 256)
    });
    assert_eq!(row_value_of(&state, "A"), None);
}
