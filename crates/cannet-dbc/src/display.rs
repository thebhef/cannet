//! The `CannetDisplay` per-signal DBC attribute — how a signal's value
//! should be *rendered*, as opposed to what it means.
//!
//! One key is defined: `radix=hex`, which asks for a raw integer bit
//! field to render as a bit pattern rather than base 10. The attribute
//! is read-only, like every other `Cannet*` attribute — cannet never
//! writes a DBC. See ADR 0043.

use crate::calc::key_value_pairs;

/// The display mode a signal's `CannetDisplay` attribute asks for.
/// A slot, not a radix flag: further simple display modes get a key
/// here rather than each earning its own attribute.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DisplayConfig {
    /// `radix=hex` — render the value as a bit pattern.
    pub(crate) hex: bool,
}

/// Parse a `CannetDisplay` attribute value — the same `key=value;`
/// one-liner grammar as `CannetCounter` / `CannetCrc`. An unknown key
/// or an unknown value for a known key is an error, so a typo doesn't
/// silently render the wrong thing and a DBC written for a later
/// cannet stays readable by an earlier one (the caller warns and falls
/// back to the default rendering).
pub(crate) fn parse_display_attribute(text: &str) -> Result<DisplayConfig, String> {
    let mut config = DisplayConfig::default();
    for (key, value) in key_value_pairs(text)? {
        match key {
            "radix" => match value {
                "hex" => config.hex = true,
                other => return Err(format!("unknown radix \"{other}\" (expected hex)")),
            },
            other => return Err(format!("unknown CannetDisplay key \"{other}\"")),
        }
    }
    Ok(config)
}
