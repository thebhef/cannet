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
files are retired; detail is in git history. Rows marked **§** owed
their criterion-by-criterion verdicts to
[task 126 § 3](tasks/0126-test-and-example-cleanup.md); **all six were
walked 2026-08-27** and each row now carries its outcome. The verdict
tables, with a named test or `file:line` behind every criterion, are in
that task's status log.

- [x] 86 — import time origins, enum overlays, events-panel width —
      `examples/time-origins/`, `examples/cannet-demo.mf4`
- [ ] 27 — live disk-watch for project and RBS files **§** —
      `examples/ev-demo/`. **2 of 4 met, 2 partial.** The watch's
      *decisions* are tested (safety rules, event classification,
      watch bookkeeping, frontend reaction); the functions that
      *execute* them are not — `load_into_element` and `write_element`
      hold the run-flag carry and the notice clear. The recorded Tauri
      mock-runtime blocker is real but is **not** what stands in the
      way: the decision lifts out into a pure function the way
      `outcome_for` already did. Owner's call whether that ships as is
- [x] 87 — BLF writer timestamp fidelity —
      `examples/time-origins/wall-clock-out-of-order.blf`
- [ ] 89 — signal mapping panel **§** — `examples/colliding-dbcs/`,
      `examples/ev-zonal/`. **7 of 8 met, 1 partial**: the host-side
      half of criterion 2 is done, but the panel holds every row
      unpaged (~1 074 on `ev-zonal`) and re-derives its counts in JS.
      Paging is task 112's exit criterion 4
- [x] 90 — follow-ups from the 86 / 27 / 87 cycle **§** —
      `examples/time-origins/wall-clock-out-of-order.blf`. **All 3 live
      criteria met** (the fourth was retired into task 91 at the time)
- [ ] 88 — bus assignment governs decode — `examples/legacy-project/`,
      `examples/colliding-dbcs/`, `examples/capture-features/`
- [ ] 92 — one resolution rule — `examples/colliding-dbcs/`
- [x] 91 — `frame_index_at_ns` on an unsorted store —
      `examples/time-origins/wall-clock-out-of-order.blf`
- [x] 93 — source comments naming tasks, plus the CI lint **§**.
      **All 3 met**; the lint's own command returns no matches today.
      One correction: the residual bare-`Phase N` sites the task
      recorded are gone, and a different five remain in
      `apps/gui/src-tauri/Cargo.toml` — none of which the lint catches
- [x] 98 — signals rendering wrong on a common scale —
      `examples/common-scale/`. Checked off 2026-08-28: the fix was
      already accepted as resolved from use, and the furnished BLF +
      project now reproduce both defect shapes from the experiment
      matrix deterministically (the README is the acceptance script;
      `examples/ev-demo/` remains the live-traffic eyeball)
- [x] 95 — gridview content click collapsing the message —
      `examples/cannet-demo.blf`, `examples/ev-demo/`. Checked
      2026-08-28: content clicks select within the expanded grid, only
      the message line collapses; the RBS half was exercised the same
      night by the Enter/Space/Shift+Tab keyboard work
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
- [x] 105 — unfinalized-BLF recovery, read-only **§** —
      `examples/capture-features/interrupted.blf`,
      `examples/capture-features/interrupted-tail.blf`. **All 5
      met.** Criterion 4's confirming experiment now lives in git
      history with the retired task file; today's tree carries its
      conclusion in `cannet-blf`'s reader and header docs
- [x] 104 — determinate load progress, discoverable cancel — **no
      furnished file**: needs a multi-million-frame capture, generated
      locally (`examples/capture-features/README.md`)
- [x] 102 — the event surface (macOS picker criterion waived
      2026-08-26) — `examples/capture-features/annotated.blf`,
      `examples/capture-features/annotated.mf4`
- [x] 103 — toolbar status bar, status chips, ADR 0055. Signed off
      2026-08-28 ("happy with the toolbar buttons at this point") after
      a review pass reshaped the bar: Save is Save All, Export beside
      Import, labels on the Graph / Events / Project chips, chip menus
      and the connection chip no longer truncate
- [ ] 101 — bus health (PCAN fix confirmed on the bench 2026-08-23;
      Vector tested 2026-08-26; Kvaser needs CANLIB — owner follows up
      independently)
- [ ] 106 — any-bus series ruling, sample-order sweep —
      `examples/legacy-project/legacy.cannet_prj`,
      `examples/capture-features/annotated.mf4`
- [x] 19 — typed palette prompts, `Mod+T`/`Mod+E`, event-row keys —
      `examples/capture-features/annotated.blf`. Checked 2026-08-28;
      two adjacent fixes landed with the review (the channel-map dialog
      focuses Open so Enter confirms; the save-capture chip reads
      **Export**, draws the mirror of Import's arrow, and sits beside
      Import) and the richer `Mod+T` parsing wish went to the backlog
- [x] 110 — chain CI repair; Windows MSI bundle target dropped **§**.
      It carried no criteria; its "Every job, green" table is
      **ratified as them**, plus the three fixes it made — **all 4
      met**. Note the job count moves: 110 measured six, CI defined
      seven once `rustdoc` joined, and task 118 took
      `comment-references` back out — CI is six again (see below)
- [x] 108 — the chip language (prototype durable, maintained in-repo).
      Signed off with the toolbar 2026-08-28: the chip language is the
      bar, and `plans/prototypes/gui-chip-redesign.html` has been
      maintained in lockstep through every chip change of this review
      cycle — the durability criterion demonstrated, not just promised
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
      `virtual bus` in the Adapter column. **The two toolbar halves are
      signed off with the bar (2026-08-28); only the Adapter-column
      reading remains to eyeball** (queue items 1.37, 1.33b and
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
- [ ] 113 — RBS is a grid: an RBS message's and a transmit tile's
      signals are rows the cursor reaches, Space on a signal row is
      inert (superseded 2026-08-28: Enter/Space on a signal row now
      land in its value cell, Enter toggles a message like Space, and
      Shift+Tab exits a row like Escape), neither signal-mapping grid paints a row background or
      ships a Row Highlights toggle, the RBS signals grid carries a
      **Default** column reading `none` where the DBC declares no start
      value, and Escape from a row control returns to the grid instead
      of exiting a fullscreened panel (queue items 1.6, 1.26, 1.13c and
      3.8 no longer exist post-reframe; their closures are in
      [task 113](tasks/0113-rbs-as-a-grid.md)'s status log) —
      `examples/ev-zonal/`, `examples/ev-demo/`. **Open:** a combobox
      dropdown still loses Escape to a global binding (it renders
      through a portal, so it is outside the container the fix keys
      on), and the two columned gridviews still carry no ARIA roles —
      both in that task's Blockers.
- [x] 80 — a stopped capture costs nothing: an import that reaches its
      end freezes every trace element at the count the pump reports, and
      the by-id / signal window snapshot walks a bounded window in
      chunks instead of cloning it whole under the append mutex — see
      [task 80](tasks/0080-stopped-capture-resample.md)'s status log.
      **No furnished file**: needs a multi-million-frame capture,
      generated locally (`examples/capture-features/README.md`)
- [x] 118 — the `comment-references` check leaves `ci.yml` and moves
      into the `implement-phase` and `oversee-roadmap` skills as a
      hand-run grep; CI is six jobs, not seven (queue item 1.35 no
      longer exists post-reframe; its closure is in
      [task 118](tasks/0118-comment-references-out-of-ci.md)'s status
      log). Process, not product — no example file

## Close-out chores

- [ ] **Look at the error-frame collapse against a real fault.** The
      chronological trace now hides the individual `Bus error` rows and
      leaves the coalesced summary event in their place, on by default,
      switching the panel onto the host's filtered paging the moment the
      first error frame lands. Exercised in tests and on the virtual bus,
      never against the PEAK bench's ~5,200 frames a second. Detail and
      the two other findings from that phase are in
      [task 121](tasks/0121-the-trace-tells-the-truth-about-the-wire.md)'s
      Blockers.
- [ ] **Check the two new hardware-truth readouts on the PEAK bench.**
      The bus-health panel now carries an **Overruns** column and an
      adapter-identity line, both fed from vendor status the ingest used
      to discard, and both written entirely against faked vendor
      responses — no PEAK adapter and no Vector card was involved. What
      to look for (a healthy bus reading `0` rather than an em dash; the
      PCAN-Basic and firmware versions looking right; whether the column
      moves during the open-circuit fault) is in
      [task 121](tasks/0121-the-trace-tells-the-truth-about-the-wire.md)'''s
      Blockers, with the Vector and Kvaser gaps.
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
- [ ] **Ruling needed: an MDF save silently clamps a pre-origin sample.**
      A sample stamped before the header's start time lands *at* the
      start time — a saturating `u64` subtraction, not an MDF
      constraint, since the master channel is an `f64` — and the save
      report states no drift and no clamped timestamps unconditionally,
      where the BLF path reports the same clamp. Found by the
      wrong-rule-pin audit; the test that asserted the clamp was
      *correct* has been split so it no longer ratifies it, and the
      writer is unchanged pending the ruling. Detail in
      [task 126](tasks/0126-test-and-example-cleanup.md)'s status log
      and Blockers.
- [ ] Replace the ignored mDNS round-trip test that advertises a real
      `_cannet._tcp` instance on the LAN.
- [ ] Normalise the two files that show modified with no content
      change all chain long: `examples/ev-zonal/dbc/pack.dbc` (LF vs
      CRLF) and `apps/gui/src-tauri/Cargo.toml` — a `.gitattributes`
      entry or one normalising commit. A `.gitattributes` now exists
      (LFS patterns only, 2026-08-27); the `eol` entries are still owed.
