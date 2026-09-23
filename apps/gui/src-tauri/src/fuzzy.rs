//! Fuzzy ranking — the host's half of the app's one fzf dialect.
//!
//! The frontend's filter slot (ADR 0044) ranks client-held rows with
//! the `fzf` npm package; a host-paged view cannot do that, because
//! fuzzy-filtering it in JS would mean holding the whole row space in
//! frontend state. So the host ranks instead, and it has to rank *the
//! same way* — a trace filter that ordered its matches differently
//! from the DBC tree's would be a second dialect, not a second view.
//!
//! This module is therefore a port of the package's scoring, not an
//! equivalent of it: fzf's v2 algorithm with the same tables, the same
//! bonus rules, the same v1 fallback when the match matrix outgrows
//! the package's slab, and the same `casing: "case-insensitive"` path
//! the frontend passes. `fixtures/fzf-golden.json`, generated from the
//! package itself by `apps/gui/scripts/fzf-golden.mjs`, pins the two
//! together; the test at the bottom of this file is what fails when
//! the port drifts.
//!
//! ## The floor rule
//!
//! fzf accepts any subsequence, so over a large haystack list a query
//! also "matches" text where its letters merely appear scattered. The
//! app's rule — one rule, stated here and mirrored by the frontend's
//! `MIN_RELATIVE_SCORE` — is a **relative floor**: keep the prefix of
//! the score-descending list whose score is at least
//! [`MIN_RELATIVE_SCORE`] of the best match's, drop the rest.
//! [`above_floor`] is that cut.
//!
//! ## What is not ported
//!
//! The package's `normalize: true` option (Unicode NFC plus a
//! diacritic-folding table) is **not** implemented: a query or
//! haystack carrying a precomposed Latin letter ranks here as
//! `normalize: false` would. The haystack this host ranks is DBC
//! identifiers, arbitration-id spellings and ECU names — all ASCII by
//! the DBC grammar — plus the project's bus names, the only place a
//! diacritic can reach. Case folding, which is what the app actually
//! depends on, is ported in full.

/// Score floor as a fraction of the best match's score — the app's one
/// rule for how far down a ranked list a filter reaches, mirrored by
/// `MIN_RELATIVE_SCORE` in the frontend's filter slot (ADR 0044). The
/// two must agree: the trace panel narrows its rows host-side and its
/// timeline events client-side, so one query runs through both
/// matchers and a disagreement would show as events that survive a cut
/// their frames did not.
pub const MIN_RELATIVE_SCORE: f64 = 0.7;

/// How well a *message* must match, as a fraction of the winning
/// match's score, to keep its admission when a more specific match — a
/// signal name or one of a signal's value-table labels — won the query.
///
/// The floor above decides what is a match at all; this decides what a
/// match is *about*. A message's searchable text is long (bus name,
/// both id spellings, message name, transmitting ECU), so a query aimed
/// at a value still lands on it as a scattered subsequence well above
/// the floor — and a message admission is every frame of that message,
/// which drowns the handful of frames the value actually names.
///
/// At `1.0` a message survives a more specific winner only by tying it,
/// and a message that ties wins the tie outright (see
/// `FuzzyResolution`), so in practice the more specific winner takes
/// the query. That is the rule as stated: a message's admission is
/// dropped when a more specific match *outscores* it. The constant is
/// the tuning surface if that proves too sharp — the observed
/// near-misses run to 0.98 of the winner, so anything looser readmits
/// the whole message.
pub const MESSAGE_GATE: f64 = 1.0;

/// One ranked match: the haystack's position in the list handed to
/// [`rank`], and the score the port assigned it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Match {
    pub index: usize,
    pub score: i32,
}

/// Rank `haystacks` against `query`, score-descending, ties in input
/// order — the order the `fzf` package returns (it buckets by score
/// and concatenates the buckets descending, and its own sort is a
/// no-op without tiebreakers, so within a score the input order
/// survives).
///
/// An empty or whitespace-only query matches nothing. That is the
/// filter slot's convention rather than the package's, whose `find`
/// returns every item for an empty query: here an empty query means
/// "no filter", and the caller skips the leaf entirely.
#[must_use]
pub fn rank<'a>(query: &str, haystacks: impl IntoIterator<Item = &'a str>) -> Vec<Match> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let pattern: Vec<u32> = utf16_runes(&trimmed.to_lowercase());
    let mut out: Vec<Match> = Vec::new();
    for (index, haystack) in haystacks.into_iter().enumerate() {
        let item = utf16_runes(haystack);
        // The package skips a haystack shorter than the pattern before
        // it ever calls the matcher.
        if pattern.len() > item.len() {
            continue;
        }
        if let Some(score) = fuzzy_match(&item, &pattern) {
            out.push(Match { index, score });
        }
    }
    // Stable, so equal scores keep input order.
    out.sort_by_key(|m| std::cmp::Reverse(m.score));
    out
}

/// The prefix of a [`rank`] result that clears the relative floor —
/// the match set. Everything past it is scattered-subsequence noise.
#[must_use]
pub fn above_floor(ranked: &[Match]) -> &[Match] {
    let Some(best) = ranked.first() else {
        return ranked;
    };
    let floor = f64::from(best.score) * MIN_RELATIVE_SCORE;
    let end = ranked
        .iter()
        .position(|m| f64::from(m.score) < floor)
        .unwrap_or(ranked.len());
    &ranked[..end]
}

/// UTF-16 code units as the package sees them: its `strToRunes` splits
/// on `""`, which yields code units rather than code points, so an
/// astral character arrives as its two surrogate halves. Matching that
/// exactly costs nothing and removes a divergence.
fn utf16_runes(s: &str) -> Vec<u32> {
    s.encode_utf16().map(u32::from).collect()
}

// ---------------------------------------------------------------------
// The scoring tables, verbatim from the package's `algo.ts`.
// ---------------------------------------------------------------------

const SCORE_MATCH: i32 = 16;
const SCORE_GAP_START: i32 = -3;
const SCORE_GAP_EXTENSION: i32 = -1;
const BONUS_BOUNDARY: i32 = SCORE_MATCH / 2;
const BONUS_NON_WORD: i32 = SCORE_MATCH / 2;
const BONUS_CAMEL_123: i32 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION;
const BONUS_CONSECUTIVE: i32 = -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
const BONUS_FIRST_CHAR_MULTIPLIER: i32 = 2;

const MAX_ASCII: u32 = 0x7F;
const SMALL_A: u32 = b'a' as u32;
const SMALL_Z: u32 = b'z' as u32;

/// The package's shared `Int16Array` slab holds 100 KiB of entries; a
/// match matrix wider than that sends it down the v1 path instead.
const SLAB_I16_LEN: usize = 100 * 1024;

/// Character classes, in the package's numbering (the numbers are load
/// bearing — [`bonus_for`] compares against them).
const CLASS_NON_WORD: u8 = 0;
const CLASS_LOWER: u8 = 1;
const CLASS_UPPER: u8 = 2;
const CLASS_LETTER: u8 = 3;
const CLASS_NUMBER: u8 = 4;

fn char_class_of_ascii(rune: u32) -> u8 {
    match rune {
        0x61..=0x7A => CLASS_LOWER,
        0x41..=0x5A => CLASS_UPPER,
        0x30..=0x39 => CLASS_NUMBER,
        _ => CLASS_NON_WORD,
    }
}

fn char_class_of_non_ascii(rune: u32) -> u8 {
    let Some(ch) = char::from_u32(rune) else {
        // A lone surrogate: neither cased, numeric nor a letter, which
        // is what the package's string round-trip concludes too.
        return CLASS_NON_WORD;
    };
    if ch.to_uppercase().next() != Some(ch) {
        CLASS_LOWER
    } else if ch.to_lowercase().next() != Some(ch) {
        CLASS_UPPER
    } else if ch.is_numeric() {
        CLASS_NUMBER
    } else if ch.is_alphabetic() {
        CLASS_LETTER
    } else {
        CLASS_NON_WORD
    }
}

fn char_class_of(rune: u32) -> u8 {
    if rune <= MAX_ASCII {
        char_class_of_ascii(rune)
    } else {
        char_class_of_non_ascii(rune)
    }
}

/// Lowercase one rune the way the package does — an ASCII capital by
/// arithmetic, anything else through the Unicode mapping's first code
/// unit.
fn to_lower_rune(rune: u32) -> u32 {
    if (0x41..=0x5A).contains(&rune) {
        rune + 32
    } else if rune > MAX_ASCII {
        char::from_u32(rune)
            .and_then(|c| c.to_lowercase().next())
            .map_or(rune, u32::from)
    } else {
        rune
    }
}

fn bonus_for(prev_class: u8, curr_class: u8) -> i32 {
    if prev_class == CLASS_NON_WORD && curr_class != CLASS_NON_WORD {
        BONUS_BOUNDARY
    } else if (prev_class == CLASS_LOWER && curr_class == CLASS_UPPER)
        || (prev_class != CLASS_NUMBER && curr_class == CLASS_NUMBER)
    {
        BONUS_CAMEL_123
    } else if curr_class == CLASS_NON_WORD {
        BONUS_NON_WORD
    } else {
        0
    }
}

/// The package's `trySkip`: the next position at or after `from` where
/// `ch` (a lowercased pattern rune) occurs, preferring an earlier
/// uppercase occurrence when the match is case-insensitive.
fn try_skip(input: &[u32], ch: u32, from: usize) -> Option<usize> {
    let rest = input.get(from..).unwrap_or(&[]);
    let mut idx = rest.iter().position(|&r| r == ch);
    if idx == Some(0) {
        return Some(from);
    }
    if (SMALL_A..=SMALL_Z).contains(&ch) {
        let head = match idx {
            Some(i) => &rest[..i],
            None => rest,
        };
        if let Some(uidx) = head.iter().position(|&r| r == ch - 32) {
            idx = Some(uidx);
        }
    }
    idx.map(|i| from + i)
}

/// The package's `asciiFuzzyIndex`: a cheap subsequence pre-test that
/// also returns the first position worth starting the matrix at.
/// `None` means the pattern is not a subsequence at all.
fn ascii_fuzzy_index(input: &[u32], pattern: &[u32]) -> Option<usize> {
    if input.iter().any(|&r| r >= 128) {
        return Some(0);
    }
    if pattern.iter().any(|&r| r >= 128) {
        return None;
    }
    let mut first_idx = 0usize;
    let mut idx = 0usize;
    for (pidx, &pchar) in pattern.iter().enumerate() {
        idx = try_skip(input, pchar, idx)?;
        if pidx == 0 && idx > 0 {
            first_idx = idx - 1;
        }
        idx += 1;
    }
    Some(first_idx)
}

/// Score one haystack against one (already lowercased) pattern.
/// `None` when the pattern is not a subsequence of the haystack.
fn fuzzy_match(input: &[u32], pattern: &[u32]) -> Option<i32> {
    let m = pattern.len();
    if m == 0 {
        return Some(0);
    }
    // The package hands a matrix this wide to its v1 matcher instead,
    // because it will not fit the shared slab.
    if input.len() * m > SLAB_I16_LEN {
        return fuzzy_match_v1(input, pattern);
    }
    fuzzy_match_v2(input, pattern)
}

// The single-character bindings are the package's own notation for the
// match matrix (`M`/`N` the pattern and haystack lengths, `H0`/`C0`/`B`
// the first row's scores, run lengths and bonuses, `F` the first match
// position per pattern rune, `T` the case-folded haystack). Renaming
// them would cost the line-by-line correspondence that makes this
// transcription reviewable against `algo.ts`.
#[allow(clippy::too_many_lines, clippy::many_single_char_names)]
fn fuzzy_match_v2(input: &[u32], pattern: &[u32]) -> Option<i32> {
    let m = pattern.len();
    let n = input.len();
    let idx = ascii_fuzzy_index(input, pattern)?;

    // H0/C0/B are the first pattern row's score, consecutive-run length
    // and position bonus; F the first match position of each pattern
    // rune; T the case-folded haystack.
    let mut h0 = vec![0i32; n];
    let mut c0 = vec![0i32; n];
    let mut b = vec![0i32; n];
    let mut f = vec![0usize; m];
    let mut t: Vec<u32> = input.to_vec();

    let mut max_score = 0i32;
    let mut pidx = 0usize;
    let mut last_idx = 0usize;
    let pchar0 = pattern[0];
    let mut pchar = pattern[0];
    let mut prev_h0 = 0i32;
    let mut prev_char_class = CLASS_NON_WORD;
    let mut in_gap = false;

    for pos in idx..n {
        let mut ch = t[pos];
        let char_class = if ch <= MAX_ASCII {
            let c = char_class_of_ascii(ch);
            if c == CLASS_UPPER {
                ch += 32;
            }
            c
        } else {
            let c = char_class_of_non_ascii(ch);
            if c == CLASS_UPPER {
                ch = to_lower_rune(ch);
            }
            c
        };
        t[pos] = ch;
        let bonus = bonus_for(prev_char_class, char_class);
        b[pos] = bonus;
        prev_char_class = char_class;

        if ch == pchar {
            if pidx < m {
                f[pidx] = pos;
                pidx += 1;
                pchar = pattern[pidx.min(m - 1)];
            }
            last_idx = pos;
        }
        if ch == pchar0 {
            let score = SCORE_MATCH + bonus * BONUS_FIRST_CHAR_MULTIPLIER;
            h0[pos] = score;
            c0[pos] = 1;
            if m == 1 && score > max_score {
                max_score = score;
                if bonus == BONUS_BOUNDARY {
                    break;
                }
            }
            in_gap = false;
        } else {
            let gap = if in_gap {
                SCORE_GAP_EXTENSION
            } else {
                SCORE_GAP_START
            };
            h0[pos] = (prev_h0 + gap).max(0);
            c0[pos] = 0;
            in_gap = true;
        }
        prev_h0 = h0[pos];
    }

    if pidx != m {
        return None;
    }
    if m == 1 {
        return Some(max_score);
    }

    let f0 = f[0];
    let width = last_idx - f0 + 1;
    let mut h = vec![0i32; width * m];
    h[..width].copy_from_slice(&h0[f0..=last_idx]);
    let mut c = vec![0i32; width * m];
    c[..width].copy_from_slice(&c0[f0..=last_idx]);

    for (off, &fpos) in f.iter().enumerate().skip(1) {
        let pchar2 = pattern[off];
        let row = off * width;
        let base = row + fpos - f0;
        let mut in_gap2 = false;
        // The cell left of the row's first column is a hard zero, not
        // whatever the previous row left there.
        h[base - 1] = 0;
        for off2 in 0..=(last_idx - fpos) {
            let col = off2 + fpos;
            let ch = t[col];
            let mut s1 = 0i32;
            let mut consecutive = 0i32;
            let hleft = h[base - 1 + off2];
            let s2 = hleft
                + if in_gap2 {
                    SCORE_GAP_EXTENSION
                } else {
                    SCORE_GAP_START
                };
            if pchar2 == ch {
                s1 = h[base - 1 - width + off2] + SCORE_MATCH;
                let mut bonus = b[col];
                consecutive = c[base - 1 - width + off2] + 1;
                if bonus == BONUS_BOUNDARY {
                    consecutive = 1;
                } else if consecutive > 1 {
                    let run_start = col + 1 - usize::try_from(consecutive).unwrap_or(0);
                    bonus = bonus.max(BONUS_CONSECUTIVE.max(b[run_start]));
                }
                if s1 + bonus < s2 {
                    s1 += b[col];
                    consecutive = 0;
                } else {
                    s1 += bonus;
                }
            }
            c[base + off2] = consecutive;
            in_gap2 = s1 < s2;
            let score = s1.max(s2).max(0);
            if off == m - 1 && score > max_score {
                max_score = score;
            }
            h[base + off2] = score;
        }
    }
    Some(max_score)
}

/// The package's v1 matcher — the fallback for a match matrix too wide
/// for its slab. It finds the shortest window holding the pattern as a
/// subsequence and scores that window with [`calculate_score`], so it
/// is cheaper and scores lower than v2 on the same input.
#[allow(clippy::many_single_char_names)] // the package's notation — see [`fuzzy_match_v2`]
fn fuzzy_match_v1(input: &[u32], pattern: &[u32]) -> Option<i32> {
    if pattern.is_empty() {
        return Some(0);
    }
    ascii_fuzzy_index(input, pattern)?;

    let mut pidx = 0usize;
    let mut sidx: Option<usize> = None;
    let mut eidx: Option<usize> = None;
    for (index, &raw) in input.iter().enumerate() {
        if to_lower_rune(raw) == pattern[pidx] {
            if sidx.is_none() {
                sidx = Some(index);
            }
            pidx += 1;
            if pidx == pattern.len() {
                eidx = Some(index + 1);
                break;
            }
        }
    }
    let (mut start, end) = (sidx?, eidx?);
    // Walk back from the end to tighten the window's start.
    pidx -= 1;
    for index in (start..end).rev() {
        if to_lower_rune(input[index]) == pattern[pidx] {
            if pidx == 0 {
                start = index;
                break;
            }
            pidx -= 1;
        }
    }
    Some(calculate_score(input, pattern, start, end))
}

/// The package's `calculateScore`: walk `input[sidx..eidx]` once,
/// adding a match score plus its bonus for each pattern rune consumed
/// and a gap penalty for each rune skipped.
fn calculate_score(input: &[u32], pattern: &[u32], sidx: usize, eidx: usize) -> i32 {
    let mut pidx = 0usize;
    let mut score = 0i32;
    let mut in_gap = false;
    let mut consecutive = 0i32;
    let mut first_bonus = 0i32;
    let mut prev_char_class = if sidx > 0 {
        char_class_of(input[sidx - 1])
    } else {
        CLASS_NON_WORD
    };
    for &raw in &input[sidx..eidx] {
        let char_class = char_class_of(raw);
        let rune = to_lower_rune(raw);
        if pidx < pattern.len() && rune == pattern[pidx] {
            score += SCORE_MATCH;
            let mut bonus = bonus_for(prev_char_class, char_class);
            if consecutive == 0 {
                first_bonus = bonus;
            } else {
                if bonus == BONUS_BOUNDARY {
                    first_bonus = bonus;
                }
                bonus = bonus.max(first_bonus).max(BONUS_CONSECUTIVE);
            }
            if pidx == 0 {
                score += bonus * BONUS_FIRST_CHAR_MULTIPLIER;
            } else {
                score += bonus;
            }
            in_gap = false;
            consecutive += 1;
            pidx += 1;
        } else {
            score += if in_gap {
                SCORE_GAP_EXTENSION
            } else {
                SCORE_GAP_START
            };
            in_gap = true;
            consecutive = 0;
            first_bonus = 0;
        }
        prev_char_class = char_class;
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The golden vectors: what the TypeScript `fzf` package returns
    /// for the same queries over the same haystacks, with the same
    /// options the frontend's filter slot passes. Regenerate with
    /// `node apps/gui/scripts/fzf-golden.mjs`.
    const GOLDEN: &str = include_str!("../fixtures/fzf-golden.json");

    struct Golden {
        haystacks: Vec<String>,
        cases: Vec<GoldenCase>,
    }

    struct GoldenCase {
        query: String,
        ranked: Vec<(usize, i32)>,
        kept: Vec<usize>,
    }

    fn golden() -> Golden {
        let v: serde_json::Value = serde_json::from_str(GOLDEN).expect("golden vectors parse");
        assert_eq!(
            v["minRelativeScore"].as_f64(),
            Some(MIN_RELATIVE_SCORE),
            "the generator and the port must state one floor",
        );
        let haystacks = v["haystacks"]
            .as_array()
            .expect("haystacks")
            .iter()
            .map(|s| s.as_str().expect("haystack is a string").to_string())
            .collect();
        let cases = v["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .map(|c| GoldenCase {
                query: c["query"].as_str().expect("query").to_string(),
                ranked: c["ranked"]
                    .as_array()
                    .expect("ranked")
                    .iter()
                    .map(|p| {
                        let pair = p.as_array().expect("ranked entry");
                        (
                            usize::try_from(pair[0].as_u64().expect("index")).expect("index fits"),
                            i32::try_from(pair[1].as_i64().expect("score")).expect("score fits"),
                        )
                    })
                    .collect(),
                kept: c["kept"]
                    .as_array()
                    .expect("kept")
                    .iter()
                    .map(|i| usize::try_from(i.as_u64().expect("kept index")).expect("fits"))
                    .collect(),
            })
            .collect();
        Golden { haystacks, cases }
    }

    #[test]
    fn the_port_ranks_and_scores_exactly_as_the_typescript_package_does() {
        let g = golden();
        let hay: Vec<&str> = g.haystacks.iter().map(String::as_str).collect();
        assert!(
            g.cases.len() >= 20,
            "the fixture must exercise real queries"
        );
        for case in &g.cases {
            let got = rank(&case.query, hay.iter().copied());
            let got_pairs: Vec<(usize, i32)> = got.iter().map(|m| (m.index, m.score)).collect();
            assert_eq!(
                got_pairs, case.ranked,
                "ranking diverged from the package for query {:?}",
                case.query,
            );
        }
    }

    #[test]
    fn the_relative_floor_cuts_where_the_frontend_cuts() {
        let g = golden();
        let hay: Vec<&str> = g.haystacks.iter().map(String::as_str).collect();
        for case in &g.cases {
            let ranked = rank(&case.query, hay.iter().copied());
            let kept: Vec<usize> = above_floor(&ranked).iter().map(|m| m.index).collect();
            assert_eq!(
                kept, case.kept,
                "floor cut diverged from the frontend's for query {:?}",
                case.query,
            );
        }
    }

    #[test]
    fn the_wide_matrix_fallback_is_actually_exercised() {
        // The v1 path is only reachable when `haystack * query` outgrows
        // the package's slab. If the fixture ever stops crossing that
        // line the port's fallback would go untested and could rot
        // silently, so assert the vector still stands on it.
        let g = golden();
        let longest = g.haystacks.iter().map(String::len).max().unwrap_or(0);
        assert!(
            g.cases
                .iter()
                .any(|c| longest * c.query.trim().len() > SLAB_I16_LEN),
            "no golden vector reaches the v1 fallback any more",
        );
    }

    #[test]
    fn an_empty_query_is_no_filter_rather_than_every_row() {
        assert!(rank("", ["Anything"]).is_empty());
        assert!(rank("   ", ["Anything"]).is_empty());
    }

    #[test]
    fn a_query_longer_than_the_haystack_cannot_match() {
        assert!(rank("PackStateOfHealth", ["Pack"]).is_empty());
    }

    #[test]
    fn contiguous_boundary_aligned_matches_outrank_scattered_ones() {
        // The property the floor exists to exploit, stated without the
        // fixture: an exact word beats an acronym beats scattered
        // letters, so a floor cut keeps the first and drops the last.
        let hay = [
            "PackVoltage",
            "PrecisionActuatorCalibrationKnob",
            "ZoneRearLeft",
        ];
        let ranked = rank("pack", hay);
        assert_eq!(ranked[0].index, 0);
        let kept: Vec<usize> = above_floor(&ranked).iter().map(|m| m.index).collect();
        assert_eq!(
            kept,
            vec![0],
            "the scattered subsequence is below the floor"
        );
    }

    #[test]
    fn ties_keep_the_order_the_haystacks_arrived_in() {
        let ranked = rank("abc", ["abc", "abc", "abc"]);
        assert_eq!(
            ranked.iter().map(|m| m.index).collect::<Vec<_>>(),
            vec![0, 1, 2],
        );
    }

    #[test]
    fn matching_ignores_case_in_both_directions() {
        assert!(!rank("PACKVOLTAGE", ["packvoltage"]).is_empty());
        assert!(!rank("packvoltage", ["PACKVOLTAGE"]).is_empty());
    }
}
