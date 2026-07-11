# Task 34 — BLF Release-Build Crash

Split out of the (shipped) Task 32 feedback batch: the one item that
couldn't land because it isn't reproduced yet. Kept off the roadmap
until a repro exists — it's a bug to chase, not scheduled work.

Loading a BLF crashes the app in a **release** build (not seen in dev).
Reproduce against a release build, capture the failure, and fix — a
release-only crash on the primary load path is a blocker for the alpha.
Lands with a regression test (or a documented repro if it turns out to
be a release-profile-only path).

## Observations so far

macOS crash report
(`crash-report-open-blf-while-previous-blf-stalled.txt`): trigger was
opening a BLF **while a previous BLF load was stalled**. Main thread,
`SIGABRT` from a Rust panic: `core::result::unwrap_failed` inside
`TraceStore::start_session`, called from `clear_trace_store`. The
original BLF is not available; severity unknown until reproduced.

## Hypotheses

Both consistent with the stack; neither confirmed.

- **H1 — poisoned store mutex:** the stalled loader thread panicked
  while holding the lock; `start_session`'s
  `expect("trace store mutex poisoned")` (`trace_store.rs`) fires on
  the next open.
- **H2 — scratch-clear I/O failure:** `raw.clear()` →
  `DiskRawStore::clear`'s
  `expect("cannet-spill: clearing scratch segments failed")`
  (`cannet-spill/src/disk.rs`), racing the stalled load's in-flight
  segment writes.

## Experiment first, then fix

Reproduce against a release build with a large/slow BLF — open a second
BLF mid-load — capturing stderr; the panic *message* discriminates H1
from H2 (and H1 implies a prior loader-thread panic whose message is
the real root cause). No fix until the repro exists.

## Exit criteria

- The release-build crash is reproduced and fixed, with a regression
  test (or a documented repro if it's release-profile-only).
