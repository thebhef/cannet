# ADR 0038 — Canonical signal path: `bus/ecu/message/signal`

Status: accepted (2026-07-12)

## Context

Several surfaces need a human-readable way to name a signal: the plot
panel's picker and series labels, fuzzy-find (fzf-style) matching, and
the signal view's regex selection. Today each surface invents its own
form — the plot's regex filter matches dotted `bus.message.signal`
(`plotFilter.ts`, no ECU segment), the DBC panel's fzf haystack weaves
dotted `bus.ecu.msg.sig` ancestry, and series labels use
`message.signal`. With regex selection arriving (users type patterns
against *some* string), the subject string becomes a contract: two
views matching the same pattern against different renderings of the
same signal would silently disagree.

Separately, signals already have a stable internal identity — the
descriptor key `(bus, message id, extended, signal name)` — used for
plot series, project persistence, and host queries. That identity is
correct and must not change: it survives DBC renames of ECUs and
message names.

## Decision

**`bus/ecu/message/signal` is the one canonical, human-readable signal
path**, app-wide:

1. It is the **regex subject** — every regex-based signal selection
   evaluates against this exact string.
2. It is the **fuzzy-match subject** — fzf-style pickers match against
   it.
3. It is the **display form** — new UI shows signals this way;
   existing dotted display strings migrate opportunistically as their
   surfaces are touched.

Path segments are the DBC names verbatim (bus = project bus name,
ecu = message transmitter, message = message name, signal = signal
name), joined with `/`. A message with no transmitter renders an empty
ECU segment (`bus//message/signal`) so segment positions stay fixed for
patterns.

**The path is presentation and matching only.** The internal descriptor
key `(bus, message id, extended, signal name)` remains the stable
identity for persistence, host queries, and equality. A stored
selection stores keys (manual picks) or pattern strings (regex) — never
resolved paths.

## Why

- **One subject string, one behaviour.** Regex and fuzzy matching are
  only predictable if every surface agrees on the string being matched.
- **Slash-separated paths are pattern-friendly.** `/` never occurs in
  DBC identifiers, so segment-anchored patterns (`^chassis/`,
  `/BMS_[^/]*/`) are unambiguous; the current dotted separator is a
  regex metacharacter, so today's subject can't be matched literally
  without escaping.
- **Identity stays rename-proof.** Matching wants the mutable
  human-facing names; identity wants stability across DBC edits.
  Splitting the two roles keeps a persisted selection valid after an
  ECU or message rename (keys) while letting patterns re-evaluate
  against the new names.

## Consequences

- The host exposes/derives the path wherever it evaluates selection
  (regex evaluation is host-side per the thin-view rule), from the same
  DBC model that answers decode queries.
- The plot panel's dotted labels are not rewritten wholesale; they
  migrate as the shared selector work touches them.
- ECU (transmitter) becomes part of the signal's presented identity,
  which is why trace-like views grow an ECU column alongside this task.

## Rejected alternatives

- **C++-style `Bus::Message::Signal`** — no ECU segment, and `::` is
  hostile as a regex subject separator.
- **Resolved paths as stored identity** — breaks selections on DBC
  renames and duplicates what descriptor keys already do.
- **Per-surface subjects** (match against whatever each view happens to
  render) — guarantees the plot and the signal view disagree on the
  same pattern.
