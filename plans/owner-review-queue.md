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

- [ ] 86 — import time origins, enum overlays, events-panel width
- [ ] 27 — live disk-watch for project and RBS files **§**
- [ ] 87 — BLF writer timestamp fidelity
- [ ] 89 — signal mapping panel **§**
- [ ] 90 — follow-ups from the 86 / 27 / 87 cycle **§**
- [ ] 88 — bus assignment governs decode
- [ ] 92 — one resolution rule
- [ ] 91 — `frame_index_at_ns` on an unsorted store
- [ ] 93 — source comments naming tasks, plus the CI lint **§**
- [ ] 98 — signals rendering wrong on a common scale
- [ ] 95 — gridview content click collapsing the message
- [ ] 97 — enum value labels on the plot's y axis
- [ ] 96 — long signal and `VAL_` names rendering
- [ ] 94 — server bind defaults, mDNS honesty, servers panel
- [ ] 99 — transmit controls (the false Space-in-RBS premise was fixed
      by 109 phase 3, 2026-08-23)
- [ ] 100 — counter/CRC declared in a DBC populates the editor
- [ ] 105 — unfinalized-BLF recovery, read-only **§**
- [ ] 104 — determinate load progress, discoverable cancel
- [ ] 102 — the event surface (macOS picker criterion waived
      2026-08-26)
- [ ] 103 — toolbar status bar, status chips, ADR 0055
- [ ] 101 — bus health (PCAN fix confirmed on the bench 2026-08-23;
      Vector tested 2026-08-26; Kvaser needs CANLIB — owner follows up
      independently)
- [ ] 106 — any-bus series ruling, sample-order sweep
- [ ] 19 — typed palette prompts, `Mod+T`/`Mod+E`, event-row keys
- [ ] 110 — chain CI repair; Windows MSI bundle target dropped **§**
- [ ] 108 — the chip language (prototype durable, maintained in-repo)
- [ ] 107 — events point at signals (both open criteria dispositioned:
      unknown-key round-trip → task 122, file-backed subject → backlog)
- [ ] 109 — usage feedback from the chip-era build
- [ ] 115 — trace row menu keeps only the event action (queue item
      1.23 no longer exists post-reframe; recorded here instead — see
      [task 115](tasks/0115-trace-row-menu-scope.md))

## Close-out chores

- [ ] Render-tier gate on the final tree: four 60 s captures with
      `--rbs-run-on-start` against the 2026-08-22 baseline, read as a
      band — only after
      [task 126 § 1](tasks/0126-test-and-example-cleanup.md) fixes the
      harness (gesture tally, memory attribution), or the numbers mean
      nothing.
- [ ] Replace the ignored mDNS round-trip test that advertises a real
      `_cannet._tcp` instance on the LAN.
- [ ] Normalise the two files that show modified with no content
      change all chain long: `examples/ev-zonal/dbc/pack.dbc` (LF vs
      CRLF) and `apps/gui/src-tauri/Cargo.toml` — a `.gitattributes`
      entry or one normalising commit.
