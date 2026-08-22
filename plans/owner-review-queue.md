# Owner Review Queue

Everything from the current overseen chain that is waiting on the owner,
in one place. Opened 2026-08-21 at the owner's instruction ("make sure
we don't lose track of any of these items — I don't have time to review
right now").

**This file is an index, not the record.** Every item's real detail
lives in its task file, under that task's `## Blockers / side effects`
or its status log. The point of this file is that those are scattered
across a dozen task files and a long conversation; this is the single
list to walk when there is time.

**Keep it current.** Items get struck out with the ruling and its date
when the owner decides, and the file shrinks as tasks are accepted. If
it is growing faster than it drains, that is the signal to stop taking
new work and hold a review.

---

## 1. Behaviour changes that need a yes or no

These shipped. Each is a deliberate change the owner has not seen, and
each reverses or extends something previously decided. Any of them can
be revisited — none is expensive to undo *now*, and all get harder the
longer the chain grows.

### 1.1 `unified` y-axis mode no longer scales each unit group to fill
[Task 98](tasks/0098-common-scale-wrong.md) · **reverses ADR 0026**

Fixing the −200 A-drawn-as-−1.5 defect meant one range per axis, being
the union of every visible series on it. The consequence: overlaying a
0–1 SOC with a ±300 A current in `unified` now draws the SOC flat
instead of scaling it to fill the canvas.

The fix is right — an axis cannot carry a scale it does not label — but
*which mode* pays for it is a judgement. `per-unit` and `individual`
still cover the overlay case. ADR 0026 is amended with both rationales
kept, so reversing is a documented flip, not an archaeology exercise.

**Needed: keep, or restore per-group filling in `unified` some other
way.**

### 1.2 An unpicked collision's row now reports a signal only a later database defines
[Task 92](tasks/0092-one-resolution-rule.md) · **overseer ruling, not an owner one**

Phase 2 left an asymmetry: whether a row reported such a signal depended
on whether some *other* signal in that message carried a pick. The
overseer ruled it closed — a fast path that changes which signals appear
is a second resolution rule, not an optimisation.

This is user-visible **without** a pick, which is the part the owner did
not rule on.

**Needed: ratify or overturn.**

### 1.3 A calculated field could be designated by a database that does not supply the message
[Task 92](tasks/0092-one-resolution-rule.md) phase 3

A sixth Shape A site the original sweep never listed:
`rebuild_configs`'s default loop enumerated only messages that *declare*
calculated fields, so a database behind the winner could designate a
counter on a message it does not supply. Measured, fixed, pinned.

The single place where an answer changes with **no pick involved**.
Almost certainly wanted — flagged because it is a silent correction to
data someone may have been reading.

### 1.4 Reload all from disk now swaps each database in place
[Task 88](tasks/0088-bus-assignment-governs-decode.md) phase 7

Bus assignment and priority position now **survive** a reload where they
used to be re-derived from the path list. Required to make the
stop-on-reload rule reachable at all, and the reading ADR 0053 §1
demands — but the brief only asked for a stop.

### 1.5 A disclosed row's clickable width is the 32 rem line
[Task 95](tasks/0095-grid-content-click-collapses.md)

A click to the right of a disclosed row now does nothing, where it used
to collapse the message. Small, but a real change in feel.

### 1.6 Editor-face content stays a block rather than becoming rows
[Task 95](tasks/0095-grid-content-click-collapses.md)

The ruling was "content becomes real rows". Read narrowly: content that
is a *list* becomes rows; content that is an *editor face* stays a
Tab-reached block, kept safe by the toggle rule instead. ADR 0044
amended to say so. A wider reading is possible and was not taken.

### 1.8 `--no-tls` is now one flag from an unprotected routable listener
[Task 94](tasks/0094-server-defaults-and-discovery.md) · **security posture**

With the default bind moved to `0.0.0.0:50051`, `--no-tls` alone now
serves the hardware in the clear on the LAN. It used to be a no-op by
itself, because the default bind was loopback — putting the hardware on
the wire unprotected took *two* flags and therefore two decisions.

ADR 0041 names `--no-tls` as exactly this escape hatch, so the posture
is unchanged **in kind** — the sentence just got shorter. The phase left
it alone rather than narrow it, because requiring an explicit `--bind`
alongside `--no-tls` would be rewriting the ADR's escape hatch, which is
not a phase agent's call.

**Needed: leave it, or narrow `--no-tls` to require an explicit
`--bind`.** Worth a moment's thought — the flag's blast radius grew
without its documentation changing.

### 1.9 A bare launch now draws a second firewall prompt
[Task 94](tasks/0094-server-defaults-and-discovery.md) · FYI

A routable TCP listener on first bare run means a Windows Defender
Firewall prompt, separate from the mDNS one and on a different port.
Documented in the README; nothing in code can pre-empt it.

### 1.13 The RBS chip does navigate to an individual RBS file, which the ruling said it would not
[Task 103](tasks/0103-toolbar-status-chips.md) · **diverges from an owner ruling**

The ruling: *"The RBS chip is for the RBS signal mapping and any
notes/warnings there, not for RBS status, and it doesn't take us to any
individual RBS file."*

What shipped: the **reporting** half is exactly as ruled — the badge
counts problems across every open `.cannet_rbs`. The **destination** is
not. With exactly one configuration open the chip opens that
configuration's signals grid, which is an individual RBS file. With none
or several it reports, is disabled, and its tooltip says why.

The phase could not do otherwise honestly: the combined problems view
the ruling implies **does not exist**, and it declined to invent one.
That was the right call — but it means a stated ruling is currently
contradicted in the one-config case, which is the common case.

**Needed: either accept the one-config shortcut, or scope the combined
problems view as its own task.** Flagged rather than left to be
discovered.

### ~~1.14 Bus load has no source~~
[Task 103](tasks/0103-toolbar-status-chips.md) · **RESOLVED 2026-08-22 by
[task 101](tasks/0101-bus-health.md)** (`a0fb49fb`, `63c665c2`). Bit times
per bus come from `TraceStore`'s existing windowed sampler
(`rate.rs::by_bus_bits`), the denominator from `ConnectionStates`'
applied `speed_bps`, and the division is host-side in
`bus_health::load_percent`. The bar shows the **worst** bus, not the
mean. See 1.16 for what the figure excludes.

### 1.16 Bus load is a documented floor, not an exact figure
[Task 101](tasks/0101-bus-health.md)

The percentage **excludes bit stuffing**, because stuff bits depend on
the transmitted pattern including the controller-computed CRC, which the
model does not retain. So the number is always a little low — by up to
roughly a fifth on worst-case payloads. The phase chose a documented
floor over an estimate, which is the right instinct, but this is a
number on screen that a reader will take literally.

**Needed: accept the floor, or label it as one in the UI.**

### 1.17 The virtual-bus adapter cell is blank where the mock drew text
[Task 101](tasks/0101-bus-health.md) · flagged by the phase

The bus-health mock drew "driver default (nothing sent)" for a Sim bus.
That string is `describeAppliedConfig`'s answer for a *real* adapter
sitting on its default; a vbus has no controller, so the formatter — which
the ruling said to reuse — answers nothing and the cell is empty.
Faithful to the ruling, different from the mock.

**Needed: accept the blank, or give a vbus its own words.**

### 1.18 Error coalescing keys on the bus, not on the error class
[Task 101](tasks/0101-bus-health.md) · FYI

The model carries no error class **anywhere**: `CanFramePayload::Error`
is a unit variant, `FRAME_KIND_ERROR` has no field, the BLF reader
discards `CAN_ERROR_EXT`'s `ecc`, and python-can does not expose one
uniformly. Adding it is a core-payload field plus BLF / MDF / proto /
sidecar round-trips *and* a live producer — otherwise an import and a
live session would key differently. Closest faithful reading taken and
annotated in place. A summary also cannot name its bus (bus *names* are
the frontend's), so the label reads "1 284 bus errors over 4.1 s" with
the bus riding the event's `tag`.

### 1.15 Pressing the connection chip while connecting disconnects
[Task 103](tasks/0103-toolbar-status-chips.md)

The prototype's state table left this undecided. A connect that never
lands has no other escape, so the phase chose cancel. Reasonable, and
recorded because it was a choice rather than a ruling.

### 1.19 A DBC-backed plot series naming no bus now resolves nothing
[Task 106](tasks/0106-any-bus-series-and-sample-order.md) · **implemented on the overseer's recommendation, not an owner ruling**

Task 88 phase 2 named this fix and declined to take it. The grooming
recommended it, development proceeded on the recommendation rather than
stopping, and it shipped in `e20bb41b` + `2158b9c7` — which are the
whole diff to revert.

What it means in practice: a project saved before per-bus signal binding
keeps its plot series, but they decode nothing until re-pointed. They
report `NotDecoded`, the most severe of the five mapping states, count
toward the signal-mapping attention badge, and the panel's picker now
offers every bus the loaded databases decode on. No migration, no silent
emptying, no auto-binding to "the only bus".

One consequence worth naming separately: **`restore` drops a busless
persisted cache row and its segment files** rather than restoring or
parking it. That is cache, not user data — the view's reference
survives — but it is a deletion. The mutation test showed the
alternative: without the guard the row is *parked*, holding disk for a
series nothing can revive.

**Needed: ratify, or revert the two commits.**

---

## 2. Ruled, and recorded here so the ruling is not lost

### 2.1 Shape D — the per-frame decode fall-through stays open
Ruled by the owner 2026-08-21 · [task 92](tasks/0092-one-resolution-rule.md)

*"User can cure anything that doesn't match using the signal view. A
special case on mux arm is pretty esoteric and I'm ok with it being
wrong given you can just fix it."*

Two sites keep the fall-through, both pinned by tests as accepted
trades. **With one correction the owner should know about**: the cure
was real only at `sample_shared`. The mux extractor, the value tables
and the three calculated-field sites all ignored the pick map. Phase 3
routed them through the resolver that honours picks, so the premise the
ruling rests on is now true everywhere rather than at one site in four.

### ~~1.7 The perf baseline no longer describes the project it is measured against~~
[Task 96](tasks/0096-long-names-render.md) · **RESOLVED 2026-08-22 — re-baselined on the owner's ruling** (`04e3ab76`; ADR 0031 amended with the ruling and its caveats). The stored `baseline.json` is now measured against the grown `ev-zonal` with `--rbs-run-on-start`, so the ambiguity below is gone and no `b6fca9c8~1` control is needed at close-out. Kept for the record.

Task 96 added a long-name message to both example projects, as ruled:
`zonal.dbc` 151 → **152 messages**, 536 → **541 signals**; `bms.dbc`
gains `0x303` at 200 ms, about **+5 f/s** on ev-demo's ~515.

`ev-zonal` is the render-tier harness's project, so **the gate's
`baseline.json` was measured against a project that no longer exists.**
The owner accepted the gate consequences when ruling that both examples
get the long names — this records what they actually are.

The consequence is for the *end-of-chain* gate specifically: a reading
against the grown project is not comparable to the stored baseline
line-for-line, so a difference there is ambiguous between "the chain
regressed something" and "the project got bigger". Resolvable, but it
has to be done deliberately:

- A pre-change reading is recoverable by building `b6fca9c8~1` — the
  commit before the DBC grew — and gating that. That is the honest
  control, and it is a same-day build rather than a stale baseline.
- Task 96's grooming had asked the *implementing* phase to take that
  control before changing the DBCs. It did not, because the standing
  contract forbids phase agents from running the harness and the
  contract won. Neither side was wrong; the interaction was not
  foreseen.

**Needed at close-out: gate `b6fca9c8~1` as the control alongside the
final tree, or re-baseline deliberately with the owner's sign-off.**
Not a licence to promote a baseline to make a run pass — limits still
ratchet down only.

### ~~1.10 The perf harness's bus load was a project field, and is now a flag~~
[Task 99](tasks/0099-transmit-controls.md) · **RESOLVED 2026-08-22.** `--rbs-run-on-start` is now part of ADR 0031's documented invocation and of the re-baselined reading, and the pre-flag control is no longer needed (see 1.7). The standing rule survives: **sanity-check `ids_measured` and the rx/tx rates on every report** — a gate that passes without load is meaningless, not reassuring.

ADR 0031's render-tier run got its bus traffic from the example
projects' `"run": true` — which is precisely the open-a-file-and-start
transmitting that the owner's ruling forbids. Removing persisted run
state therefore **disarmed the harness silently**: a gate run would have
connected, measured an idle bus, and passed.

Fixed in `a4009bbb` with an explicit `--rbs-run-on-start`, and the dead
field removed from `ev-zonal` and `ev-demo`.

**Consequences for the close-out gate, which now has three moving
parts:**

1. Every run against the current tree **must pass
   `--rbs-run-on-start`**, or it measures nothing. A gate that passes
   without it is meaningless, not reassuring.
2. The control build named in 1.7 (`b6fca9c8~1`, before the DBCs grew)
   predates the flag and still carries `"run": true`, so it arms itself
   and must be run *without* the flag. The two invocations differ by
   design; the load they produce should not.
3. So a bare "run the gate" at close-out is now wrong in two distinct
   ways. It needs designing, not repeating.

### 1.11 Unassigning now clears a running RBS element's Run
[Task 99](tasks/0099-transmit-controls.md) · **changes a landed task 88 phase 4 behaviour**

Phase 4 deliberately left Run set when an unassign stopped an element,
because Run was mirrored from the project file. That reason is gone with
persistence, so the asymmetry went with it. Deliberate, recorded, and a
reversal of something already reviewed and accepted.

### 1.12 `start` on a transmit row is no longer disabled by a disconnected bus
[Task 99](tasks/0099-transmit-controls.md)

Not named in the exit criteria. Taken because leaving it would have had
the button refuse what Space now accepts — the owner's no-guard ruling
applied consistently. `send` stays locked.

### 2.2 The perf gate is deferred to the end of the chain
Ruled by the owner 2026-08-21

*"Don't even bother with the gates now. We can check at the end and
bisect later if there's a regression."* Unit tests and clippy still run
per commit — they are what keeps commits green enough to bisect
*through*. The render-tier gate runs once at the end.

Last full gate: task 92's tree (88 + 92 + 91 + 93), four runs, 31
metrics, all passing, with a same-day control proving the apparent
append/scan drift was machine state and not the change.

---

## 3. Open findings nobody has dispositioned

Recorded by the phases that found them, not yet decided.

| # | Finding | Where |
|---|---|---|
| 3.1 | `decode_frame` (per signal) and `encode_frame` (per message) can disagree in one narrow collision-plus-pick case. Closing it is not cheap. | [task 92](tasks/0092-one-resolution-rule.md) |
| 3.2 | Calculated-field resolution stays **per message**, decided explicitly rather than inherited — so a pick on any signal of a message moves the whole designation. | [task 92](tasks/0092-one-resolution-rule.md) |
| 3.3 | Bare "Phase N" labels survive in `index.css` (5 sites) and `crates/cannet-blf/Cargo.toml` (1). They name no task and point at no `plans/` path, so both the rule and the new CI lint pass. An older numbering scheme; left rather than invent a meaning. | [task 93](tasks/0093-source-comments-name-tasks.md) |
| 3.4 | Nothing in the 2421-test suite caught task 98's defect, and the two tests nearest it asserted the very rule that produced it. Worth asking what else is pinned that way. | [task 98](tasks/0098-common-scale-wrong.md) |
| 3.5 | `cargo doc -p cannet-gui` emits **47 warnings** — unresolved links, public docs pointing at private items. All pre-existing, none from this chain. No task opened. | — |
| 3.11 | **The MDF census's first ~10 % is uninterruptible and unreported.** `Mdf4File::open` reads the whole file before the walk begins, so Cancel does not land and the progress bar does not move during it. Interrupting it means restructuring how every MDF is read — recorded rather than fixed. | [task 104](tasks/0104-load-progress-and-cancel.md) |
| 3.12 | Three IPC wire shapes changed: `scan_*_channels` may now return `null` (a cancelled census), `open_log` / `import_mdf` gained `totalFrames`, and `signal_pyramids_rebuilding` returns a record. Internal, but they are the kind of thing an out-of-tree consumer would trip over. | [task 104](tasks/0104-load-progress-and-cancel.md) |
| 3.9 | **A recovered BLF is dated from 1970.** A stub header carries the unset SYSTEMTIME, so `start_unix_nanos == 0`. Unrecoverable by construction — per-event timestamps are offsets *from* that anchor — so task 105 names it in the recovery log line rather than repairing it. A recovered capture therefore opens with a plausible-looking but wrong absolute time. | [task 105](tasks/0105-unfinalized-blf-recovery.md) |
| 3.10 | **An abandoned MDF `.part` opens as a silently empty capture.** `MdfCanFrameSource::open` accepts a 572 kB part file, walks to **zero** frames, and `is_unfinalized()` returns `false`. The writer emits the group description at `finish()`, so the records on disk have nothing describing their shape, and the ID block still reads `MDF` rather than `UnFinMF`. Fixing it is a writer change, and it is only reachable through the UI once `.part` discovery exists — out of task 105's scope. | [task 105](tasks/0105-unfinalized-blf-recovery.md) |
| 3.7 | **A DBC-declared calculated field cannot be suppressed by a project.** `merge_calc_override` is `o.counter.or(default)` — there is no value meaning "the DBC says counter, this project says none", so unchecking a section showing a DBC `Default` writes nothing and the field returns on reopen. That is ADR 0027's model as written, but task 100's seeding is what turns that checkbox into a live control over a DBC-declared field for the first time, so the gap is newly reachable. Expressing suppression is an ADR-level change to `CalcFieldsSpec` and the `.cannet_rbs` format. | [task 100](tasks/0100-calc-fields-dbc-config.md) |
| 3.8 | The RBS feed collapses the DBC and override layers, so on an overridden field the `Override` chip is right but the "DBC default: …" hint is empty — where the transmit panel fills it in. | [task 100](tasks/0100-calc-fields-dbc-config.md) |
| 3.13 | **`useBusHealth` hand-rolls the host-mirror instead of using `useHostMirror`.** It fetches a snapshot, then registers the listener, with no post-listener refetch — precisely the launch race the shared hook exists to close (six other call sites use it). It copied `useConnectionStates`, which predates the hook. The 1 Hz emitter closes the stale window fast, so the user impact is small; the duplication is the real problem. **Assigned to task 108 phase 2**, the shared-layer phase. | [task 101](tasks/0101-bus-health.md) |
| 3.14 | **Controller state and TEC/REC are unverified on hardware.** The sidecar's state-poll thread was already producing `InterfaceState`; task 101 built the consumer and tested it at unit tier, but no dongle was available to the phase. The owner holds the hardware. | [task 101](tasks/0101-bus-health.md) |
| 3.15 | **`cannet-mdf::FileSignal::timestamps_ns` is documented "ascending" with nothing enforcing it** — no sort in `signal_groups`. Argued structurally sound (one source, no CAN-style interleave), but it is a data-source crate *below* the signal cache and outside the phase's boundary, so it was recorded rather than swept. | [task 106](tasks/0106-any-bus-series-and-sample-order.md) |
| 3.16 | **`plotCursors::statsOver` undercounted a span with tied sample times** — fixed in `3b8fd808` with a real lower bound. FYI rather than a decision: worth knowing because the measurement strip it feeds is the surface [task 108](tasks/0108-gui-chip-redesign.md) rules stays hidden pending rework, so the wrong numbers were not on screen. | [task 106](tasks/0106-any-bus-series-and-sample-order.md) |
| 3.17 | ~~A phase reported a gate clean that was not.~~ **CORRECTED 2026-08-22 — the gate was at fault, not the phase.** `git grep` cannot see an untracked file, so a phase that creates a new file, runs the documented command and reports it clean is being told the truth about tracked files only. Confirmed directly with a canary: the old spelling misses a new file carrying a task reference, `git grep --untracked` finds it. CI carried the same spelling — safe there, since a checkout has everything tracked, but it is the string every phase copies. Fixed in `5e142f53`; the job was run verbatim on the tree and passes, and the canary proves the flag is not cosmetic. | [task 19](tasks/0019-command-palette-goto.md), [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.18 | **Two focus models coexist in the trace gridviews.** Event rows are `tabIndex={0}` by an explicit earlier decision with a test behind it, so a click focuses the row rather than the container — beside the container-plus-`aria-activedescendant` model everything else uses. Also: no ARIA `role` on any trace gridview container or row, which leaves `aria-activedescendant` inert to assistive tech there. Both are whole-container concerns, outside task 19's event-rows-only ARIA scope. | [task 19](tasks/0019-command-palette-goto.md) |
| 3.19 | **`useConnectionStates` still hand-rolls the host mirror, and its launch race stays open.** It is the pattern `useBusHealth` copied; `useBusHealth` was migrated in `02f9b877` but this one cannot move as-is — `useHostMirror` treats the event as a nudge to re-read, while `useConnectionStates` *consumes the payload*, pinned by name in `ProjectPanel.connectionState.dom.test.tsx` ("follows the host's change event without a refetch"). Overseer read: the two concerns are separable moments — consuming the payload per event and doing one refetch when the listener attaches are not the same thing — so a `fromPayload` option on the shared hook would close the race and keep that expectation intact, rather than accepting a per-event refetch and re-pinning the test. Small, but it touches a shipped connection path. **Recommended for the post-107 cleanup task.** | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.20 | **The Import chip no longer relabels to "Loading trace…".** It keeps its label and reports busy on the pulsing hairline, the disabled state and the tooltip — the prototype's own treatment, and consistent with the nothing-resizes rule. A deliberate change to a shipped user-visible string. | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.21 | **The top toolbar wraps rather than overflowing.** The prototype gives the header `flex-wrap: wrap` and reserves the `…` overflow for the plot bar, and the Add-menu collapse leaves only twelve chips — so the shared `useToolbarFit` hook shipped with `StatusBar` as its only consumer. If the header should overflow instead, the prototype does not currently say so. | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.22 | **The measurement strip is suppressed by a switch, and one test went with it.** "Stays hidden" now means hidden for saved configs too — `MEASUREMENT_STRIP_DRAWS = false` gates the render while the stored `measEnabled` is deliberately left intact, so the rework inherits real preferences. Two consequences the rework must pick up: `MeasurementMenu` is a deliberate orphan (deleting the thing to be reworked is not a saving), and the panel-tier test that read the strip's rendered cells to guard a **derived-axis id mismatch** was removed rather than kept asserting nothing. Overseer check: the derivation itself is still covered at unit tier by `plotAxisDerivation.test.ts`, so the exposure while hidden is nil — but the strip-to-derivation seam is unguarded and the rework must write that test again, failing first. | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.23 | **Plot perf-readout visibility is view-local while its menu sibling `showDiag` persists.** One line of `plotPanelConfig` either way; flagged because the two sit next to each other on one menu and behave differently. | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.6 | Task 97's grooming asked that the owner see both axes before the **lanes** axis changed. No comparison was produced, because the lanes axis has no y-gutter labelling to compare — it already draws nothing there, and its labels are the tiles. If the owner meant the lane *tiles*, that is a different request, and it cuts against the stated reason for removing the axis labels. | [task 97](tasks/0097-enum-labels-on-axis.md) |

---

## 4. Finished and awaiting acceptance

All landed on one linear branch chain, none merged. Each met its
documented exit criteria, walked criterion by criterion against a named
test or artefact.

| Task | What it was |
|---|---|
| 86 | Import time origins, enum overlays, events-panel width |
| 27 | Live disk-watch for project and RBS files |
| 87 | BLF writer timestamp fidelity |
| 89 | Signal mapping panel |
| 90 | Follow-ups from the 86 / 27 / 87 cycle |
| 88 | Bus assignment governs decode — 8 phases, 15 criteria, gate passed |
| 92 | One resolution rule, not eleven copies — 3 phases, 13 `dbc_applies` sites down to 4 |
| 91 | `frame_index_at_ns` binary-searching an unsorted store |
| 93 | Source comments naming task numbers, plus the CI lint |
| 98 | Signals rendering wrong on a common scale |
| 95 | Gridview content click collapsing the message |
| 97 | Enum value labels on the plot's y axis |
| 96 | Long signal and `VAL_` names rendering |
| 94 | Server bind defaults, mDNS honesty, servers panel from the project view |
| 99 | Transmit controls: kill switch out, run state unpersisted, Space unguarded |
| 100 | Counter/CRC declared in a DBC now populates the editor |
| 105 | Reading a BLF whose writer never finalized, read-only |
| 104 | Determinate load progress, and a discoverable cancel |
| 103 | The toolbar's status bar, status chips, and ADR 0055 |
| 101 | Bus health — error frames labelled and coalesced, controller state, bus load |
| 106 | The any-bus series ruled on, and the signal cache's sample-order sweep |
| 19 | Typed-argument palette prompts, `Mod+T`/`Mod+E`, and event-row keyboard actions |

## 5. Housekeeping owed at close-out

- Retire the accepted tasks from [the roadmap](tasks/roadmap.md).
  Completed tasks are removed; the detail stays in git history.
- ~~Delete the untracked `scratch-perf/` and `scratch-perf-p6/`
  directories~~ — done by the owner 2026-08-22.
- Run the render-tier gate once on the final tree (§2.2). §1.7 and
  §1.10 are resolved, so it is four 60 s captures against the
  2026-08-22 baseline with `--rbs-run-on-start`, read as a band —
  **but the interaction script must be re-verified as actually driving
  the app before the numbers mean anything.** Task 108 phase 4 moved
  follow-live onto a chip, and `perfInteract.ts` now finds it by
  `button[aria-label="Follow Live"]` and reads `aria-pressed`. At a
  window narrow enough for that chip to spill into the `…` overflow the
  script cannot reach it at all — it does not open menus. This is the
  second failure mode in the overseer's own gate rules (a harness
  silently disarmed still passes), so the close-out run checks that the
  scrub actually happened, not just that the report is clean. The
  script's two other targets — uPlot's `.u-over` and `.trace-rows` —
  were confirmed untouched by the chrome sweep.

  **Overseer inspection 2026-08-22 — the harness cannot currently tell
  you this, and that is the real defect.** Every gesture function
  returns a label naming what it did, and `startPerfInteraction`
  **discards the return value**: `perfInteractTick(doc, tick, script)`
  is called for its side effect and nothing counts the labels. A
  gesture whose target is missing returns `null` and is skipped
  silently — deliberate, so that a layout with no plot is still a
  legitimate capture — but nothing anywhere records *how often* that
  happened. A run where the script found none of its targets produces a
  report structurally identical to a good one, only quieter.

  So the close-out gate needs a fix before it needs a run: **the
  interaction script should tally the gestures it performed and the
  report should carry that tally**, so a disarmed harness is visible in
  the data instead of having to be remembered. Small, but it is the
  precondition for every number the gate produces. Scoped to the
  post-107 cleanup, ahead of the gate run itself.
- Replace the repo's pre-existing ignored mDNS round-trip test, which
  advertises a real `_cannet._tcp` instance on the LAN. It is the
  pattern agents copy, and real advertisements collide on the shared
  hostname and breed near-duplicate servers in the owner's list. No task
  opened.
