# Task 73 — MDF Ingestion Round 2: Signal-Only Files + Enum Labels

Opened by owner rulings 2026-08-14 out of Task 70's closeout review
(items 6 and 7 of 0070's decision list). Both build on Task 70
phase 7's ingestion work (per-message decoded groups, the
contents checkboxes, embedded-DBC streaming).

## 1. Signal-only MF4s become importable

Owner ruling: "yes." A frameless MF4 is still rejected at the source
seam (`MdfSourceError::SignalFile`), so the Signals checkbox never
gets a chance on one. Lift the rejection so a file carrying only
signal groups imports through the signals path (session origin
already comes from the earliest in-range sample when no frames are
imported — Task 70 phase 7 built that leg). The rejection being
deliberate, documented behavior, its removal takes its rustdoc and
tests with it — no vestigial error variant left behind.

## 2. Decoded enum channels carry their value labels

Owner ruling: "yes, ideally." A per-message decoded enumeration
channel stores its value→text table as the channel's own conversion;
Task 70 phase 7 keeps the stored code (the alternative lost the
channel entirely) but drops the labels, so those lanes render numbers
where a DBC-backed enum renders labels. Two ways out were recorded in
0070's phase-7 status log (carry a value table on the file-backed
signal model, or synthesize database entries from the conversion);
pick during grooming/implementation. Whatever carries the labels must
survive the paged serve — the lane renderer gets labels the same way
it does for DBC-backed enums.

## Test data

The owner's example capture files stay out of the repository — in
whole or in part — and are never named or referenced in any repo
document. Tests use synthetic fixtures built in-test (extend
`cannet-mdf`'s existing fixture machinery).

## Exit criteria (draft — firm at grooming)

- A signal-only MF4 imports; its signals land file-backed; the
  import dialog offers Signals (and no CAN-messages checkbox); the
  old rejection is gone with its docs and tests.
- A decoded enum channel's labels are visible wherever DBC-backed
  enum labels are (lane rendering, values views), regression-tested
  with a synthetic fixture carrying a value→text conversion.
- Both verified end-to-end against the owner's example files
  (results recorded generically in the status log).
