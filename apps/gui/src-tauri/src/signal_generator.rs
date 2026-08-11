//! Signal **generator** rules: an ordered list of partial-match regexes
//! over a signal's display name whose first capture group, parsed as an
//! integer, is that signal's color-wheel index (ADR 0026's one wheel).
//! `Cell(\d+)` gives `Cell1…Cell16` stable, meaningful slots wherever
//! they appear, instead of the hash's arbitrary ones.
//!
//! Rules compile and evaluate **here**, never in the frontend. The
//! patterns are user input, so they run on the Rust `regex` crate —
//! linear time, no backtracking — under an explicit pattern-length cap
//! and a compiled-program [`SIZE_LIMIT`]. The editor calls
//! [`validate_signal_generator`] as a rule is entered, so a compile
//! error is reported at entry time rather than silently at match time;
//! the views call [`evaluate_signal_generators`] once per rule/catalog
//! change and cache the answer.

use regex::{Regex, RegexBuilder};

/// Longest accepted pattern. Generator patterns name signal families
/// (`Cell(\d+)`); anything approaching this is not one, and the cap
/// bounds compile work before the regex crate sees the input.
const MAX_PATTERN_LEN: usize = 512;

/// Compiled-program cap handed to [`RegexBuilder::size_limit`]. Well
/// above any real name pattern, well below the crate's 10 MiB default,
/// so a pathological bounded repetition is rejected at entry instead of
/// costing memory on every evaluation.
const SIZE_LIMIT: usize = 64 * 1024;

/// Compile one generator pattern under the caps, or return the message
/// the editor shows next to the rule.
///
/// Matching is **case sensitive** — DBC signal names are, so `Cell(\d+)`
/// must not claim `cell5`. A user who wants otherwise writes the inline
/// flag: `(?i)Cell(\d+)`.
///
/// A pattern with no capture group can never derive an index, so it is
/// rejected here rather than silently matching everything and applying
/// to nothing.
pub(crate) fn compile(pattern: &str) -> Result<Regex, String> {
    if pattern.chars().count() > MAX_PATTERN_LEN {
        return Err(format!(
            "pattern is longer than {MAX_PATTERN_LEN} characters"
        ));
    }
    let re = RegexBuilder::new(pattern)
        .size_limit(SIZE_LIMIT)
        .build()
        .map_err(|e| e.to_string())?;
    if re.captures_len() < 2 {
        return Err(
            "pattern has no capture group — parenthesise the number, e.g. Cell(\\d+)".to_string(),
        );
    }
    Ok(re)
}

/// The wheel index `re` derives from `name`, or `None` when the rule
/// does not apply: no partial match, or a first capture that isn't a
/// non-negative integer.
fn index_for(re: &Regex, name: &str) -> Option<u32> {
    re.captures(name)?.get(1)?.as_str().parse::<u32>().ok()
}

/// Evaluate ordered `patterns` over `names`, returning one answer per
/// name in `names`' order: the first *applying* rule's wheel index, or
/// `None` when no rule claims the name.
///
/// A rule that matches but yields no usable capture does not apply, so
/// evaluation continues with the next rule. A rule that fails to
/// compile is skipped — one bad pattern in a project must not blank
/// out the rules around it, and the editor already reported it.
pub(crate) fn evaluate(patterns: &[String], names: &[String]) -> Vec<Option<u32>> {
    let compiled: Vec<Regex> = patterns.iter().filter_map(|p| compile(p).ok()).collect();
    names
        .iter()
        .map(|n| compiled.iter().find_map(|re| index_for(re, n)))
        .collect()
}

/// Entry-time validation for one generator rule: `Ok` when the pattern
/// compiles under the caps and can derive an index, otherwise the
/// error the editor shows inline. See [`compile`].
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn validate_signal_generator(pattern: String) -> Result<(), String> {
    compile(&pattern).map(|_| ())
}

/// Evaluate the project's ordered generator patterns over a list of
/// signal names, returning the wheel index for each name (`null` where
/// no rule applies), positionally. The caller holds the name↔signal-key
/// mapping; this command only answers the regex question. See
/// [`evaluate`].
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn evaluate_signal_generators(
    patterns: Vec<String>,
    names: Vec<String>,
) -> Vec<Option<u32>> {
    evaluate(&patterns, &names)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn a_well_formed_pattern_compiles() {
        assert!(compile(r"Cell(\d+)").is_ok());
    }

    #[test]
    fn an_unclosed_group_is_a_compile_error() {
        let err = compile(r"Cell(\d+").unwrap_err();
        assert!(err.contains("unclosed"), "unexpected message: {err}");
    }

    #[test]
    fn a_pattern_with_no_capture_group_is_rejected() {
        let err = compile(r"Cell\d+").unwrap_err();
        assert!(err.contains("capture group"), "unexpected message: {err}");
    }

    #[test]
    fn an_over_long_pattern_is_rejected() {
        let long = format!("({})", "a".repeat(MAX_PATTERN_LEN));
        let err = compile(&long).unwrap_err();
        assert!(err.contains("longer than"), "unexpected message: {err}");
    }

    #[test]
    fn a_pattern_over_the_size_limit_is_rejected() {
        // Accepted by the crate's 10 MiB default, so it is *our*
        // SIZE_LIMIT that turns it away.
        let pat = r"(a{1000}){20}";
        assert!(Regex::new(pat).is_ok());
        let err = compile(pat).unwrap_err();
        assert!(err.contains("size limit"), "unexpected message: {err}");
    }

    #[test]
    fn the_first_capture_is_the_wheel_index() {
        let out = evaluate(&strs(&[r"Cell(\d+)"]), &strs(&["Cell1", "Cell16"]));
        assert_eq!(out, vec![Some(1), Some(16)]);
    }

    #[test]
    fn the_match_is_partial_not_anchored() {
        let out = evaluate(&strs(&[r"Cell(\d+)"]), &strs(&["PackCell5Voltage"]));
        assert_eq!(out, vec![Some(5)]);
    }

    #[test]
    fn matching_is_case_sensitive_unless_the_pattern_says_otherwise() {
        assert_eq!(
            evaluate(&strs(&[r"Cell(\d+)"]), &strs(&["cell5"])),
            vec![None]
        );
        assert_eq!(
            evaluate(&strs(&[r"(?i)Cell(\d+)"]), &strs(&["cell5"])),
            vec![Some(5)]
        );
    }

    #[test]
    fn a_rule_whose_capture_is_not_a_number_does_not_apply() {
        // Rule 1 matches "CellTemp" but captures "Temp" — it doesn't
        // apply, so rule 2 gets its turn on the same name.
        let out = evaluate(
            &strs(&[r"Cell(\w+)", r"Temp(\d+)"]),
            &strs(&["CellTemp7", "CellTemp"]),
        );
        assert_eq!(out, vec![Some(7), None]);
    }

    #[test]
    fn the_first_applying_rule_wins() {
        // Both rules apply to "Cell37"; only their order decides which
        // digit becomes the slot.
        let names = strs(&["Cell37"]);
        assert_eq!(
            evaluate(&strs(&[r"Cell(\d)", r"Cell\d(\d)"]), &names),
            vec![Some(3)]
        );
        assert_eq!(
            evaluate(&strs(&[r"Cell\d(\d)", r"Cell(\d)"]), &names),
            vec![Some(7)]
        );
    }

    #[test]
    fn the_same_index_from_different_rules_is_the_same_slot() {
        let out = evaluate(
            &strs(&[r"Cell(\d+)Voltage", r"Cell(\d+)Temperature"]),
            &strs(&["Cell5Voltage", "Cell5Temperature"]),
        );
        assert_eq!(out, vec![Some(5), Some(5)]);
    }

    #[test]
    fn an_uncompilable_rule_is_skipped_rather_than_fatal() {
        let out = evaluate(&strs(&[r"Cell(\d+", r"Cell(\d+)"]), &strs(&["Cell4"]));
        assert_eq!(out, vec![Some(4)]);
    }

    #[test]
    fn evaluation_answers_every_catalog_name_in_order() {
        let out = evaluate(
            &strs(&[r"Cell(\d+)"]),
            &strs(&["Cell1", "EngineRpm", "Cell2", "", "Cell10"]),
        );
        assert_eq!(out, vec![Some(1), None, Some(2), None, Some(10)]);
    }
}
