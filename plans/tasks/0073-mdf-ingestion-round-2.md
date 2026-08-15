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

**Grooming ruling (2026-08-15): the value table lives on the
file-backed signal model.** `FileSignal` gains a value table read from
the MDF conversion block, and the host serves it the way it serves a
DBC signal's table — the lane renderer's label path is already
generic over `(raw, label)` tables, so labels reach lanes and values
views through the existing plumbing. Rejected: synthesizing database
entries (fabricates entries with false provenance in the Database
panel, entangles bus-scoping and DBC management with signals that are
in no DBC).

**Owner amendment (2026-08-15):** name-matching a file-backed signal
against a loaded DBC is **not** rejected — it is **later scope**,
deferred until the DBC can be gotten out of the MDF itself (its
embedded/external attachments). As things stand it fails exactly when
the recording tool's DBC is not in the project, so it is not the
mechanism this phase builds; the value table on the file-backed signal
model is.

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

## Status log

### 2026-08-15 — §1 signal-only MF4s become importable

Branch `task73-p1-signal-only-mf4`, off `task72-p9-hover-parity`.

**`8ea2b55a` `docs(plans): record the task-72 closeout and the task-78
opening`** — the working tree's pending `plans/` edits, committed
verbatim as the branch's opening commit.

**`1da58119` `feat(mdf): read a frameless MF4 as the signal file it
is`** — the rejection is gone from both entry points
(`MdfCanFrameSource::open`, `scan_mdf`). A file with only signal
groups now opens like any other, emits no frames, and serves its
groups through `signal_groups`; the census reports an empty channel
list and a zero frame count, which is what makes the contents dialog
offer Signals and no CAN-messages checkbox. `MdfSourceError::SignalFile`
had no other producer, so the variant, its `Display` arm and its
rustdoc went with the behaviour, as did the README's two claims that
such files are rejected and the fixture generator's comment saying the
same. No new host code was needed for the session origin: with no
frames imported, `signal_origin_ns` already supplies it from the
earliest in-range sample.

Tests: `cannet-mdf` 40 → 41 (the rejection test replaced by
`a_signal_only_file_opens_and_offers_its_signals` and
`a_signal_only_file_scans_as_a_frameless_census`, both written first
and watched fail against `Err(SignalFile { signal_groups: 2,
decoded_groups: 0 })`); `cannet-gui` 665 → 665 (the rejection test
replaced by `mdf_signal_only_file_imports_through_the_signals_path`,
which pins scan → open → `fill_file_backed_signals` → `signal_origin_ns`
on the committed `signal_only` fixture: 3 signals, 72 samples, origin
at the earliest sample). Both crates clippy-clean with `--all-targets`,
`cargo fmt --check` clean.

**`87e171d2` `test(gui): pin the frameless MF4's contents dialog`** —
frontend regression guard only; no frontend code changed. The modal
already gated the CAN-messages content on `channels.length > 0`, but
no file shape could reach that branch while the source seam rejected
frameless files.

- *Observation.* The new dom test passed on first run, so it did not
  drive any change.
- *Hypothesis.* It is a real guard rather than a tautology: it fails
  if the gate stops consulting the channel census.
- *Experiment.* Flipped `hasMessages` to `format === "MDF"` in
  `BlfChannelMapModal.tsx` and re-ran the file.
- *Data.* `offers only Signals for a file with no frames in it`
  failed (`expected true to be false`); the other two passed. Gate
  restored from the index.
- *Conclusion.* The guard binds the behaviour the exit criterion names.

Frontend: 2197 → 2198 tests across 163 files, `pnpm --dir apps/gui
build` clean.

#### End-to-end verification against the owner's example files

- *Observation.* Every MF4 in the owner's example set carries
  bus-logging groups — a probe over all of them reports a non-empty
  channel census and thousands of frames each, alongside 60-63 signal
  groups (171-176 signals) of which ~28 are per-message decoded. None
  is frameless, so the file shape §1 is about does not occur in the
  set as delivered.
- *Experiment.* Outside the repository, in the session scratchpad,
  one of those files was rewritten with `asammdf` keeping every
  channel *except* the raw bus-logging groups, producing a genuinely
  frameless MF4 written by a foreign tool from real recorded content.
  A throwaway example binary (built, run, deleted — never committed)
  then ran `scan_mdf` and `MdfCanFrameSource::open` over it.
- *Data.* The derived file scans to `channels=[]`, `frame_count=0`,
  61 signal groups, 172 signals, 28 of them per-message decoded, and
  opens to 0 frames with the same 172 signals over 44,214 samples and
  the same earliest-sample timestamp as the source file's signal
  content. Before this change both calls returned the `SignalFile`
  rejection.
- *Conclusion.* A real frameless MF4 from a foreign writer imports
  through the signals path with its full signal content and its
  session origin intact. Nothing derived from the owner's files was
  written into the repository, and no file of theirs is named here.

## Blockers / side effects

- **The exit criterion's "verified end-to-end against the owner's
  example files" cannot be met literally for §1**: the owner's set
  contains no frameless MF4 (see the status log's observation). The
  closest faithful reading was taken — a frameless file derived from
  one of theirs by a third-party writer, verified in the scratchpad —
  and the criterion is otherwise met by the fixture-backed tests. If
  the owner has a genuinely frameless capture to hand, re-running the
  same probe over it would close the gap outright.
- **No GUI launch was part of this verification.** The dialog leg is
  pinned by the dom test and the host leg by `cannet-gui`'s unit
  tests; driving the real dialog would need synthetic input on the
  owner's desktop, which is out of bounds.
- **A frameless import offers no time-range inputs.** The modal's
  range fields are gated on `first_timestamp_ns`/`last_timestamp_ns`,
  which a frameless census leaves `None`, so a signal-only import is
  always whole-file even though `import_mdf` would honour a range on
  the signal fill. Out of §1's scope (which is the rejection and the
  contents checkboxes), recorded rather than fixed.
