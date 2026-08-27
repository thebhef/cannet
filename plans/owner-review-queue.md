# Verification Checklist

What stands between the implemented chain and a release. (This file
was the owner review queue; reframed 2026-08-26 once the queue drained
— every finding's ruling lives at its source task file, ADR, or the
backlog, and the full record is in this file's git history.)

**How to verify** (owner ruling 2026-08-26): the ADR 0031 harness is
the sanctioned look at a running build. No UI automation, no further
seen-running checks required.

## Acceptance

One tick per implemented task, in the order they landed. All on one
linear branch chain off `main`, tip `task-109-phase-6-pattern-signals`;
nothing merged — merging the last branch takes all of it. The task
files are retired; detail is in git history. Rows marked **§** owe
their criterion-by-criterion verdicts to
[task 126 § 3](tasks/0126-test-and-example-cleanup.md).

- [ ] 86 — import time origins, enum overlays, events-panel width —
      `examples/time-origins/`, `examples/cannet-demo.mf4`
- [ ] 27 — live disk-watch for project and RBS files **§** —
      `examples/ev-demo/`
- [ ] 87 — BLF writer timestamp fidelity —
      `examples/time-origins/wall-clock-out-of-order.blf`
- [ ] 89 — signal mapping panel **§** — `examples/colliding-dbcs/`,
      `examples/ev-zonal/`
- [ ] 90 — follow-ups from the 86 / 27 / 87 cycle **§** —
      `examples/time-origins/wall-clock-out-of-order.blf`
- [ ] 88 — bus assignment governs decode — `examples/legacy-project/`,
      `examples/colliding-dbcs/`, `examples/capture-features/`
- [ ] 92 — one resolution rule — `examples/colliding-dbcs/`
- [ ] 91 — `frame_index_at_ns` on an unsorted store —
      `examples/time-origins/wall-clock-out-of-order.blf`
- [ ] 93 — source comments naming tasks, plus the CI lint **§**
- [ ] 98 — signals rendering wrong on a common scale —
      `examples/ev-demo/`
- [ ] 95 — gridview content click collapsing the message —
      `examples/cannet-demo.blf`, `examples/ev-demo/`
- [ ] 97 — enum value labels on the plot's y axis —
      `examples/ev-zonal/dbc/pack.dbc`, `examples/cannet-demo.mf4`
- [ ] 96 — long signal and `VAL_` names rendering —
      `examples/ev-demo/dbc/bms.dbc`, `examples/ev-zonal/dbc/zonal.dbc`
- [ ] 94 — server bind defaults, mDNS honesty, servers panel
- [ ] 99 — transmit controls (the false Space-in-RBS premise was fixed
      by 109 phase 3, 2026-08-23) — `examples/capture-features/`,
      `examples/legacy-project/`
- [ ] 100 — counter/CRC declared in a DBC populates the editor —
      `examples/cannet-demo.dbc`, `examples/ev-demo/`
- [ ] 105 — unfinalized-BLF recovery, read-only **§** —
      `examples/capture-features/interrupted.blf.part`,
      `examples/capture-features/interrupted-tail.blf.part`
- [ ] 104 — determinate load progress, discoverable cancel — **no
      furnished file**: needs a multi-million-frame capture, generated
      locally (`examples/capture-features/README.md`)
- [ ] 102 — the event surface (macOS picker criterion waived
      2026-08-26) — `examples/capture-features/annotated.blf`,
      `examples/capture-features/annotated.mf4`
- [ ] 103 — toolbar status bar, status chips, ADR 0055
- [ ] 101 — bus health (PCAN fix confirmed on the bench 2026-08-23;
      Vector tested 2026-08-26; Kvaser needs CANLIB — owner follows up
      independently)
- [ ] 106 — any-bus series ruling, sample-order sweep —
      `examples/legacy-project/legacy.cannet_prj`,
      `examples/capture-features/annotated.mf4`
- [ ] 19 — typed palette prompts, `Mod+T`/`Mod+E`, event-row keys —
      `examples/capture-features/annotated.blf`
- [ ] 110 — chain CI repair; Windows MSI bundle target dropped **§**
- [ ] 108 — the chip language (prototype durable, maintained in-repo)
- [ ] 107 — events point at signals (both open criteria dispositioned:
      unknown-key round-trip closed by task 122, which added the
      passthrough field on `Note`; file-backed subject → backlog) —
      `examples/capture-features/`
- [ ] 109 — usage feedback from the chip-era build — item 2 needs a
      Vector adapter, not a file
- [ ] 115 — trace row menu keeps only the event action —
      `examples/cannet-demo.blf` (queue item
      1.23 no longer exists post-reframe; recorded here instead — see
      [task 115](tasks/0115-trace-row-menu-scope.md))
- [ ] 117 — refuse to connect without a bound bus —
      `examples/capture-features/` (its `Aux` bus is unbound) (queue item
      1.34 no longer exists post-reframe; recorded here instead — see
      [task 117](tasks/0117-refuse-to-connect-without-a-bound-bus.md))
- [ ] 114 — one name per thing: the bar draws the command registry's
      words, its Database chip shows the view, and a virtual bus reads
      `virtual bus` in the Adapter column (queue items 1.37, 1.33b and
      1.17 no longer exist post-reframe; their closures are in
      [task 114](tasks/0114-one-name-per-thing.md)'s status log) —
      `examples/capture-features/`
- [ ] 122 — a file keeps what you wrote: black survives BLF, the BLF
      anchor reaches disk at latch rather than at `finish`, a foreign
      MDF's sample order is sorted at the reader's boundary, unknown
      `cannet-event/1` keys round-trip, and `commentedEventType` rides
      the block on every carrier (findings 3.9, 3.15, 3.30 and 3.59 no
      longer exist post-reframe; their closures are in
      [task 122](tasks/0122-a-file-keeps-what-you-wrote.md)'s status log)
      — `examples/capture-features/`
- [ ] 127 — the frontend's shared layer: the tag/description editors
      hand the keyboard back, `useConnectionStates` and
      `useSidecarStatus` sit on `useHostMirror`'s new `fromPayload`, and
      the trace gridviews carry real ARIA roles with one focus model
      (findings 3.51, 3.19 and 3.18 no longer exist post-reframe; their
      closures are in
      [task 127](tasks/0127-shared-layer-cleanups.md)'s status log).
      **Open:** `serverList.ts`'s two hooks carry the same launch race
      and need a ruling on what a malformed payload does — see that
      task's Blockers.
- [ ] 80 — a stopped capture costs nothing: an import that reaches its
      end freezes every trace element at the count the pump reports, and
      the by-id / signal window snapshot walks a bounded window in
      chunks instead of cloning it whole under the append mutex — see
      [task 80](tasks/0080-stopped-capture-resample.md)'s status log.
      **No furnished file**: needs a multi-million-frame capture,
      generated locally (`examples/capture-features/README.md`)

## Close-out chores

- [ ] Render-tier gate on the final tree: four 60 s captures with
      `--rbs-run-on-start` against the 2026-08-22 baseline, read as a
      band — only after
      [task 126 § 1](tasks/0126-test-and-example-cleanup.md) fixes the
      harness (gesture tally, memory attribution), or the numbers mean
      nothing. **The harness half landed 2026-08-27** (memory
      attribution, the gesture tally, and the `__shot` guard test — see
      that task's status log); two rulings below still stand in front of
      the gate.
- [ ] **Ruling needed: band vs worst-of-N for `lag_ms_max` and
      `rx_gap_short_frac_worst`** (finding 3.46). The evidence is
      charted — 206 stored render reports, and the spread *within one
      unchanged binary* is 4.3× median / 27× worst for `lag_ms_max` and
      2.3× median / 1163× worst for `rx_gap_short_frac_worst` — in
      [task 126](tasks/0126-test-and-example-cleanup.md)'s status log.
      ADR 0031 is amended per the ruling; limits still ratchet down only.
- [ ] **One clean-machine capture set** (finding 3.36) — needs the
      machine to itself, so it needs the owner. Task 107 phase 5's
      memory question is unanswerable until then; see
      [task 126 § 1](tasks/0126-test-and-example-cleanup.md).
- [ ] Replace the ignored mDNS round-trip test that advertises a real
      `_cannet._tcp` instance on the LAN.
- [ ] Normalise the two files that show modified with no content
      change all chain long: `examples/ev-zonal/dbc/pack.dbc` (LF vs
      CRLF) and `apps/gui/src-tauri/Cargo.toml` — a `.gitattributes`
      entry or one normalising commit. A `.gitattributes` now exists
      (LFS patterns only, 2026-08-27); the `eol` entries are still owed.
