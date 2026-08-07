//! `docs/cannet-attributes-reference.dbc` is the file the README
//! points people at for the `Cannet*` custom attributes (ADR 0043).
//! These tests pin what the reference promises: it parses
//! warning-free, and every attribute it declares resolves to its
//! designation — so the reference cannot drift from the parser.

use std::path::Path;

use cannet_core::CanId;
use cannet_dbc::{CounterConfig, CrcAlgorithm, CrcConfig, Database, RawCrcParams};

fn load() -> Database {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/cannet-attributes-reference.dbc");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let db = Database::parse(&text).expect("reference must parse");
    assert!(
        db.parse_warnings().is_empty(),
        "reference parse warnings: {:?}",
        db.parse_warnings()
    );
    db
}

#[test]
fn status_declares_counter_named_crc_and_hex_display() {
    let db = load();
    let config = db
        .dbc_calculated_fields(CanId::standard(256).unwrap())
        .expect("Status carries designations");
    assert_eq!(
        config.counter,
        Some(CounterConfig {
            signal: "AliveCtr".into(),
            increment: 1,
            rollover: Some(15),
        })
    );
    assert_eq!(
        config.crc,
        Some(CrcConfig {
            signal: "Crc8".into(),
            algorithm: CrcAlgorithm::Named("CRC-8/SAE-J1850".into()),
            range_bits: (0, 16),
            prefix: vec![0xA3],
        })
    );
    let hex: Vec<_> = db
        .signals()
        .into_iter()
        .filter(|s| s.display_hex)
        .map(|s| s.signal_name)
        .collect();
    assert_eq!(hex, ["StatusFlags"], "exactly one radix=hex signal");
}

#[test]
fn custom_crc_status_declares_the_raw_rocksoft_form() {
    let db = load();
    let config = db
        .dbc_calculated_fields(CanId::standard(257).unwrap())
        .expect("CustomCrcStatus carries a designation");
    assert_eq!(config.counter, None);
    assert_eq!(
        config.crc,
        Some(CrcConfig {
            signal: "CustomCrc16".into(),
            algorithm: CrcAlgorithm::Raw(RawCrcParams {
                width: 16,
                poly: 0x1021,
                init: 0xFFFF,
                refin: false,
                refout: false,
                xorout: 0x0000,
            }),
            range_bits: (0, 24),
            prefix: vec![],
        })
    );
}
