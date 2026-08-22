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

### 1.7 The perf baseline no longer describes the project it is measured against
[Task 96](tasks/0096-long-names-render.md) · **interacts with the gate deferral (2.2)**

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

### 1.10 The perf harness's bus load was a project field, and is now a flag
[Task 99](tasks/0099-transmit-controls.md) · **the close-out gate cannot be run without reading this**

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

## 5. Housekeeping owed at close-out

- Retire the accepted tasks from [the roadmap](tasks/roadmap.md).
  Completed tasks are removed; the detail stays in git history.
- Delete the untracked `scratch-perf/` and `scratch-perf-p6/`
  directories — throwaway harness app-data.
- Run the render-tier gate once on the final tree (§2.2) — **designed
  around §1.7 and §1.10, not just repeated**: `--rbs-run-on-start` on
  the current tree, the `b6fca9c8~1` control without it, and a
  deliberate decision about the baseline the grown example projects
  invalidated.
- Replace the repo's pre-existing ignored mDNS round-trip test, which
  advertises a real `_cannet._tcp` instance on the LAN. It is the
  pattern agents copy, and real advertisements collide on the shared
  hostname and breed near-duplicate servers in the owner's list. No task
  opened.
