# Owner Review Queue

Everything from the current overseen chain that is waiting on the owner,
in one place. Opened 2026-08-21 at the owner's instruction ("make sure
we don't lose track of any of these items — I don't have time to review
right now").

**This file is an index, not the record.** Every item's real detail
lives in its task file, under that task's `## Blockers / side effects`
or its status log. The point of this file is that those are scattered
across a dozen task files and a long conversation; this is the single
list to walk when there is time. The walked §§ 1–2 were drained to
their source task files and deleted on 2026-08-26; their full text
survives in this file's git history.

**Keep it current.** When the owner decides an item, the ruling is
recorded **at the item's source** — the task file or ADR that created it
— and the item is deleted from here (owner instruction 2026-08-26: *"the
queue is only for things I still have to look at"*). If the file is
growing faster than it drains, that is the signal to stop taking new
work and hold a review.

**The standing policy (owner, 2026-08-26):** when an item is decided,
record the ruling at the item's source and delete it here. The queue
holds only what the owner still has to look at.

---

## 3. Open findings — drained

The 2026-08-26 walk dispositioned all 64 findings: into tasks
121/122/124/125/126/127, the backlog, or closures recorded at their
source task files. (3.4, the last, joined
[task 126](tasks/0126-test-and-example-cleanup.md) § 3 with its 3.45 and
§ 3F siblings — the wrong-rule-pin audit.) Nothing here awaits anyone.
## 4. Finished and awaiting acceptance

> **Owner, 2026-08-26 (closing queue finding 3.44):** *"you have a perf
> test that lets you launch the gui. I am satisfied with perf/stability
> of current thing, and I'm sure not going to change my mind about that
> rule."* The ADR 0031 harness is the sanctioned look at a running
> build; no further seen-running verification is required for
> acceptance, and the no-UI-automation rule stands.

All landed on one linear branch chain, none merged. Each met its
documented exit criteria, walked criterion by criterion against a named
test or artefact — **with the exceptions 3.45 lists**: five of these
tasks have no criterion-by-criterion walk at all, and three more are
walked but not clean.

Tasks 102 and 110 were added to this table 2026-08-23; they landed on
the chain like the rest but had reached neither the roadmap nor this
list, so their findings had never been queued.

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
| 102 | The event surface — kinds, per-view visibility, tag and description, the events view grown up |
| 110 | Chain CI repair, and the Windows MSI bundle target dropped |

**Two of these are blocked, by findings recorded in task 109**
(2026-08-22, from the owner's test drive of the chain):

- **101 — bus health.** Its hardware verification (item 3.14 above) was
  run and **failed**. Unplugging the PEAK dongles produced no indication
  of a bus fault; one side's utilization dropped to 0 while the other
  held steady; and the pack bus trace kept producing rows as though it
  were still transmitting. The last of those is the serious one — the
  trace showed traffic that never reached a wire. Task 109 item 2 and
  its phase 2 own the investigation.

  **Phase 2 has reported (2026-08-22).** All three symptoms have a
  confirmed cause and a landed fix; the "steady utilization" hypothesis
  (a stale reading) was *refuted* and replaced — the reading was live
  and was measuring the host's own tx echo, the same cause as the
  phantom trace rows. What acceptance still needs is the hardware run
  itself, which no agent can do: the expected observations, and what to
  look at if they do not appear, are written out under **Blockers /
  side effects** in [task 109](tasks/0109-usage-feedback-chip-era.md).
  Two findings from the investigation are queued above as 3.37 and
  3.38; 3.38 in particular is a behaviour change to a live data path
  that the confirmation run is the first hardware to see.
- **99 — transmit controls.** It shipped on the premise that Space
  already acted on RBS message rows and only needed adding to the
  transmit panel. The premise is false and was never tested: the RBS
  rows' enable control is a plain checkbox, so Space reaches the scroll
  container. Task 109 item 7 and its phase 3 own the fix, with the test
  that would have caught it.

Neither task is reopened; 109 carries both so one task holds all ten of
the owner's observations.

## 5. Housekeeping owed at close-out

- Retire the accepted tasks from [the roadmap](tasks/roadmap.md).
  Completed tasks are removed; the detail stays in git history.
- Run the render-tier gate once on the final tree — deferred there by
  owner ruling (2026-08-21/22: not until development is done and the
  owner has looked): four 60 s
  captures against the 2026-08-22 baseline (re-measured per ADR 0031's
  amendment, recorded at [task 96](tasks/0096-long-names-render.md))
  with `--rbs-run-on-start`, read as a band —
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

- Normalise the two files that have shown as modified with no content
  change for the whole chain: `examples/ev-zonal/dbc/pack.dbc` (the DBC
  generator writes LF, the checkout is CRLF) and
  `apps/gui/src-tauri/Cargo.toml`. Every phase from task 88 onward
  recorded them and left them alone, correctly — but they are standing
  noise in `git status` that makes "is this tree clean?" unanswerable at
  a glance, which is how an unrelated edit gets committed by accident.
  A `.gitattributes` entry or one normalising commit closes it.
