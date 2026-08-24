//! The `examples/ev-zonal` fixture is the deliberately-large DBC set
//! the DBC view's scaling work is measured against. These tests pin
//! the properties the fixture promises: both files parse cleanly and
//! carry the advertised scale (150+ messages each, one message with
//! 500+ multiplexed signals).

use std::path::Path;

use cannet_dbc::{Database, SignalMux};

fn load(name: &str) -> Database {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/ev-zonal/dbc")
        .join(name);
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let db = Database::parse(&text).expect("fixture must parse");
    assert!(
        db.parse_warnings().is_empty(),
        "{name} parse warnings: {:?}",
        db.parse_warnings()
    );
    db
}

#[test]
fn pack_dbc_parses_at_the_promised_scale() {
    let db = load("pack.dbc");
    let content = db.dbc_content();
    assert!(
        content.len() >= 150,
        "pack.dbc has {} messages, promised 150+",
        content.len()
    );

    // The mux stress case: per-cell voltage / temp / balance for a
    // 200-cell pack behind one selector — 600 multiplexed signals.
    let cell_detail = content
        .iter()
        .find(|m| m.name == "BmsCellDetail")
        .expect("BmsCellDetail present");
    assert!(cell_detail.is_fd, "64-byte payload must classify as FD");
    let muxed = cell_detail
        .signals
        .iter()
        .filter(|s| matches!(s.mux, SignalMux::Multiplexed { .. }))
        .count();
    assert!(
        muxed >= 500,
        "BmsCellDetail has {muxed} multiplexed signals, promised 500+"
    );
    assert!(cell_detail
        .signals
        .iter()
        .any(|s| matches!(s.mux, SignalMux::Multiplexor)));
}

#[test]
fn zonal_dbc_parses_at_the_promised_scale() {
    let db = load("zonal.dbc");
    let content = db.dbc_content();
    assert!(
        content.len() >= 150,
        "zonal.dbc has {} messages, promised 150+",
        content.len()
    );

    // Value tables and comments exist for search-ranking realism.
    assert!(content
        .iter()
        .any(|m| m.signals.iter().any(|s| !s.value_table.is_empty())));
    assert!(content.iter().any(|m| !m.comment.is_empty()));
}

/// The fixture carries a worked example of cannet's own DBC
/// attributes: `PackStateCommand` is E2E-protected (ADR 0027) and its
/// CRC asks to be read as a bit pattern (ADR 0043). `load` already
/// asserts the file parses warning-free, which is what proves
/// `radix=hex` landed on a signal that can take it.
#[test]
fn zonal_dbc_carries_the_cannet_attribute_example() {
    let db = load("zonal.dbc");
    let id = cannet_core::CanId::standard(0x60A).unwrap();
    let calc = db
        .dbc_calculated_fields(id)
        .expect("PackStateCommand present");
    assert_eq!(calc.counter.as_ref().expect("counter").signal, "AliveCtr");
    assert_eq!(calc.crc.as_ref().expect("crc").signal, "Crc8");
    db.resolve_calculated_fields(id, calc)
        .expect("the designation resolves against the message layout");

    let sigs = db.signals();
    let sig = |name: &str| {
        sigs.iter()
            .find(|s| s.message_name == "PackStateCommand" && s.signal_name == name)
            .unwrap_or_else(|| panic!("PackStateCommand.{name}"))
    };
    assert!(sig("Crc8").display_hex, "CannetDisplay radix=hex");
    assert!(
        !sig("AliveCtr").display_hex,
        "a rollover counter reads as a number"
    );
}

/// The fixture's long-name case. `CentralComputeThermalDerateAdvis` on
/// the `BO_` line is the 32-character truncation the classic format
/// allows; the real name is 44 characters and arrives through
/// `SystemMessageLongSymbol`. Three of its signals are the same shape,
/// two are ordinary short names — the control that makes a resolved
/// name a discrimination rather than an absence — and one carries
/// `VAL_` labels far past any identifier limit.
#[test]
fn zonal_dbc_carries_the_long_name_example() {
    let db = load("zonal.dbc");
    let content = db.dbc_content();
    let msg = content
        .iter()
        .find(|m| m.name == "CentralComputeThermalDerateAdvisoryBroadcast")
        .expect("the long message name resolves");
    assert!(
        !content
            .iter()
            .any(|m| m.name == "CentralComputeThermalDerateAdvis"),
        "the truncated identifier must not survive as a name"
    );

    let names: Vec<&str> = msg.signals.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"HighVoltageBatteryPackCoolantInletTemperature"));
    assert!(names.contains(&"ThermalDerateRequestingSubsystemIdentifier"));
    assert!(names.contains(&"PropulsionInverterThermalDerateRequestLevel"));
    // The controls: short names in the same message, untouched.
    assert!(names.contains(&"DerateActive"));
    assert!(names.contains(&"AdvisoryCounter"));

    // The value table survives the rename, and carries a label longer
    // than any DBC identifier may be.
    let source = msg
        .signals
        .iter()
        .find(|s| s.name == "ThermalDerateRequestingSubsystemIdentifier")
        .expect("the enum signal");
    assert!(source
        .value_table
        .iter()
        .any(|e| e.label == "TractionInverterStatorWindingOverTemperature"));
    assert!(
        source.value_table.iter().any(|e| e.label == "Fault"),
        "a short label beside the long ones"
    );

    // The long-symbol placeholders are an implementation detail, not
    // metadata the DBC panel should show.
    assert!(!msg.attributes.iter().any(|a| a.name.contains("LongSymbol")));
    assert!(!msg
        .signals
        .iter()
        .any(|s| s.attributes.iter().any(|a| a.name.contains("LongSymbol"))));
}
