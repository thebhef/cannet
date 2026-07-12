# Task 34 — BLF Release-Build Crash

Split out of the (shipped) Task 32 feedback batch. The crash mechanism
is now confirmed from the field log; the remaining unknown is the
original ingest panic.

## Confirmed mechanism (macOS `cannet.log`, 2026-07-10 18:24)

While ingesting a third-party (TSMaster-written) BLF — healthy at
~33k frames, ~4,900 fps — a thread panicked while holding the trace
store's inner mutex, poisoning it. The panic hook recorded **19
subsequent panic blocks, all** `trace store mutex poisoned:
PoisonError` — tokio workers (`len_and_low_water`,
`latest_in_window`, `session_start_ns`, …), the health recorder, and
finally the **main thread in `TraceStore::start_session`
(`trace_store.rs:714`) when the user opened a second BLF** — the
`SIGABRT` in the crash report. The "stalled load" was the
already-dead loader thread; the app was a zombie from the first
poison onward.

The same overlap (second open mid-load) was reproduced on Windows
(release) without a crash — consistent: without the antecedent ingest
panic there is no poison, and racing two healthy loads can't produce
one. Not release-only and not macOS-only; the release build is just
where a poisoned mutex escalates to a visible abort.

## What remains unknown

- **The poisoning panic itself is not in the log.** The whole session
  is in one un-rotated file; no panic block exists between the last
  healthy tick and the first poison observer. The hook missed the one
  panic that mattered — a forensics gap to close.
- **The root ingest panic is unidentified.** The TSMaster BLF is not
  available; something in it panics the ingest path mid-append.

## Fix (implemented; robust to the root panic staying unidentified)

- **Poison tolerance in `trace_store.rs`:** every
  `.expect("trace store mutex poisoned")` site now goes through a
  `lock_inner()` helper that recovers via
  `unwrap_or_else(PoisonError::into_inner)`, so a dead loader can
  never take the app down — worst case is one failed load. Regression
  test `poisoned_mutex_recovers_instead_of_panicking` deliberately
  poisons the mutex and verifies the accessors, `start_session`, and
  a fresh `append` all keep working.
- **Panics caught on the load path:** the BLF pump thread wraps
  `run_pump` in `catch_unwind`; on panic it emits `sys_error` + a
  `log-finished` error event so the UI shows "load failed:
  `<panic message>`" instead of silently stalling. The panic hook has
  already written the message and backtrace to `cannet.log` by then,
  closing the forensics gap for the next occurrence.

The ingest panic self-documents the next time a hostile BLF is
loaded; fixing it becomes a follow-up with a named panic site.

## Exit criteria

- ~~A poisoned trace-store mutex no longer aborts the app: accessors
  and `start_session` recover, covered by a regression test.~~ Done.
- ~~A loader-thread panic surfaces as a failed load (system log + UI
  error) and its message/backtrace lands in `cannet.log`.~~ Done.
- The original ingest panic, once captured, gets its own repro/fix
  follow-up.
