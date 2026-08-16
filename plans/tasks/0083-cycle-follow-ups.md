# Task 83 — Follow-Ups from the 70–78 Cycle

Opened by owner ruling 2026-08-16 at cycle-end housekeeping: the small
findings the 70–78 task files recorded in passing, collected here as a
task (rather than scattered into `plans/backlog.md`) so they get
groomed and worked as one pass. Each item names the task file it came
from; those files are retired, and their full context lives in git
history. (Two findings originally collected here moved out at review:
the stopped-capture window scan to task 80, the MDF-embedded-DBC
feature to task 84.)

## Items

1. **Command-level test harness for project commands** (from 0070).
   `close_project`'s session re-root is exercised only through the
   frontend's mocked host — the GUI crate has no Tauri `App` harness,
   so `open_project`, `save_project_as`, and `close_project` are
   untested at command level. Their parts are unit-covered and the
   behavior is pinned by the frontend's two-project switch test, whose
   mock reproduces the host's scope routing; a real end-to-end test
   needs the harness.

2. **Rebuild-chip rough edges, three of them** (from 0075):
   (a) the "Rebuilding signal caches…" chip has no natural end in a
   workspace with no plot panel open — the rebuild is lazy
   (ADR 0049), so nothing decodes until a plot asks;
   (b) the chip can clear one tick early when one plot area's signals
   catch up before another area has created its caches;
   (c) `useSessionReset` does not reset `firstIndex` /
   `firstIndexTsNs`, so after a Clear over a restored, truncated
   capture the frontend believes history was dropped until a
   `trace-grew` tick corrects it. The discard offramp resets them at
   its own call site; folding them into `useSessionReset` changes
   Clear, Connect, BLF-map-confirm and New alike.

3. **The boot launch-hang is still unattributed** (from 0075). One
   occurrence: 17 minutes of frontend unresponsiveness on first paint
   of a large restored session (57.7 M frames, pyramids reused,
   restore itself 642 ms), host healthy throughout, nothing logged, no
   crash dump. Bounded non-reproduction ruled out finite O(capture)
   passes; the shape says non-terminating loop or deadlock on the
   renderer main thread. Standing lead: the plot's x-sync ring
   (`applyXAll` → uPlot `setScale` → `onUserXChange` → `applyXAll`).
   The `ui_last_ms` watchdog now makes an occurrence legible in
   `cannet.log`, and the diag counters (`plot.userXChange`,
   `userx.setscale-hook`) are capturable under `--diag`. On the next
   occurrence: read those counters — a non-zero delta with no user
   input names the ring directly.

4. **A frameless MF4 import offers no time-range inputs** (from
   0073). The import modal's range fields are gated on
   `first_timestamp_ns` / `last_timestamp_ns`, which a frameless
   census leaves `None`, so a signal-only import is always whole-file
   even though `import_mdf` would honour a range on the signal fill.
   Surface the signal content's own time bounds in the census, or
   un-gate the fields for the frameless shape.

5. **The token editor stores a credential on an untrusted row** (owner
   feedback 2026-08-16 on the shipped task-74 rework). Every Servers
   panel row now offers Token…, including a row whose identity has
   never been accepted — the token is stored, but connect still
   refuses until trust is granted, so the stored credential silently
   does nothing. Either gate the editor on trust state, or say in the
   dialog what the stored token is waiting on.

## Exit criteria (draft — firm at grooming)

- Each item is either implemented with tests, or explicitly ruled
  out/deferred by the owner at grooming, with the verdict recorded
  here.
- Items that change render- or data-path behavior (2) pass the
  ADR-0031 gate.
