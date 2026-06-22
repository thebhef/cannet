//! The shipped `examples/ev-fleet` workload must parse against the real
//! production parsers and be internally consistent. These tests are the
//! regression guard on the hand-authored artifacts: a typo'd CAN id, a
//! renamed signal, or a schema bump that the example wasn't updated for
//! all fail here.

use cannet_perf_measurement::{default_example_dir, load_example, workload};

#[test]
fn example_parses_and_is_consistent() {
    let ex = load_example(&default_example_dir())
        .unwrap_or_else(|e| panic!("example failed to load: {e}"));

    // Two physically-bridged buses, one DBC per ECU group, all parsed.
    assert_eq!(ex.project.buses.len(), 2, "expected 2 buses");
    assert_eq!(ex.dbcs.len(), 4, "expected 4 DBCs");
    for loaded in &ex.dbcs {
        assert!(
            loaded.db.message_count() > 0,
            "{} has no messages",
            loaded.path.display()
        );
    }

    // Every RBS override resolves to a real DBC message + signal.
    ex.check_rbs_against_dbcs()
        .unwrap_or_else(|e| panic!("RBS / DBC mismatch:\n{e}"));
}

#[test]
fn schedule_is_periodic_and_realistic() {
    let ex = load_example(&default_example_dir()).expect("load example");
    let schedule = workload::build_schedule(&ex);

    // Every DBC message carries a cycle time, so all should be scheduled.
    let total_messages: usize = ex.dbcs.iter().map(|d| d.db.message_count()).sum();
    assert_eq!(
        schedule.len(),
        total_messages,
        "every cyclic DBC message should be scheduled once"
    );

    // Each scheduled message has a positive cadence and a non-empty,
    // correctly-sized payload.
    for m in &schedule {
        assert!(m.period_ms > 0, "0x{:X} has no cadence", m.can_id);
        assert!(!m.payload.is_empty(), "0x{:X} has empty payload", m.can_id);
    }

    // The EV model sums to a few hundred frames/s — a useful sustained
    // ingest workload, in the band the Task 21 diagnosis ran against.
    let rate = workload::aggregate_rate_hz(&schedule);
    assert!(
        (300.0..=600.0).contains(&rate),
        "aggregate rate {rate:.1}/s outside the expected 300-600 band"
    );
}

#[test]
fn extended_e2e_command_is_present() {
    let ex = load_example(&default_example_dir()).expect("load example");
    let schedule = workload::build_schedule(&ex);
    // The BMS contactor heartbeat is the extended-id, E2E-protected
    // (counter + CRC) message — exercise that the example carries one.
    assert!(
        schedule.iter().any(|m| m.extended),
        "expected at least one extended-id message in the schedule"
    );
}
