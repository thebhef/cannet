//! Date patterns: the one subset of TR35 (Unicode LDML date format
//! patterns) the application speaks wherever a user writes a calendar
//! time format — `yyyy-MM-dd HH:mm:ss` (ADR 0062).
//!
//! The subset is implemented twice: here, for file names (the
//! `{start:…}` / `{now:…}` template tokens, [`crate::export_template`]),
//! and in the frontend's `datePattern.ts`, for display. One vector file,
//! `apps/gui/src/datePattern.vectors.json`, is read by both test suites,
//! so the two cannot drift — the error messages included.
//!
//! | field | tokens |
//! |---|---|
//! | year | `yyyy`, `yy` |
//! | month | `M`, `MM`, `MMM` (Jan), `MMMM` (January) |
//! | day | `d`, `dd`; `EEE` (Mon), `EEEE` (Monday) |
//! | hour | `H`, `HH` (0–23); `h`, `hh` (1–12), `a` (AM/PM) |
//! | minute / second | `mm`, `ss` |
//! | fraction | `S` … `SSSSSSSSS` (1–9 digits, truncated) |
//! | offset | `xx` (`-0700`), `xxx` (`-07:00`), `X` / `XX` / `XXX` (`Z` at UTC) |
//!
//! Letters are reserved as TR35 reserves them: an ASCII letter outside
//! the subset is an error, never a literal. Literal text is quoted
//! (`'T'`); `''` is an apostrophe, inside quotes or out. Names are
//! English (the TR35 root locale). The zone name `zzz` is display-only —
//! the host has no zone-name table — so it is refused here with that
//! reason.

use chrono::{DateTime, Datelike, FixedOffset, TimeZone, Timelike};

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// Monday first, matching [`chrono::Weekday::num_days_from_monday`].
const WEEKDAYS: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];

const UNTERMINATED_QUOTE: &str =
    "unterminated quote — close it with ', or write '' for an apostrophe";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    Year4,
    Year2,
    /// `M`…`MMMM`: the run length.
    Month(usize),
    /// `d` / `dd`.
    Day(usize),
    /// `EEE` / `EEEE`.
    Weekday(usize),
    /// `H` / `HH`.
    Hour24(usize),
    /// `h` / `hh`.
    Hour12(usize),
    AmPm,
    Minute,
    Second,
    /// `S`…`SSSSSSSSS`: digits of the fraction, truncated.
    Fraction(usize),
    /// `xx` (`-0700`) / `xxx` (`-07:00`): never `Z`.
    OffsetX(usize),
    /// `X` / `XX` / `XXX`: as `x`, but `Z` at UTC, and `X` drops zero
    /// minutes (`-07`).
    OffsetIsoX(usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Item {
    Literal(String),
    Field(Field),
}

/// A parsed date pattern, ready to format any number of instants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DatePattern {
    items: Vec<Item>,
}

/// The widths a pattern letter accepts, as the error message lists
/// them — `None` for a letter outside the subset.
fn width_hint(letter: char) -> Option<&'static str> {
    Some(match letter {
        'y' => "yy or yyyy",
        'M' => "M, MM, MMM or MMMM",
        'd' => "d or dd",
        'E' => "EEE or EEEE",
        'H' => "H or HH",
        'h' => "h or hh",
        'a' => "a",
        'm' => "mm",
        's' => "ss",
        'S' => "S to SSSSSSSSS",
        'x' => "xx or xxx",
        'X' => "X, XX or XXX",
        'z' => "zzz",
        _ => return None,
    })
}

/// `letter` repeated `width` times as a field, or `None` when that width
/// is not in the subset. `zzz` is not a [`Field`]: it parses (so its
/// width errors read like every other letter's) and is then refused.
fn field(letter: char, width: usize) -> Option<Field> {
    Some(match (letter, width) {
        ('y', 4) => Field::Year4,
        ('y', 2) => Field::Year2,
        ('M', 1..=4) => Field::Month(width),
        ('d', 1..=2) => Field::Day(width),
        ('E', 3..=4) => Field::Weekday(width),
        ('H', 1..=2) => Field::Hour24(width),
        ('h', 1..=2) => Field::Hour12(width),
        ('a', 1) => Field::AmPm,
        ('m', 2) => Field::Minute,
        ('s', 2) => Field::Second,
        ('S', 1..=9) => Field::Fraction(width),
        ('x', 2..=3) => Field::OffsetX(width),
        ('X', 1..=3) => Field::OffsetIsoX(width),
        _ => return None,
    })
}

impl DatePattern {
    /// Parse `pattern`, or say what is wrong with it. The first problem,
    /// reading left to right, is the one reported.
    pub(crate) fn parse(pattern: &str) -> Result<Self, String> {
        if pattern.is_empty() {
            return Err("a date pattern must not be empty".to_string());
        }
        let chars: Vec<char> = pattern.chars().collect();
        let mut items = Vec::new();
        let mut literal = String::new();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '\'' {
                if chars.get(i + 1) == Some(&'\'') {
                    literal.push('\'');
                    i += 2;
                    continue;
                }
                // A quoted run: up to the closing quote, `''` inside it
                // being an apostrophe.
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err(UNTERMINATED_QUOTE.to_string()),
                        Some('\'') if chars.get(i + 1) == Some(&'\'') => {
                            literal.push('\'');
                            i += 2;
                        }
                        Some('\'') => {
                            i += 1;
                            break;
                        }
                        Some(&ch) => {
                            literal.push(ch);
                            i += 1;
                        }
                    }
                }
            } else if c.is_ascii_alphabetic() {
                let width = chars[i..].iter().take_while(|&&ch| ch == c).count();
                let run: String = chars[i..i + width].iter().collect();
                let Some(hint) = width_hint(c) else {
                    return Err(format!(
                        "\"{c}\" is not a date pattern field — letters are reserved; \
                         quote literal text, e.g. 'T'"
                    ));
                };
                if c == 'z' && width == 3 {
                    return Err(format!(
                        "\"{run}\" (a zone name) cannot be used in a file name — \
                         the host has no zone-name table; use xxx for the offset"
                    ));
                }
                let Some(f) = field(c, width) else {
                    return Err(format!("\"{run}\" is not a supported width — use {hint}"));
                };
                if !literal.is_empty() {
                    items.push(Item::Literal(std::mem::take(&mut literal)));
                }
                items.push(Item::Field(f));
                i += width;
            } else {
                literal.push(c);
                i += 1;
            }
        }
        if !literal.is_empty() {
            items.push(Item::Literal(literal));
        }
        Ok(Self { items })
    }

    /// `dt` rendered per this pattern, in `dt`'s own offset.
    pub(crate) fn format<Tz: TimeZone>(&self, dt: &DateTime<Tz>) -> String {
        let dt = dt.fixed_offset();
        let mut out = String::new();
        for item in &self.items {
            match item {
                Item::Literal(text) => out.push_str(text),
                Item::Field(f) => push_field(&mut out, *f, &dt),
            }
        }
        out
    }
}

fn push_field(out: &mut String, f: Field, dt: &DateTime<FixedOffset>) {
    use std::fmt::Write;
    let month0 = dt.month0() as usize;
    let weekday = dt.weekday().num_days_from_monday() as usize;
    // `write!` into a `String` cannot fail.
    let _ = match f {
        Field::Year4 => write!(out, "{:04}", dt.year()),
        Field::Year2 => write!(out, "{:02}", dt.year().rem_euclid(100)),
        Field::Month(1) => write!(out, "{}", dt.month()),
        Field::Month(2) => write!(out, "{:02}", dt.month()),
        Field::Month(3) => write!(out, "{}", &MONTHS[month0][..3]),
        Field::Month(_) => write!(out, "{}", MONTHS[month0]),
        Field::Day(1) => write!(out, "{}", dt.day()),
        Field::Day(_) => write!(out, "{:02}", dt.day()),
        Field::Weekday(3) => write!(out, "{}", &WEEKDAYS[weekday][..3]),
        Field::Weekday(_) => write!(out, "{}", WEEKDAYS[weekday]),
        Field::Hour24(1) => write!(out, "{}", dt.hour()),
        Field::Hour24(_) => write!(out, "{:02}", dt.hour()),
        Field::Hour12(width) => {
            let h = match dt.hour() % 12 {
                0 => 12,
                h => h,
            };
            if width == 1 {
                write!(out, "{h}")
            } else {
                write!(out, "{h:02}")
            }
        }
        Field::AmPm => write!(out, "{}", if dt.hour() < 12 { "AM" } else { "PM" }),
        Field::Minute => write!(out, "{:02}", dt.minute()),
        Field::Second => write!(out, "{:02}", dt.second()),
        Field::Fraction(digits) => {
            // A leap second's nanosecond field runs past 1e9; clamp it
            // into the second it belongs to rather than print ten digits.
            let nanos = format!("{:09}", dt.nanosecond().min(999_999_999));
            write!(out, "{}", &nanos[..digits])
        }
        Field::OffsetX(width) => write!(out, "{}", offset(dt, width == 3, true)),
        Field::OffsetIsoX(width) => {
            if dt.offset().local_minus_utc() / 60 == 0 {
                write!(out, "Z")
            } else {
                write!(out, "{}", offset(dt, width == 3, width > 1))
            }
        }
    };
}

/// `±HH`, then the minutes — `:MM` when `colon`, `MM` otherwise —
/// unless `always_minutes` is false and they are zero. Seconds of
/// offset, which no real zone has had since 1972, are dropped.
fn offset(dt: &DateTime<FixedOffset>, colon: bool, always_minutes: bool) -> String {
    let total = dt.offset().local_minus_utc() / 60;
    let sign = if total < 0 { '-' } else { '+' };
    let (h, m) = (total.abs() / 60, total.abs() % 60);
    if !always_minutes && m == 0 {
        format!("{sign}{h:02}")
    } else if colon {
        format!("{sign}{h:02}:{m:02}")
    } else {
        format!("{sign}{h:02}{m:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    /// The vector file both implementations are held to.
    const VECTORS: &str = include_str!("../../src/datePattern.vectors.json");

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        format: Vec<FormatCase>,
        errors: Vec<ErrorCase>,
        display_only: Vec<FormatCase>,
        file_name_error: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FormatCase {
        pattern: String,
        seconds: i64,
        nanos: u32,
        offset_minutes: i32,
        expected: String,
    }

    #[derive(serde::Deserialize)]
    struct ErrorCase {
        pattern: String,
        error: String,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(VECTORS).expect("the vector file parses")
    }

    fn instant(case: &FormatCase) -> DateTime<FixedOffset> {
        let offset = FixedOffset::east_opt(case.offset_minutes * 60).expect("valid offset");
        Utc.timestamp_opt(case.seconds, case.nanos)
            .single()
            .expect("valid instant")
            .with_timezone(&offset)
    }

    #[test]
    fn every_format_vector_renders_as_expected() {
        let v = vectors();
        assert!(!v.format.is_empty());
        for case in &v.format {
            let pattern = DatePattern::parse(&case.pattern)
                .unwrap_or_else(|e| panic!("{:?} failed to parse: {e}", case.pattern));
            assert_eq!(
                pattern.format(&instant(case)),
                case.expected,
                "pattern {:?}",
                case.pattern
            );
        }
    }

    #[test]
    fn every_error_vector_is_refused_with_its_message() {
        for case in vectors().errors {
            assert_eq!(
                DatePattern::parse(&case.pattern),
                Err(case.error.clone()),
                "pattern {:?}",
                case.pattern
            );
        }
    }

    #[test]
    fn a_zone_name_is_refused_in_a_file_name_with_the_reason() {
        let v = vectors();
        assert!(!v.display_only.is_empty());
        for case in &v.display_only {
            assert_eq!(
                DatePattern::parse(&case.pattern),
                Err(v.file_name_error.clone()),
                "pattern {:?}",
                case.pattern
            );
        }
    }

    #[test]
    fn every_subset_letter_appears_in_the_vectors() {
        // A token missing from the shared file is a token the two
        // implementations are not proven to agree on.
        let v = vectors();
        let all: String = v
            .format
            .iter()
            .map(|c| c.pattern.as_str())
            .chain(v.display_only.iter().map(|c| c.pattern.as_str()))
            .collect();
        for letter in "yMdEHhamsSxXz".chars() {
            assert!(all.contains(letter), "no vector exercises {letter:?}");
        }
    }
}
