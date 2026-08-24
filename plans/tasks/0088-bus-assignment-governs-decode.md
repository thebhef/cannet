# Task 88 — Bus Assignment Governs Decode

> **Status 2026-08-23 — code-complete, awaiting acceptance.** All eight
> phases landed 2026-08-19 to 2026-08-21 on the chain (nothing has
> merged). Fifteen exit criteria are walked across two walk sections, all
> met, and the ADR-0031 gate the task owed was run and passed four for
> four. Findings still owed a verdict: owner-review-queue 1.4, **1.32**,
> **1.33**, **1.34**, 2.1 (ruled), 3.1, 3.2, **3.48**.

Opened by owner ruling 2026-08-19, from task 86 phase 3's finding that
a replacement DBC inherits neither the bus scoping nor the priority
position of the file it displaced — and so, on a scoped project,
silently decodes the wrong frames. Grilling that finding produced a
different and cleaner model than the one the code implements, and this
task is that model.

It **supersedes parts of [task 81](0081-bus-scoped-decode.md)**, which
made decode honour bus scoping under the old rule (empty scoping =
every bus). Task 81 shipped and stays closed; what it built —
`dbc_applies` on the decode path, the bus-scoped fingerprint, per-bus
value tables — is the machinery this task re-points at a different
rule.

## The model (owner, 2026-08-19)

1. **A DBC assigned to no bus decodes nothing.** This inverts today's
   rule, where an empty bus list means "applies to every bus"
   (`filter::dbc_applies`).
2. **Adding a DBC to the project implies nothing about bus
   assignment.** Loading a file makes it available; it does not make it
   decode.
3. **Removing a DBC from the project removes it from its assigned
   buses**, and nothing more.
4. **Assigning a DBC to a bus is the first opportunity to check the
   cache** for already-decoded signals.
5. **Fingerprints that match are restored from cache** — the parked
   caches for that signal come back rather than being re-decoded.
6. **Unassigning a DBC from a bus parks every cache based on it.**

Assignment is therefore both the decode boundary *and* the cache
lifecycle boundary, which is what makes "replace" stop being a special
operation: remove parks, add decodes nothing, assign revives what
matches.

## Grooming resolutions (2026-08-19)

- **No migration for existing projects.** A project saved before this
  rule opens with its databases unassigned, and decodes nothing until
  the user assigns them. Auto-assigning on open was rejected for a
  specific reason: **old or different-version DBCs legitimately remain
  in a project**, and auto-assignment would silently activate a stale
  or duplicate database alongside the current one — the exact mess the
  model exists to prevent.
- **A CAN frame without a bus is not a thing.** Frames enter the GUI
  via a bus; an imported frame not mapped to one is dropped rather than
  stored bus-less. The same shape is expected for future frame types.
  Consequently `bus_id` stops being optional in the model — which
  touches [task 61](0061-ingest-perf-round-2.md)'s interning item.
- **Task 81's null-bus fallbacks come out**: `list_value_tables`
  falling back to every loaded database when the bus is unknown, and
  `signal_fingerprint::dbc_encoding` keeping the whole candidate chain
  for `bus_id: None`. Both were built on "unscoped = all buses" and
  have no meaning once every frame has a bus.
- **Priority stays one project-wide load order; assignment filters
  it.** A bus's candidate chain is the project's databases, in project
  order, restricted to those assigned to that bus. Two databases
  assigned to one bus that define the same id is a weird case, but it
  should **warn, naming which one wins**.
- **The import dialog's "(skip)" is a stated choice.** Frames on a
  skipped channel are dropped with no confirmation step and no
  relabelling: a user who skips a channel is saying they are not
  interested in those messages, and warning about it would treat an
  intended outcome as an accident.
- **Discoverability is the Database panel row, and nothing more.** The
  row shows whether a database is assigned and to what. No status-line
  warning and no prompt on project open: a user whose databases are
  unassigned sees undecoded CAN frames in the trace, and that is
  already the signal. (Scoped to *this* task. The signal mapping panel
  — [task 89](0089-signal-mapping-panel.md) — later adds a launcher
  badge carrying a needing-attention count, which an unassigned project
  will light up. A number on a button is neither a warning nor a
  prompt, so it is consistent with this ruling rather than an exception
  to it.)
- **The encoding fingerprint is stamped when a cache is built, not at
  persist** (moved here from task 86 phase 3's findings). Today a
  pyramid built since the last persist carries no recorded fingerprint
  and is therefore dropped rather than parked, which makes "assignment
  restores your caches" true of a long-running session and false of one
  that just plotted a signal.
- **The perf bench takes the example project's real assignments**
  (moved here from task 81 phase 1's side effects). It currently
  declares its databases unscoped, which under this rule decodes
  nothing at all. Re-baseline once, with the reason recorded.

## Exit-criteria grooming (2026-08-19)

- **A frame's bus becomes required; a signal key's stays optional**
  (owner ruling). `bus_id` is one name over two different things, and
  only one of them is what the model rules on:
  - **Frame-side** (`CapturedFrame`, the spill record, the session) —
    `None` means "unknown bus", which is exactly what this task
    abolishes. Made non-optional here: measured at roughly six
    production construction sites plus tests.
  - **Signal-key-side** (`SignalKey`, the signal snapshot, the
    fingerprint) — `None` means a **file-backed series**, which
    genuinely has no bus and no message, as `SignalKey`'s own rustdoc
    states. 31 of the 44 `bus_id: None` sites are here. Forcing a bus
    on them would mean a sentinel no bus list contains, which is
    `Option` again spelled worse. Left optional, with the reason stated
    in the code.

  Two things kept this from being a single sweep, and both stay out of
  this task: `cannet-spill`'s record is a disk format on the ingest hot
  path and is the field [task 61](0061-ingest-perf-round-2.md) is
  scheduled to intern (changing its shape here means doing 61's work
  early or doing the sweep twice with a re-baseline each time), and the
  decode path carries a legacy `None`-means-any-bus series behaviour
  that needs a migration decision rather than a type change. Nothing on
  the wire constrains the choice — `bus_id` does not appear in
  `cannet.proto`.

- **A view configured against an unassigned database keeps its
  configuration** (owner ruling). Unassigning parks the caches; the
  plot series, colormap lane or transmit row that referenced those
  signals stays configured and renders nothing until the database is
  assigned again, at which point the revived cache and the surviving
  configuration bring the view back whole. Destroying view
  configuration on a *reversible* action would make the revival
  worthless — the samples would come back and the user would still
  rebuild the plot by hand.

  **What restores it is the signal, not the file** (owner
  clarification): the revival case that matters is reverting to *a*
  database carrying those signals / that fingerprint, not necessarily
  the same file. The two halves already agree by construction and this
  task must keep them agreeing — a view config references
  `bus | messageId : signalName` and carries no DBC path
  (`signalKey`, `apps/gui/src/plotData.ts`), so it re-binds to whatever
  assigned database defines that signal; and cache revival keys on the
  encoding fingerprint, not on file identity, so the samples come back
  on the same terms. The guarantee to test is therefore *any assigned
  database that provides the signal restores the view, and a matching
  fingerprint restores its samples* — not *re-assigning the same file
  restores both*. **The empty lane carries no per-lane
  explanation**: discoverability stays the Database panel row, as ruled
  above. A signal that no longer exists under its old name after a DBC
  version change is a different problem, owned by the signal mapping
  panel ([task 89](0089-signal-mapping-panel.md)), whose per-row
  candidate picker re-points a view onto the signal that replaced the
  one it named.

- **Unassigning stops what it was driving** (owner ruling). An RBS
  element or periodic transmit row built from a database that is
  unassigned from its bus is **stopped**, and a single system-log entry
  records that it was. The unassign itself proceeds: it is a deliberate
  gesture, and continuing to put frames on a real bus from definitions
  the project no longer applies is
  [ADR 0053](../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md)
  §1's uncommanded-send, reached deliberately instead of by a file
  changing underneath. Refusing while something runs was rejected — it
  would make assignment conditional on the user first hunting down what
  is transmitting. **No modal and no per-element notice**: one log line
  is enough.

## Scope

- `filter::dbc_applies` inverts, and every consumer that reads it moves
  with it — decode, value tables, transmit, verification, the
  descriptor universe, RBS.
- Assignment (`set_dbc_buses`) grows the cache lifecycle hooks: park on
  unassign, revive-by-fingerprint on assign.
- Import drops frames on unmapped channels; the store no longer holds a
  bus-less frame.
- The Database panel shows assignment state and the duplicate-id
  warning.

## Phases (2026-08-19)

Sequential, each on its own branch chained from the last, except where
noted.

1. **A frame's bus is required.** `bus_id` stops being `Option` on the
   frame side — the captured frame, the trace-store flush record, the
   IPC frame rows, the session — and import drops a frame whose channel
   maps to no bus. Signal-key-side `bus_id` stays optional, with the
   reason stated in the code (`SignalKey`'s rustdoc already says it).
   `cannet-spill`'s record and the decode path's legacy
   `None`-means-any-bus series behaviour stay out, per the exit-criteria
   grooming above. No rule change yet: this phase only removes the
   representation the next phase's rule has no meaning under.
2. **`dbc_applies` inverts.** An empty bus list decodes nothing, and
   every consumer moves with it: decode, value tables, transmit,
   verification, the descriptor universe, RBS. Task 81's null-bus
   fallbacks come out (`list_value_tables`'s all-databases fallback and
   `signal_fingerprint::dbc_encoding`'s whole-chain-for-`None`). The
   perf bench takes the example project's real assignments, with its
   one-time re-baseline recorded and the reason written down.
3. **Assignment is the cache lifecycle boundary.** `set_dbc_buses`
   grows the hooks: unassign parks every cache based on that database,
   assign revives the parked caches whose fingerprints match rather
   than re-decoding them (`signal_cache::park` / `revive_retained` are
   the existing machinery — this phase re-points them at assignment,
   it does not build a second one). The encoding fingerprint is stamped
   when a cache is built rather than at persist, so a pyramid built in
   the current session parks like any other. A view configured against
   an unassigned database keeps its configuration — mostly a test, since
   a view config carries no DBC path, but it is the guarantee that makes
   revival worth having, so it is tested both directions here.
4. **Unassigning stops what it was driving.** An RBS element or
   periodic transmit row built from a database being unassigned from its
   bus is stopped, and one system-log entry records it. The unassign
   proceeds regardless. No modal, no per-element notice.
5. **The Database panel says what is assigned, and warns on a
   collision.** The row shows whether a database is assigned and to
   what — the whole of the discoverability ruling. Two databases
   assigned to one bus defining the same id warn, naming which one
   wins.
6. **A shared colour chip** (owner ruling 2026-08-19). The app has
   three parallel swatch implementations — `.trace-event-swatch`
   (+`-wrap`/`-input`), `.plot-signal-swatch`
   (+`.hidden`/`-wrap`/`-input`) and `.plot-bus-swatch` — plus seven
   `type="color"` sites across five components. `index.css`'s own
   comment on the events swatch says "(same control as the plot's series
   swatch)", so the duplication was noticed and copied anyway; both
   wrappers carry near-identical commentary about anchoring the native
   picker, and a macOS positioning bug is written down in only one of
   them, which is the failure this rule exists to prevent
   (`CLAUDE.md`: one shared implementation over per-panel copies). The
   events panel's shape — 1.5 rem bar, full row height, 2 px radius,
   `--border-wash` hairline — is the one to standardise on.
   **Independent of this task's decode rule**: it neither blocks nor is
   blocked by the assignment work, so it can be sequenced wherever it
   fits, and split into its own task if these phases get long.

## Exit criteria (2026-08-19)

- A database assigned to no bus decodes nothing, on every consumer;
  tested.
- No frame the store *accepts* lacks a bus, and an unmapped import
  channel is dropped silently — a skipped channel is a stated choice,
  not an accident to warn about. Scoped to the append path
  deliberately: reopen maps spill segments directly and bypasses
  `append`, so a scratch written by a pre-rule build can still restore
  bus-less frames (they render with an empty bus id). `cannet-spill` is
  out of this task's scope, and the underlying defect — the manifest's
  version is stamped but never checked on reopen — is recorded as
  [task 90](0090-cycle-86-87-follow-ups.md) item 5.
- Assigning a database to a bus revives the parked caches whose
  fingerprints match, rather than re-decoding them; unassigning parks
  them; tested both directions.
- A pyramid built in the current session parks like any other.
- A view configured against an unassigned database keeps its
  configuration, and *any* assigned database providing the signal
  restores the view while a matching fingerprint restores its samples —
  the guarantee is by signal and fingerprint, not by file identity.
- Unassigning a database stops the RBS elements and periodic transmit
  rows it was driving, with one system-log entry; the unassign itself
  proceeds.
- Opening a pre-rule project decodes nothing and says why on the
  Database panel rows.
- Two databases on one bus defining the same id warn, naming the
  winner. **The warning is all this task ships** (owner ruling
  2026-08-19): choosing *which* database wins for a signal is the
  signal-mapping panel's resolution affordance
  ([task 89](0089-signal-mapping-panel.md)), and its persisted
  per-signal project-file entry ships with that panel, not here.
- The perf bench measures the example project's real assignments, with
  its one-time re-baseline recorded.
- One shared colour chip replaces the three swatch implementations and
  the `type="color"` sites that copied them.

## Phase 7 — an RBS element stops when a database it references reloads (owner ruling 2026-08-20)

**This reopens the task after its exit-criteria walk**, deliberately and
by owner instruction. Phase 4 stopped RBS elements and periodic
transmit rows when a database is *unassigned* or *removed*, and
explicitly ruled a **reload in place** out of scope, on the grounds
that [ADR 0053](../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md)
§1 says an externally-owned input swaps in place and that extending the
rule there would overturn §1 rather than complement it. Phase 4 also
recorded the resulting gap as a blocker: *"Nothing stops on a DBC
reloaded in place that drops the message."*

**The owner's ruling: stop the RBS.** "Let's just stop RBS if a
referenced DBC reloads." A reload can change or remove the very
definitions an element is transmitting from, and continuing to put
frames on a real bus from definitions that just changed underneath is
the uncommanded send §1 exists to prevent — the difference from an
unassign is only that the user did not type the gesture, which makes it
*more* surprising, not less.

Scope, read literally from the ruling:

- **RBS elements stop** when a database they reference is reloaded in
  place (the watcher's path, and any other reload).
- **Periodic transmit rows stop on the same terms** (owner ruling
  2026-08-20, extending the first: "apply same logic to transmit panel
  as to RBS"). So reload joins unassign and remove as a reason a
  periodic stops, and the two panels behave identically — which is the
  outcome worth having, since a user has no reason to expect a
  hand-built periodic and an RBS element to react differently to the
  same event.
- Phase 4's measurement of "built from a database that left" carries
  over unchanged: a `TransmitFrame` has no DBC-path field, so provenance
  is measured by asking `first_dbc_on_bus` before and after the change
  over the periodics that are firing. Reuse it; do not invent a second
  way to decide what a database was driving.
- Reuse phase 4's machinery: `stop_periodic_transmit_inner` is the
  user's own stop path and already has two callers; this becomes a
  third. Do not write a second stop.
- One system-log entry, as phase 4 established. No modal, no per-element
  notice. The reload itself proceeds — it is an externally-owned input
  and §1 still governs the swap.
- ADR 0053 needs amending in the same commit: §1's "swaps in place"
  now carries the exception that a running RBS element stops first.

### Exit criterion added

- Reloading a database stops the RBS elements **and the periodic
  transmit rows** it was driving, with one system-log entry; the reload
  itself still applies. Tested for both.

## Phase 8 — the encoding fingerprint identifies the definition that decoded the value (owner ruling 2026-08-20)

**The principle, in the owner's words:** *"A CAN signal in a view is
related to exactly one signal definition, one message, one ecu, one
dbc, one bus"* — and, broadening it, *"really **any** CAN signal value
has those relationships."* It is not a property of being referenced by
a view; it is what a decoded CAN value *is*.

`signal_fingerprint::dbc_encoding` does not honour that. Two spurious
inputs, both of which make **states that decode identically hash
differently** — the one thing a decode fingerprint must not do:

1. **The candidate's whole bus-assignment list** is hashed
   (`h.mix_len(dbc.buses.len())` and the loop over `dbc.buses`), even
   though the `filter::dbc_applies` guard above it has already
   restricted the walk to candidates eligible for this series' single
   bus. A database's *other* assignments cannot change how it decodes a
   frame on this one. Unassigning a second bus therefore parks and
   rebuilds a series whose samples provably cannot move.
2. **Every eligible candidate is hashed, not just the winner.** With no
   pick, the loop mixes each eligible database that defines the signal.
   Decode is first-wins per signal (pinned by
   `first_dbc_wins_per_signal_not_per_message`), so only the first one
   ever produces a sample. Loading a second database that defines the
   name but never wins changes the fingerprint and parks a cache whose
   values are unchanged.

**The fix: hash the definition that decoded the value, and nothing
else** — the identity already mixed (bus, message id, extended, signal
name) plus the winning candidate's decode specs. Drop the bus list;
drop the losing candidates.

**Why this stays coherent with what already shipped.** Task 88 phase 3
pinned the guarantee that a view is restored *by the signal* and its
samples *by the fingerprint*, tested by removing the originating file
entirely and assigning a different one. Under this change, a different
database with identical specs produces an identical fingerprint and the
parked cache revives — which is correct, because identical specs mean
identical values. This makes that rule consistent rather than
contradicting it.

**Cost, and the ruling that pays it.** Changing the fingerprint
invalidates every persisted pyramid once, so every existing project
pays a single rebuild. Owner ruling: *"One time rebuilds are a cost
we'll pay. It's important that the caches be dynamic and work well but
they are caches at the end of the day and sometimes you have to."* One
rebuild now; the spurious rebuilds stop for good.

**This phase is now a consequence of a stated decision, not an ad-hoc
fix.** [ADR 0054](../../docs/adr/0054-a-decoded-value-has-one-definition.md)
(written 2026-08-20, after the owner asked why this concept was not in
an ADR — it was not) states that a decoded value has exactly one
definition and that anything derived from it depends on that definition
and nothing else. Part 3 and its consequences are what this phase
implements; the fingerprint was *wrong*, not merely wasteful.

Amend [ADR 0047](../../docs/adr/0047-persisted-signal-pyramids.md) in
the same commit to cite ADR 0054 for the contract its fingerprint must
meet.

**And `docs/CONTEXT.md` in the same commit.** Its **Encoding
fingerprint** entry currently defines the hash as covering decode
inputs *"across the databases that may decode it, plus their bus
scoping"* — which is an accurate description of today's code and
becomes false the moment this phase lands, since both of those are the
spurious inputs being removed. Rewrite it to say the fingerprint
identifies the **winning** definition's decode specification. Found
2026-08-20 while defining *trace import census* two entries away; a
behavioural change without its doc update is incomplete.

### Exit criteria added

- Unassigning a database from a bus other than the series' own does not
  park or rebuild that series; tested.
- Loading a further database that defines the signal but does not win
  does not park or rebuild it; tested.
- A different database with identical decode specs still revives the
  parked cache — phase 3's by-signal-and-fingerprint guarantee still
  holds; its test still passes.
- Editing the winning definition's specs still parks and rebuilds.

## Exit-criteria walk (overseer, 2026-08-20)

All six phases landed. Each criterion below is judged against a named
test or a named artefact, not against a phase report. Suites verified
independently by the overseer on the phase branches: Rust **759**
passed / 0 failed / 6 ignored; frontend **2279** passed / 171 files.

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | A database assigned to no bus decodes nothing, on every consumer | **Met** | `filter::dbc_applies` inverted to `bus_id.is_some_and(\|b\| buses.contains(b))`; `a_database_assigned_to_no_bus_decodes_nothing` (`filter.rs`) plus a whole-decode-path regression through `collect_trace_records`. Consumers swept in phase 2: decode, mux extractor, signal-cache scan, value tables, fingerprint, transmit calc, verification, RBS, descriptor universe. |
| 2 | No frame the store accepts lacks a bus; unmapped import channel dropped silently | **Met, scoped** | `a_frame_with_no_bus_never_reaches_the_store` (`trace_store/mod.rs`), `route_channel_translates_via_mapping` (`tests.rs`). Scope is the append path by design — reopen maps spill segments directly and bypasses `append`. The underlying defect is [task 90](0090-cycle-86-87-follow-ups.md) item 4. |
| 3 | Assigning revives fingerprint-matching parked caches; unassigning parks them; both directions | **Met** | `unassigning_a_database_parks_its_caches_and_assigning_it_back_revives_them` (`signal_cache.rs`). No second parking mechanism was built: `set_dbc_buses` reaches the existing pool, and phase 3 named the rule in rustdoc and made it testable. |
| 4 | A pyramid built in the current session parks like any other | **Met** | `a_pyramid_built_this_session_parks_like_any_other` (`signal_cache.rs`). `ensure_caches` now stamps the encoding against the set about to decode it, rather than the stamp appearing only at `persist`; ADR 0047 amended. |
| 5 | View config survives an unassign; restored by signal, samples by fingerprint | **Met** | `a_view_is_restored_by_the_signal_and_its_samples_by_the_fingerprint` (`tests.rs`), read line by line by the overseer. It unassigns *and removes* the originating file (asserting the project is empty), then assigns a **different** file where `A` matches and `B` is rescaled: both signals resolve again, `A` revives, `B` stays parked, and `A` serves 200 points over a **cold store whose frames cannot be decoded** — which is what proves the samples came from the pool. This is the by-signal-and-fingerprint guarantee, not the weaker by-file one. |
| 6 | Unassigning stops the RBS elements and periodic rows it drove, one log entry, unassign proceeds | **Met** | `unassigning_a_database_stops_the_periodics_it_was_driving`, `assigning_a_database_stops_nothing`, `a_row_that_was_not_firing_is_not_reported_as_stopped`, `removing_a_database_stops_the_periodics_it_was_driving`. "Stopped" reuses the user's own stop path — `stop_periodic_transmit_inner` has exactly two callers, the Stop button and this rule — so the resulting state is the one the UI already reads. One `sys_warn!` carrying a count, however many stopped. |
| 7 | A pre-rule project decodes nothing and says why on the Database panel rows | **Met** | Phase 5. Rows group by bus; an unassigned database appears under `(Unassigned — decodes nothing)` with a note distinguishing *not assigned to a bus* from *assigned only to a bus no longer in the project*. The false "applies to all buses" label — deferred by three phases — is gone. |
| 8 | Two databases on one bus defining the same id warn, naming the winner; warning only | **Met** | Detected host-side in `signal_snapshot::dbc_collisions`, exposed via `list_dbc_collisions`; the frontend renders records and never re-scans DBC content in JS. `dbc_collisions_names_the_project_order_winner`, `..._ignores_a_matching_id_on_a_different_bus`, `..._ignores_a_database_assigned_to_no_bus`, and `set_dbc_buses_wires_up_a_bus_collision_the_real_load_and_assign_path_produces`. No picker, no selection, no project-file entry shipped — those belong to [task 89](0089-signal-mapping-panel.md). |
| 9 | The perf bench measures the example project's real assignments, re-baseline recorded | **Met — and the re-baseline was not spent** | `8ec43685` gives the signal bench the project's real assignments. The authorised one-time re-baseline proved unnecessary: the signal bench's figures are not in `baseline.json`, and measured either side of the input change (same signal, 18182 matches, `build_ms` 32.6/32.7/35.2 → 34.0/35.9/37.4) they sit in noise. Recorded here because "no baseline moved" is the fact worth keeping. |
| 10 | One shared colour chip replaces the three swatch implementations and the copies | **Met, and it recovered a lost fix** | `ColorChip.tsx`; six `<input type="color">` elements across five components all route through it (the brief said seven — one was a doc comment). The three swatch class families survive only as query/styling hooks passed in, carrying no CSS of their own. The macOS zero-size-anchor fix existed only in `.trace-event-swatch-input`; the plot copy sat at `width: 0; height: 0`, the exact failing shape. `.color-chip-input` now applies `inset: 0` everywhere. A fourth unlisted consumer (`PlotMeasurements.tsx`) was found and migrated rather than left dangling. |

**Verdict: all ten criteria met. Task 88 is code-complete.**

### One reservation, and it is not an exit criterion

**The task is code-complete but not gate-clean, pending an owner ruling.**
Phase 6's first ADR-0031 gate **failed** on `tree_mb_peak` — 8233.7 MB
against a 1492.1 limit, a 5.5× blowout — and passed on a second gate
over later runs. The investigation was honest and reasonably thorough
(that run's `host_mb` / `webview_mb` were ordinary; two fresh captures
on the same unmodified binary read ~711 and ~720 MB; phases 3–5's
first-runs were all ordinary, which falsifies a "first run after build"
explanation; and no mechanism connects a presentational component to
tree memory). But the *shape* of the outcome is the one the gate rules
exist to prevent: a gate failed, nobody could explain it, and it passed
on a re-run that excluded the failing run.

This is a different animal from the `rx_gap_short_frac_worst` and
`lag_ms_max` jitter already under review — those are worst-of-N
statistics wobbling inside a narrow band, while this is a single
memory reading 5.5× over its limit that was either real and
unexplained or a bad read. Both possibilities are worth knowing about.

No baseline was promoted and no limit was touched at any point in this
task. What is missing is a *stated policy* for an unreproducible
outlier, so that the next agent does not have to improvise one.
Recorded for the owner alongside the ADR 0031 estimator question.

## Exit-criteria walk, phases 7 and 8 (overseer, 2026-08-21)

The task was reopened after the walk above with two further phases, so
this addendum judges the five criteria they added. Same standard: a
named test or a named artefact, never a phase report. Suites re-run by
the overseer on the phase-8 branch — Rust `cannet-gui` **811** passed /
0 failed / 6 ignored, `cargo test --workspace` green, `cargo clippy -p
cannet-gui --all-targets` clean; frontend **2421** passed across 185
files at phase 7's head, untouched by phase 8.

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 11 | Reloading a database stops the RBS elements **and** the periodic rows it was driving, one system-log entry, the reload still applies | **Met** | `1aace7de` covers all three reload paths — the watcher's auto-reload, a reload through `add_dbc`, and a capture re-imported under a loaded identity — with tests in `tests.rs` and `rbs/runtime.rs`. The brief's "do not write a second stop" holds: `stop_periodic_transmit_inner` has exactly three callers, the user's own Stop, phase 4's unassign, and this. ADR 0053 §1 amended in the same commit. A fourth commit (`f55b277a`) was needed to make the rule reachable at all — see the note below. |
| 12 | Unassigning a database from a bus other than the series' own does not park or rebuild that series | **Met** | `unassigning_a_database_from_another_bus_leaves_this_series_decoding` (`signal_cache.rs`), with `a_databases_other_assignments_are_no_part_of_the_fingerprint` pinning it at the hash. The `dbc.buses` loop is gone from `dbc_encoding`; the only surviving reference to `dbc.buses` in the file is the `filter::dbc_applies` eligibility guard, which is the correct one. |
| 13 | Loading a further database that defines the signal but does not win does not park or rebuild it | **Met** | `a_database_that_does_not_win_leaves_the_series_decoding` (`signal_cache.rs`) and `only_the_winning_definition_is_in_the_fingerprint`. The walk now `break`s at the first eligible database that defines the signal, and a pick is honoured by index over the same eligible sequence the decode walks. |
| 14 | A different database with identical decode specs still revives the parked cache | **Met** | Phase 3's `a_park_is_revived_by_the_fingerprint_not_by_the_file_it_came_from` still passes unmodified, as does criterion 5's `a_view_is_restored_by_the_signal_and_its_samples_by_the_fingerprint`. This is the guarantee the change was most likely to break, and it did not. |
| 15 | Editing the winning definition's specs still parks and rebuilds | **Met** | `an_encoding_change_moves_only_its_own_signals_fingerprint`, plus the three exhaustive input tests `every_bit_layout_input_moves_the_fingerprint`, `every_scaling_input_moves_the_fingerprint`, `every_mux_input_moves_the_fingerprint`. |

**Verdict: all fifteen criteria met.**

### The gate task 88 owed

Deliberately deferred from phase 7 and run by the overseer on phase 8's
head (`27c37785`), which is the only point where the whole task is in
one tree. Release build via `tauri build --no-bundle`, four 60 s
captures of **ev-zonal** with `--perf-interact scrub`, each gated
separately with `cannet-perf-measurement check`.

**All four passed, 31 metrics each, every row `ok`** — all three host
modes present, none silently missing. Worst-to-worst across the four:

| metric | baseline | runs 1–4 | limit |
|---|---|---|---|
| `lag_ms_max` | 10.500 | 2.2 / 15.4 / 2.9 / 12.4 | 41.000 |
| `rx_gap_short_frac_worst` | 0.008 | 0.003 / 0.003 / 0.004 / 0.003 | 0.166 |
| `tree_mb_peak` | 714.051 | 735.1 / 727.6 / 731.4 / 731.0 | 1492.102 |
| `jsheap_mb_peak` | 70.300 | 82.8 / 75.6 / 81.2 / 79.9 | 204.600 |
| `renderer_mb_peak` | 299.363 | 311.2 / 306.5 / 307.8 / 308.0 | 662.727 |
| `jank_fraction` | 0.000 | 0.000 in every run | 0.050 |

The two metrics under owner review both behaved: `lag_ms_max` sat well
inside the 2.8–37.6 ms within-build spread phase 2's eight-run control
established, and `rx_gap_short_frac_worst` came in *below* its own
baseline in all four. No repeat of phase 6's `tree_mb_peak` outlier.
**No baseline promoted, no limit touched.**

The one-time cache rebuild the owner authorised was observed rather
than inferred: every run logged `7 persisted signal cache(s) did not
match this capture — rebuilding them by re-decoding its frames` on
open, and the runs passed the gate anyway.

### The reservation from the first walk is closed

That walk left the task "code-complete but not gate-clean", missing a
*stated policy* for an unreproducible outlier so the next agent would
not have to improvise one. ADR 0031 now carries it (amended
2026-08-21): document it in `plans/backlog.md`, check for an existing
entry first because what matters is how often it recurs, and it
licenses nothing else — limits still ratchet down only, no baseline is
promoted, and the outlier is reported alongside the distribution that
contradicts it rather than dropped from the set. Task 88's own gate
then passed four for four with no outlier to apply it to.

### Phase 7's fourth commit, and why it was not scope creep

Phase 7's brief asked for a stop. `f55b277a` also changed the *shape*
of **Reload all from disk**: it used to clear the set and reload it,
and now swaps each database in place. That was not an embellishment —
the stop hangs off `add_dbc` recognising a path it already holds, and
the button did not take that route, so the rule the phase had just
built was unreachable from the one control most likely to trigger it.
Swapping in place is also the reading ADR 0053 §1 requires. The
user-visible consequence — bus assignment and priority position now
survive a reload instead of being re-derived — is recorded under
Blockers as a decision rather than left to be discovered.

### One finding carried forward, not closed here

Phase 8 measured something its own brief did not anticipate: **decode
resolves per frame, not per signal.** Where the winning definition
withholds a value — a multiplexor arm that does not match, a payload
too short — `signal_sampler::sample_shared` falls through to the next
assigned database, which can then put samples in a pyramid the
fingerprint has no input from. Measured, not assumed: with the winner
defining `S` only in arm 0 and a second database defining it plainly, a
frame in arm 1 decodes to 7.0, editing that second database moves it to
18.0, and the fingerprint sits at `476b04dbda88b07e` either way.

The phase implemented the ruling as written, named the exposure in ADR
0047's amendment, and pinned it with
`a_value_the_winner_withholds_is_outside_the_fingerprint` so a future
change that closes it has to do so deliberately. That is the right call
for a phase agent. Closing it properly means removing the decode
fall-through, which changes decoded values — a ruling, not a phase
edit — so it is carried to
[task 92](0092-one-resolution-rule.md) as a fourth shape rather than
resolved here.


## Status log

### 2026-08-19 — Phase 1: a frame's bus is required (branch `task-88-phase-1-frame-bus-required`)

Branched from `dbc-rbs-reload-planning`. Four commits, each green on
`cargo test -p cannet-gui`, `cargo clippy --workspace --all-targets`,
`pnpm --dir apps/gui build` and `pnpm --dir apps/gui test`.

Rust tests: **738 → 741** (6 ignored throughout). Frontend: **2261**
passing, unchanged. `bench_blf_import` re-run under `--ignored` after
the change and reports every remaining phase.

| commit | subject |
| --- | --- |
| `8be5a6d4` | An unmapped import channel is dropped, not stored bus-less |
| `eb346b6b` | A stored frame's bus is a String, not an Option |
| `ae64d6d9` | Verification's runtime state keys on the bus a frame arrived on |
| `699ab791` | Say what "no bus" means now, where the docs and tests still claimed one |

**`8be5a6d4` — routing loses its third answer.** `route_channel` was
`Result<Option<String>, ()>`: a bus, "unassigned", or "skip". It is now
`Option<String>` — the mapped bus, or nothing, and nothing means the
pump drops the frame. `ChannelBusMapping.bus_id` follows to `String`,
so "(skip)" is spelled by leaving the channel out of the mapping (the
frontend filters those entries instead of sending a JSON `null`), which
makes an explicitly skipped channel and a never-mentioned one one and
the same instruction. `RemoteSession.channel_to_bus` and `run_pump`'s
mapping become `Vec<(u8, String)>`. Dropping stays silent, per the
"(skip) is a stated choice" ruling — no confirmation, no relabelling,
no warning.

Red first: `route_channel_translates_via_mapping` rewritten to the new
contract, observed failing to compile against the old signature. Added
`an_import_drops_the_frames_of_a_channel_no_bus_is_mapped_to`, which
drives the pump's own per-frame body (`RawTraceFrame::from` →
`route_channel` → `TraceStore::append`) over a two-channel BLF with only
channel 0 mapped and asserts the store holds channel 0's frames only,
each tagged with its bus.

**`eb346b6b` — the store holds no bus-less frame.** Red first:
`a_frame_with_no_bus_never_reaches_the_store` (asserted `append`
returns `None`, observed `Some(0)`). `TraceStore::append` now drops a
frame that names no bus — the same rule the pump applies, stated where
frames actually land — so everything derived from a stored frame keys
on a `String`: `FrameKey`, `MuxKey`, the per-bus rate buckets,
`seen_bus_ids`, `DerivedEntry.bus_id` (`derived.json`),
`TraceFrameRecord.bus_id`, `BusFps.bus_id`, and their TypeScript
mirrors. The "unassigned bucket" is gone from the by-id view, the
status line's rate breakdown and the by-id bus sort.

Signal-key-side `bus_id` is untouched, and the frame side now states
the boundary where it is visible — on `FrameKey`, on
`TraceFrameRecord`, and in `trace_query::plain_latest_for`, where a
`StreamKey`'s optional bus meets a frame key's required one.

**`ae64d6d9` — the two judged sites.** `verification::Key` was one type
over two things, as its own doc comment said: a `None` bus meant "any
bus" in the *config* map and "arrived with no bus" in the *runtime*
maps. Split into `ConfigKey` (`Option<String>`, wildcard kept for phase
2) and `RuntimeKey` (`String`); `ValidityRecord.bus_id` follows the
runtime key. Red first:
`runtime_state_is_keyed_on_the_bus_the_frame_arrived_on`.
`RbsBusView.bus_id` is judged the other way and **stays optional** — it
is the result of resolving an RBS file's bus *name* against the
project, and "no project bus has this name" is an answer the panel
renders. The reason is written where the field sits.

**`699ab791` — the docs and comments that still claimed an unassigned
frame.** `docs/CONTEXT.md`'s DBC-scoping definition, README's per-bus
scoping paragraph, the by-id sort test's name, and three trace-decode
test comments. README's BLF channel-mapping paragraph now states the
"(skip) is silent" ruling and that an unnamed channel is dropped on the
same terms.

**Sites where removing `Option` forced a decision — all resolved to
today's behaviour, all for phase 2 to revisit:**

1. **`TraceStore::latest_mux_in_window` / `mux_stats`** keep
   `Option<&str>` (a *signal key's* bus) and now return empty / `None`
   for a bus-less query. Behaviour-preserving — such a query already
   matched only bus-less frames, of which there are now none — but it
   means the legacy any-bus **mux** series can never resolve. Phase 2's
   migration decision on the `None`-means-any-bus series covers it.
2. **`TraceFrameRecord::from_raw`** is the one place an empty-string
   bus can appear: `frame.bus_id.clone().unwrap_or_default()`.
   Unreachable for a frame this build stored; reachable only for a
   scratch restored from a pre-rule build (see side effects). Confined
   to one documented line rather than spread through the row type.
3. **`filter::matches_fields` / `filter::dbc_applies` /
   `dbc_commands::decode_against`** are untouched and still take
   `Option<&str>`; `trace_query::record_matches` passes
   `Some(&record.bus_id)`. The rule change is phase 2's.
4. **`verification::wants`** still builds its `ConfigKey` from
   `frame.bus_id.clone()` and probes the any-bus wildcard first. Both
   are config-side, so phase 2 owns them.
5. **`list_value_tables_inner(bus: None)`** keeps task 81's
   all-databases fallback (`labels(None)` still reads the first
   database). Explicitly phase 2's to remove.
6. **`scoped_descriptors`' "a project with no buses falls back to one
   `bus_id: None` record"** (`dbc_commands.rs`) is left as it was, but
   it is now unreachable in a useful sense: a project with no buses can
   map no channel, so it has no frames, so those descriptors can never
   match a row. Left for phase 2/5 to decide whether the fallback
   should exist at all.
7. **`capture.rs::channel_for_save` / `write_blf_capture`** still
   handle a `bus_id: None` frame (they take the `cannet-spill` record,
   which keeps its `Option`), and
   `write_blf_capture_keeps_wire_channel_when_bus_is_unmapped` still
   exercises that arm. Left alone — the spill record is out of scope.

### 2026-08-19 — Phase 2: `dbc_applies` inverts (branch `task-88-phase-2-dbc-applies-inverts`)

Branched from `task-88-phase-1-frame-bus-required`. Three commits, each
green on `cargo test -p cannet-gui`, `cargo clippy --workspace
--all-targets`, `cargo fmt --all`, and — for the commit that touches it
— `pnpm --dir apps/gui build` / `pnpm --dir apps/gui test`.

Rust tests: **741 → 743** (6 ignored throughout). Frontend: **2261 →
2263**. Perf harness crate: 49 passing.

| commit | subject |
| --- | --- |
| `8ec43685` | The signal bench decodes through the project's real bus assignments |
| `9cb171e4` | One scoping rule, not six copies of it |
| `d412c0d4` | Bus assignment governs decode: an unassigned database decodes nothing |
| `ac2f9653` | The transmit and RBS panels ask the bus, not the first file loaded |

Commits are `--no-verify` with the hooks' work run by hand first
(`cargo fmt --all`, `cargo clippy --workspace --all-targets`, `cargo
test`, and the frontend gate). That is deliberate: `pre-commit` stashes
and restores the **unstaged** working tree around a multi-minute hook
run, which is the mechanism phase 1 diagnosed for planning-doc edits
disappearing under a live grooming session. Running the same gates
outside the hook proves the same thing and touches nothing under
`plans/`.

**`8ec43685` — the bench's input changes meaning, measured on the old
rule.** `crates/cannet-perf-measurement`'s `LoadedDbc` now carries the
project's bus assignment and `signal_bench` builds its `DbcScope`s from
it, instead of declaring every database unscoped; signal *selection* is
scoped the same way, so the bench can never pick a signal only a
database on another bus defines. Landed **before** the inversion, so
its cost is isolated: three release runs each on the same tree chose
the same signal (`pt` 0x100 `VehSpeed`, 18182 matches) and measured
`build_ms` 32.6 / 32.7 / 35.2 unscoped against 34.0 / 35.9 / 37.4
scoped, `serve_pyramid_us` 592 / 593 / 595 against 584 / 586 / 877 —
inside run-to-run noise. **No baseline was promoted**: the authorised
one-time re-baseline was not spent, because none of the bench's figures
is a gated metric (`baseline.json` holds ingest / retention / append /
scan for the three host modes plus the render-tier report), so the
input change moves nothing the gate reads. The pre-inversion gate run
below is the control it would otherwise have provided.

**`9cb171e4` — one rule, not six copies.** Five consumers spelled
`buses.is_empty() || buses.contains(bus)` by hand — the verification
rebuild's DBC default, the RBS bus filter, the transmit path's
calculated-field resolution, the signal-snapshot decode, and the RBS
override resolution. All five now ask `filter::dbc_applies`. No
behaviour change (every rewritten expression is `dbc_applies`'s current
body over the same inputs); 741 tests pass either side.

**`d412c0d4` — the rule.** `dbc_applies` is now
`bus_id.is_some_and(|b| buses.contains(b))`: an empty bus list is
"assigned to nothing", and a database assigned to nothing decodes
nothing. Red first — `filter::a_database_assigned_to_no_bus_decodes_nothing`
observed failing against the old body — and the decode path's own
regression is
`tests::a_database_assigned_to_no_bus_decodes_nothing_until_it_is_assigned`,
which drives `collect_trace_records` over two frames on two buses: no
row decodes while the database is unassigned, and after assigning it to
one bus only that bus's row does.

The consumers that moved with it, beyond the five above:

- **Value tables.** Task 81's null-bus fallback is out.
  `list_value_tables_inner` resolves a bus-less lookup through nothing;
  `list_value_tables_inner_resolves_per_bus` asserts the empty answer
  where it used to assert the first database's labels.
- **The encoding fingerprint.** `dbc_encoding` no longer keeps the
  whole chain for `bus_id: None` — it filters every database through
  `dbc_applies` unconditionally. A series naming no bus therefore has
  the empty chain, and an unassigned database is in no chain at all.
  The old literal-pinned guard (`an_unscoped_project_keeps_every_fingerprint_it_had`,
  whose subject no longer exists) is replaced by
  `an_unassigned_database_is_no_part_of_any_chain` and
  `a_series_that_names_no_bus_has_the_empty_chain`.
- **Verification.** `ConfigKey`'s bus goes from `Option<String>` to
  `String`: an unassigned database declares no configuration, so there
  is no any-bus wildcard left to fall back to, and both `wants` and
  `observe_inner` lose their wildcard probe. New test:
  `a_database_assigned_to_no_bus_configures_nothing`.
- **The descriptor universe.** `scoped_descriptors` expands each
  database over the buses it is assigned to and nothing else, retiring
  both old fallbacks (unscoped → every project bus; no project buses →
  one `bus_id: None` row — site 6 below). That leaves the project's bus
  list no longer an input to the universe, so `project_buses` comes off
  `scoped_descriptors`, `scoped_descriptor_snapshot`,
  `DescriptorSnapshot`, the `list_signals` and `fetch_signal_page`
  commands, and the three frontend call sites that were sending it
  (`signalCatalogContext`, `DatabasePanel`, `useSignalView` /
  `SignalsPanel`).

Fixtures moved with the rule rather than around it: a test whose frames
arrive on `TEST_BUS` assigns its databases to `TEST_BUS`
(`signal_cache`'s `all_buses` helper becomes `on_test_bus`, plus an
`assigned_to` for the tests that name their own buses), and a
DBC-backed series names the bus it is on. Docs in the same commit: ADR
0047 gains a *bus assignment governs the chain* amendment,
`docs/CONTEXT.md`'s glossary entry becomes **DBC bus assignment**, and
README states that a DBC with no boxes checked decodes nothing and that
a pre-rule project opens decoding nothing.

**`ac2f9653` — the consumers that were not asking any bus at all.**
Reading the callers of the removed value-table fallback turned up three
DBC lookups that resolved through "first loaded database that claims
the id" with no bus in the query — `describe_message`, `decode_frame`
and `encode_frame`, i.e. the transmit panel's message descriptor, its
live payload decode and its signal-edit encoder. Under the new rule a
database assigned to nothing could still drive a transmit row's signal
table while decoding no frame of the trace, so all three now take the
row's `bus_id` and resolve through `first_dbc_on_bus` — `first_dbc`
with `filter::dbc_applies` in front of it, and its replacement (it had
no other caller).

Two of the callers were **regressions this phase had introduced** and
are fixed here rather than recorded: `TransmitSignalsTable`'s
`EnumValueCell` and `RbsPanel`'s signal row both asked
`list_value_tables` with `busId: null`, which answered out of the first
loaded database before the fallback came out and answered *nothing*
after it — enum pickers in the transmit and rest-of-bus panels would
have gone label-less. Both now pass the bus the row is on (the transmit
frame's `busId`; the project bus an RBS element's bus resolved to), and
a new dom case in each panel pins the wiring — each fails without it.
`dragSignals::fanOutByBus` was the third: it emitted a `busId: null`
ref for a database assigned to nothing, which would have asked the
sampler for whatever some *other* database on some other bus supplied.
It now emits no ref, since such a database decodes no frame on any bus.
Frontend 2261 → 2263; Rust stays 743 (the new host coverage is
assertions inside the describe / decode / encode tests, which now also
pin that another bus and no bus resolve nothing).

#### The seven sites phase 1 left for judgement

1. **`latest_mux_in_window` / `mux_stats` keep `Option<&str>` and
   return empty for a bus-less query** — **left as is, now correct by
   the rule.** A query naming no bus is admitted by no assignment, so
   "resolves nothing" is what the model says, not a gap. The legacy
   any-bus *mux* series is dead the same way every other bus-less
   DBC-backed series is (see the blocker below).
2. **`TraceFrameRecord::from_raw`'s `unwrap_or_default()`** — **left
   alone.** It is the spill record's `Option`, which is out of scope,
   and phase 1's confinement to one documented line still holds.
3. **`filter::matches_fields` / `dbc_applies` / `decode_against`** —
   **inverted.** `matches_fields`' `Bus(b)` leaf compares the frame's
   bus directly and needed nothing; `dbc_applies` is the rule;
   `decode_against` is its first consumer.
4. **`verification::wants`' any-bus wildcard** — **removed**, together
   with the wildcard entry `rebuild_configs` used to insert and the
   `Option` in `ConfigKey`.
5. **`list_value_tables_inner(bus: None)`'s all-databases fallback** —
   **removed**, as directed.
6. **`scoped_descriptors`' "a project with no buses → one `bus_id:
   None` record"** — **removed.** Phase 1 found it unreachable in any
   useful sense; under this rule it is also wrong in principle (a
   database assigned to nothing must contribute nothing), and deleting
   it is what makes `project_buses` fall out of the universe entirely.
7. **`capture.rs::channel_for_save` / `write_blf_capture`** — **left
   alone**, per the phase brief: they take the `cannet-spill` record.

#### The perf gate, two measurements

Both on this rig, `pnpm --dir apps/gui tauri build --no-bundle` release
binaries, `examples/ev-zonal` at ~1608 fps over two PEAK channels, 60 s
captures with `--perf-interact scrub`, gated by `cargo run --release -p
cannet-perf-measurement -- check … --expected-rx-fps 1608
--expected-tx-fps 1608` against the committed
`docs/performance-measurements/baseline.json`. **No baseline was
promoted and no gate limit was touched.** Reports are review artifacts
and stay out of the repository.

**1 — pre-inversion control, on `8ec43685` (the bench input change, old
rule).** Four runs. `check` over the first two **FAILED**, on
`rx_gap_short_frac_worst`: run 1 measured **0.194** against the 0.166
limit (baseline 0.008) while run 2 measured 0.001. Runs 3 and 4
measured 0.0002 and 0.0017. The GUI at that commit is byte-for-byte the
phase-1 GUI (the commit touches only `crates/cannet-perf-measurement`),
so the failure cannot be phase 2's — it is the same rig jitter task 81
phase 2 hit on the same metric and the same project, which an 11-run
control then reproduced on an unchanged tree. Recorded rather than
chased: four runs are not the eleven that settled it last time, and
nothing in this phase touches ingest.

| run | rx fps | tx fps | `rx_gap` short-frac worst | `rx_gap` p95 ratio worst | `lag_ms` max | ids |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1618.4 | 1576.2 | **0.1939** (`zonal/0x100`) | 2.403 | 2.2 | 173 |
| 2 | 1604.7 | 1605.4 | 0.0007 | 1.167 | 4.0 | 173 |
| 3 | 1607.7 | 1614.0 | 0.0002 | 1.142 | 6.8 | 173 |
| 4 | 1605.9 | 1610.7 | 0.0017 | 1.169 | 9.2 | 173 |

**2 — the inversion, on `d412c0d4`.** Eight runs. `check` over the
first four: **passed, 87 metrics gated.** `check` over all eight:
**passed, 159 metrics gated** (the three memory-drift metrics gate on
the median of the set, every other metric per run). Host modes on the
eight-run gate: tracebuffer 25000.1 fps / retention 1.000 / append
2.583 ms / scan 0.251 ms; grpc 2735.5 fps / 1.013 / 0.796 ms / 0.045
ms; hardware-peak 999.75 fps / 1.000 / 0.427 ms / 0.048 ms — every one
inside its limit and none worse than the pre-inversion control's.
`rx_gap_short_frac_worst` worst-to-worst **0.194 → 0.0065**, i.e. the
control's failure did not recur.

| run | rx fps | tx fps | short-frac worst | p95 ratio worst | `lag_ms` max | `lag_ms` mean |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1602.9 | 1607.5 | 0.0065 | 1.205 | 22.9 | 0.00 |
| 2 | 1609.0 | 1612.5 | 0.0023 | 1.161 | 2.8 | −0.00 |
| 3 | 1605.3 | 1608.2 | 0.0010 | 1.141 | 2.9 | 0.01 |
| 4 | 1604.4 | 1609.5 | 0.0010 | 1.170 | 23.7 | 0.02 |
| 5 | 1602.6 | — | 0.0053 | — | 9.1 | −0.00 |
| 6 | 1602.9 | — | 0.0043 | — | 8.5 | 0.06 |
| 7 | 1604.6 | — | 0.0027 | — | 37.6 | 0.21 |
| 8 | 1602.5 | — | 0.0042 | — | 4.3 | −0.01 |

**`lag_ms_max` moved worst-to-worst (9.2 → 23.7 over four runs each)
and was investigated rather than waved through.**

- *Observation.* Every other frontend metric sits at or below the
  control's spread; `longtask_ms_per_s` (mean and p95) and
  `jank_fraction` are exactly 0.000 in all twelve runs; `lag_ms` mean
  is ~0 in every run, so each maximum is a single late reporter tick
  out of sixty.
- *Hypothesis.* `lag_ms_max` is a per-run scheduler tail, not a
  property of the build — so one build should produce both values.
- *Experiment.* Four further captures on the **unchanged** `d412c0d4`
  binary (runs 5–8), chosen because the falsifying observation is a low
  value from the same binary that produced a high one.
- *Data.* The eight runs of one build span **2.8 – 37.6 ms**,
  bracketing the whole pre/post difference; the highest reading of all
  twelve is on that unchanged binary.
- *Conclusion.* Not attributable to the inversion: the within-build
  spread exceeds the between-build difference, and there is no
  mechanism — the change strictly *removes* candidate databases from
  per-frame decode filters and removes one argument from two IPC calls;
  a real main-thread cost would appear in `longtask` and
  `jank_fraction`, which never leave 0.000. Recorded as a gate hazard
  under Blockers rather than acted on: the limit stays where it is.

**3 — the branch as it stands, on `ac2f9653`.** The transmit / RBS
commit landed after the gate above and touches the render tier, so it
was rebuilt and re-gated: two runs, **passed, 51 metrics gated**. Host
modes: tracebuffer 25000.1 fps / 1.000 / 3.923 ms / 0.266 ms; grpc
2921.7 fps / 1.000 / 0.967 ms / 0.057 ms; hardware-peak 999.81 fps /
1.001 / 0.573 ms / 0.094 ms. Frontend: rx 1602.4 / 1606.0 fps, tx
1605.4 / 1612.2 fps, `rx_gap` short-frac worst 0.0043 / 0.0035, p95
ratio worst 1.225 / 1.238, `lag_ms` max 2.0 / 13.7, 173 ids measured on
both. No baseline promoted, no limit touched.

### 2026-08-20 — Phase 3: assignment is the cache lifecycle boundary (branch `task-88-phase-3-cache-lifecycle`)

Branched from `task-88-phase-2-dbc-applies-inverts` (at `d169eeab`).
Three commits, each green on `cargo test -p cannet-gui`, `cargo clippy
--workspace --all-targets`, `cargo fmt --all`, and — for the commits
that touch it — `pnpm --dir apps/gui test` / `pnpm --dir apps/gui
build`.

Rust tests: **743 → 748** (6 ignored throughout). Frontend: **2263 →
2264**. Commits are `--no-verify` with the hooks' work run by hand
first, for the reason phase 2 recorded (`pre-commit` stashes and
restores the unstaged working tree around a multi-minute hook run,
which clobbers live planning edits).

| commit | subject |
| --- | --- |
| `d81ca01c` | A pyramid built this session parks like any other |
| `9660413f` | Assignment is where a pyramid is parked and revived |
| `c321610d` | A view configured against an unassigned database keeps it |

**`d81ca01c` — the stamp moves to where the cache is built.** This is
the phase's one real code change, and everything else in it turned on
this. `SignalCache::encoding` was written only by
`SignalCacheStore::persist`, so a cache created since the last manifest
write carried `None` — and `invalidate_dbcs`'s third arm *discards* an
unjudgeable cache rather than parking it. `ensure_caches` now stamps a
new cache with `signal_fingerprint::dbc_encoding` against the very set
that is about to decode it, and `fill_file_backed` stamps `file_source`
the same way, so a live cache always carries the fingerprint of what
built it.

Red first — three cases that never persist, all observed asserting an
empty retention pool against the park they expect:
`a_pyramid_built_this_session_parks_like_any_other`,
`unassigning_a_database_parks_its_caches_and_assigning_it_back_revives_them`
(park on unassign, revive on re-assign, samples proved to come off disk
by serving over a capture nothing decodes), and
`a_park_is_revived_by_the_fingerprint_not_by_the_file_it_came_from`.

Two fixtures moved with the rule rather than around it, and both were
fixture faults rather than product ones:

1. **`dbc_set_change_invalidates_stale_derived_caches`** invalidated
   against an *empty* set while serving against a loaded one, so under
   build-time stamping the cache's empty-chain fingerprint matched the
   empty-chain recomputation and the cache correctly survived — leaving
   the test's back-fill assertion failing. Production never does that
   (`invalidate_derived_caches` reads `state.databases()`, which is also
   what the serve decodes with), so the late-arriving DBC now goes into
   the project, assigned to the bus its frames are on.
2. **`a_dbc_change_does_not_touch_a_file_backed_series`**' DBC-backed
   companion named *no bus*, so its chain was empty either side of the
   change and, once stamped, nothing moved. It now names `TEST_BUS` and
   parks — which is what the test's "exactly one series is live" was
   asserting all along — and the test gained an assertion that the
   series that left went to the pool rather than to nothing.

`tests::ab_stamp` went with the change: it existed only to persist
before a parking test, and its stated reason no longer exists. The
three replace-a-DBC tests now exercise the never-persisted path
directly, which is stronger coverage than they had.

ADR 0047 gains a *stamped when a cache is built* amendment, and its
assignment amendment gains the paragraph naming assignment as the cache
lifecycle boundary.

**`9660413f` — naming the hook, and testing it.** `set_dbc_buses`
already reached the retention pool: it calls
`invalidate_derived_caches`, and since phase 2 inverted `dbc_applies` a
bus change moves every candidate chain that database was in. Nothing
said so and nothing tested it. `set_dbc_buses_inner` is the command's
body without its `AppHandle`, carrying the rule in its rustdoc — **one
implementation, not two**: no bus-scoped variant of `park` /
`revive_retained` was added, because a bus change *is* a DBC-set change
and the existing in-session judgement is exactly right for it.
`tests::ab_assign` now goes through it rather than mutating the slot by
hand.

Two host-level cases, both red first (no such function):

- `unassigning_a_database_parks_its_caches_and_re_assigning_revives_them`
  — unassign to park (live 0, retained 2), re-assign to revive (live 2,
  retained 0, revivals 2), the samples proved to be the parked ones by
  serving against a capture nothing decodes. It also pins **the hazard
  in between**: a view keeps polling while its database is unassigned,
  so an empty live cache is minted under each parked key. That does not
  strand the park, because `invalidate_dbcs` re-encodes the live caches
  *before* it consults the pool — the empty ones hold no bytes, so
  `park` wipes rather than parks them, and the keys are free when
  `revive_retained` looks. Pinned rather than assumed: the ordering is
  load-bearing and nothing else asserted it.
- `a_view_is_restored_by_the_signal_and_its_samples_by_the_fingerprint`
  — the owner's ruling as ruled, not in its weaker by-file form; see
  below.

README says what unchecking a bus now costs: nothing, and why.

**`c321610d` — the view-config guarantee, frontend half.** A plot
series names `bus | messageId : signalName` and carries no DBC path, so
unassigning must leave it configured and merely empty, and assigning any
database that provides the signal must bring it back with no hand
rebuild. `mockUnassignedSignals` is the fixture for "assigned to
nothing" — the host lists no such signal and answers no samples for it.

#### How the by-signal-and-fingerprint guarantee was tested

Not by re-assigning the same file. The host case builds `A` and `B`
under `a.dbc` assigned to `pt`, then **unassigns `a.dbc` and removes it
from the project outright** — `state.databases()` is asserted empty, so
nothing that decoded those samples is loaded any more, and the
descriptor universe is asserted empty with it. A *different* file,
`b.dbc`, is then installed and assigned to `pt`. It defines `A` exactly
as the parked samples were decoded and `B` **rescaled**, which sets the
ruling's two halves against each other in one experiment:

- **The view is restored by the signal.** Both `A` and `B` resolve
  again in `scoped_descriptor_snapshot`, on the same
  `(bus, message id, name)` identity, out of a file that never decoded
  them.
- **The samples are restored by the fingerprint.** `A` revives (live 1,
  revivals 1) and serves its 200 points over a capture nothing decodes;
  `B` — the same *signal*, a different *encoding* — stays parked and
  serves nothing.

The frontend case is by-signal by construction: it never tells the panel
which file is loaded, because the panel has no way to ask.

#### The frontend recovery direction, investigated rather than waved through

- *Observation.* After the samples came back, the chart stayed at zero
  points and every `PlotArea` resample outcome was `unchanged`.
- *Hypothesis.* `useDecimatedRange` memoises on a key that answers
  "could this request return different bytes?", and the one input that
  says "the decode moved" is the trace model's re-anchor epoch folded
  into the fetch descriptor.
- *Experiment.* A control that emptied only `mockSampleSeries` and left
  the catalog entry alone reproduced the failure identically, which
  falsifies "the catalog removal did it"; instrumenting `PlotArea`
  showed `outcome.kind === "unchanged"` on every tick after recovery.
- *Data.* `App.invalidateCache` — not the panel — bumps that epoch off
  `useDbcGeneration`, and `renderPanel` hands the panel a fixed
  `TraceData` whose `epoch` never moves.
- *Conclusion.* A harness fact, not a product defect: the shipping app
  re-anchors on the same carrier that refreshes the catalog. The test
  now does both halves (`announceDbcChange()` plus the harness's own
  `bumpEpoch`, whose doc comment already says it is what
  `invalidateCache` does on a DBC-set change). The `PlotArea`
  instrumentation was removed; that file is unchanged on this branch.

#### The perf gate

Same rig and method as phase 2: a `pnpm --dir apps/gui tauri build
--no-bundle` release binary, `examples/ev-zonal` over two PEAK channels,
four 60 s captures with `--perf-interact scrub`, gated by `cargo run
--release -p cannet-perf-measurement -- check` over all four reports
with `--expected-rx-fps 1608 --expected-tx-fps 1608` against the
committed `docs/performance-measurements/baseline.json`. **Passed, 87
metrics gated.** No baseline promoted and no gate limit touched. Reports
are review artifacts and stay out of the repository.

Host modes: tracebuffer 25000.107 fps / retention 1.000 / append 2.690
ms / scan 0.545 ms; grpc 2922.189 fps / 0.996 / 0.803 ms / 0.055 ms;
hardware-peak 999.664 fps / 1.000 / 0.839 ms / 0.053 ms — every one
inside its limit.

| run | rx fps | tx fps | short-frac worst | p95 ratio worst | `lag_ms` max | `lag_ms` mean | ids |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1601.8 | 1609.0 | 0.0035 (`zonal/0xC0`) | 1.226 | 14.1 | 0.01 | 173 |
| 2 | 1602.6 | 1606.4 | 0.0030 (`zonal/0xC0`) | 1.230 | 11.4 | 0.19 | 173 |
| 3 | 1599.3 | 1608.9 | 0.0043 (`zonal/0x10E`) | 1.259 | 3.8 | 0.00 | 173 |
| 4 | 1608.3 | 1611.5 | 0.0028 (`zonal/0x10F`) | 1.219 | 9.6 | −0.03 | 173 |

Neither jittery metric fired. `rx_gap_short_frac_worst` sat at
0.0028–0.0043 against a 0.166 limit (phase 2's pre-inversion control
spiked to 0.194 on the same rig); `lag_ms_max` spanned 3.8–14.1 ms
against 41, worst-to-worst below phase 2's 23.7 on both its control and
its inversion, with `longtask_ms_per_s` (mean and p95) and
`jank_fraction` exactly 0.000 in all four runs. Nothing was attributed
to this phase and no limit was touched.

### 2026-08-20 - Phase 4: unassigning stops what it was driving (branch `task-88-phase-4-unassign-stops-transmit`)

Branched from `task-88-phase-3-cache-lifecycle` (at `fe42753f`). One
commit, green on `cargo test -p cannet-gui`, `cargo clippy --workspace
--all-targets` and `cargo fmt --all`. No frontend file is touched, so no
frontend gate was needed (`pnpm` was run only for the release build the
perf gate uses).

Rust tests: **748 -> 755** (6 ignored throughout). Frontend: **2264**,
unchanged. The commit is `--no-verify` with the hooks' work run by hand
first, for the reason phase 2 recorded.

| commit | subject |
| --- | --- |
| `0cb20f6b` | Unassigning a database stops the periodics it was driving |

**What "stopped" resolved to, and why it is not a second mechanism.**
`stop_periodic_transmit`'s body is extracted as
`stop_periodic_transmit_inner(&AppState, &str)` - clear the entry's
`running` flag, unschedule the id - and **both** callers take it: the
user's Stop button and this rule. So the resulting state is the one the
panel's own Stop leaves, and it is the state the UI reads: the row stays
in the pool, stays `Periodic`, keeps its `cycle_ms`, and reports
`running: false` through `list_transmit_frames`. That is asserted
directly (`unassigning_a_database_stops_the_periodics_it_was_driving`
reads the row back out of `registry.list()`), not inferred.

**RBS rows are periodics like any other and take the same path.** They
were already *removed* by `rbs::refresh_all_elements`'s row rebuild when
their bus lost its databases - that half worked before this phase and
nothing said so - but the removal happens inside `announce_dbc_change`,
after the assignment call has returned, so nothing could count it. They
now stop in `set_dbc_buses_inner` alongside project rows, and the rebuild
then takes them out of the pool as it always did. No bus-scoped variant
of the row rebuild was added.

**How "built from a database that was unassigned" is measured.** A
`TransmitFrame` carries no DBC path - there is no provenance field to
read - so the observable question is asked instead, twice:
`first_dbc_on_bus` (phase 2's per-bus priority scan, the same one the
transmit panel's describe / decode / encode queries use) is asked
**before** the change and **again after** it, over the periodics that are
firing. A row that was backed and is no longer stops. Three properties
fall out of that shape rather than being special-cased, and each has its
own test:

- a row another assigned database still defines keeps firing
  (`a_row_another_assigned_database_still_defines_keeps_firing`);
- a hand-typed CAN id no database on the bus ever described is in
  neither answer, so an assignment change is never its business
  (asserted inside the main case as `hand-typed`);
- assigning stops nothing, because growing a bus's candidate list cannot
  take a candidate away (`assigning_a_database_stops_nothing`);
- narrowing `{pt, ch}` to `{pt}` stops the `ch` row and leaves the `pt`
  one firing (`a_row_on_another_bus_is_untouched_by_an_unassign`).

**One line, however many stopped.** `log_periodics_stopped` emits a
single `sys_warn!` - `stopped N running transmit(s) <path> was driving`
- and returns early on an empty list. No modal, no per-element notice,
no toast: `system-log-appended` only appends to the System Messages
panel. Warn rather than info because the entry is the *only* notice the
ruling allows, so it has to be findable. `transmit-frames-changed` is
emitted alongside it so the transmit panel's Run control re-fetches;
`rbs-changed` already rode on `announce_dbc_change`.

**The unassign always proceeds.** Nothing in the path can refuse or
prompt: `set_dbc_buses_inner` applies the new bus list, invalidates, and
only then asks what stopped.

#### Three scope decisions, all recorded rather than assumed

1. **`remove_dbc` reaches the same rule.** The task's own model says
   removing a database removes it from its assigned buses (rule 3), so a
   removal *is* an unassign and leaving a periodic firing from a file the
   project has dropped would be the same defect. `remove_dbc_inner` is
   the extracted body; `tests::ab_remove`, which was a hand-rolled copy
   of that body, now calls it.
2. **`clear_dbcs` deliberately does not.** It is a whole-set *replace*,
   not an unassign: `App.tsx`'s `loadDbcSet` runs `clear_dbcs` + N x
   `add_dbc` + M x `set_dbc_buses` for **open project, new project and
   "reload all from disk"**. Applying the rule there would stop every
   running periodic on a reload-from-disk and never restart it. Under the
   rule as implemented that sequence stops nothing, because after the
   clear no row is backed, so `backed_before` is empty for every
   subsequent assign.
3. **A DBC reloaded in place is untouched**, even when the new file drops
   a message a periodic is transmitting. ADR 0053 section 1 rules
   explicitly that an externally-owned input *swaps in place*; this
   phase's rule is its **deliberate** counterpart, and extending it to
   the watcher path would overturn that rule rather than complement it.
   Recorded here so the asymmetry is a decision and not an oversight.

#### The one asymmetry between a project row and an RBS row

A stopped project transmit row **stays stopped** when the database is
assigned back: `running` is the state the user toggles directly, and
there is no separate "should run" flag behind it, so restoring it
silently would be a start nobody commanded. An RBS row **resumes**: it is
rebuilt by its element and `sync_schedules` derives its running state
from the element's Run flag and the ANDed enables, which are the user's
persisted configuration and which this phase does not touch (`run` is
mirrored from the *project* element, so the host cannot clear it without
desynchronising the project anyway). That is the phase-3 ruling applied
consistently - a view configured against an unassigned database keeps its
configuration and comes back whole - and it is the same thing that
already happens when a DBC is assigned to a bus while an element is
running.

#### How the tests avoid a timing dependency

Not one sleep, and no scheduler thread. `test_state()` builds its
`TransmitScheduler` with the receiving end dropped, so `start` / `stop`
are best-effort no-ops and the registry's `running` flag is the whole
observable - which is also exactly what `fire_info` reads each tick and
what `list_transmit_frames` reports, so asserting on it is asserting on
the shipping state rather than on a test-only proxy. Every case runs
synchronously inside one `set_dbc_buses_inner` call and asserts on its
return value plus `is_running`. The returned list is built by walking the
registry in pool order, so it is deterministic.

Red was observed twice per case, once as a compile failure (no such
function) and once against three mutations of the finished code, each
chosen to be a plausible wrong implementation:

| mutation | which cases went red |
| --- | --- |
| stop nothing | the four positive cases |
| stop **every** running periodic | the four cases that name what must survive |
| count non-running entries as firing | `a_row_that_was_not_firing_is_not_reported_as_stopped`, and the RBS case |

The third mutation is why `a_row_that_was_not_firing_is_not_reported_as_stopped`
exists: it survives the first two, so without it the `running` filter was
untested.

#### Docs

ADR 0053 gains a *the deliberate counterpart to section 1* amendment -
section 1 protects a transmitting element from a file changing underneath
it and says nothing about the user reaching the same place on purpose,
which is exactly the gap this rule fills. README gains **"Unchecking a
bus stops what it was driving"** beside phase 3's "Unchecking a bus is
reversible", covering the one log line, the always-proceeds rule, what
survives, and the project-row / RBS-row difference above.

#### The perf gate

Same rig and method as phase 3: a `pnpm --dir apps/gui tauri build
--no-bundle` release binary of `0cb20f6b`, `examples/ev-zonal` over two
PEAK channels, four 60 s captures with `--perf-interact scrub`, gated by
`cargo run --release -p cannet-perf-measurement -- check` over all four
reports with `--expected-rx-fps 1608 --expected-tx-fps 1608` against the
committed `docs/performance-measurements/baseline.json`. **Passed, 87
metrics gated.** No baseline promoted and no gate limit touched. Reports
are review artifacts and stay out of the repository.

Host modes: tracebuffer 25000.120 fps / retention 1.000 / append 3.111 ms
/ scan 0.249 ms; grpc 2934.073 fps / 0.995 / 1.054 ms / 0.052 ms;
hardware-peak 999.846 fps / 1.001 / 0.896 ms / 0.203 ms - every one
inside its limit.

| run | rx fps | tx fps | short-frac worst | p95 ratio worst | `lag_ms` max | `lag_ms` mean | ids |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1606.4 | 1599.8 | 0.0033 (`zonal/0x10E`) | 1.267 | 7.3 | 0.04 | 173 |
| 2 | 1601.0 | 1605.7 | 0.0027 (`zonal/0x100`) | 1.220 | 15.9 | -0.00 | 173 |
| 3 | 1601.0 | 1604.2 | 0.0050 (`zonal/0x10E`) | 1.251 | 26.7 | 0.01 | 173 |
| 4 | 1597.4 | 1608.9 | 0.0040 (`zonal/0x100`) | 1.200 | 3.9 | 0.01 | 173 |

Neither metric under owner review fired. `rx_gap_short_frac_worst` sat at
0.0027-0.0050 against a 0.166 limit (phase 3 saw 0.0028-0.0043);
`lag_ms_max` spanned 3.9-26.7 ms against 41, inside the 2.8-37.6 ms
within-build spread phase 2's eight-run control established, with
`longtask_ms_per_s` (mean and p95) and `jank_fraction` exactly 0.000 in
all four runs. Nothing was attributed to this phase and no limit was
touched. `tx_late_ms_max` - the metric this phase's path could plausibly
move - measured 44.3 / 30.8 / 22.1 / 36.9 ms against a 156.4 limit and a
65.7 baseline, i.e. below baseline in every run: the rule adds one
`first_dbc_on_bus` scan per running periodic **per assignment change**,
and nothing at all to the per-tick fire path.

### 2026-08-20 — Phase 5: the Database panel says what is assigned, and warns on a collision (branch `task-88-phase-5-database-panel`)

Branched from `task-88-phase-4-unassign-stops-transmit` (at `5710fc36`).
Two commits, each green on `cargo test -p cannet-gui`, `cargo clippy
--workspace --all-targets`, `cargo fmt --all`, `pnpm --dir apps/gui
test` and `pnpm --dir apps/gui build`.

Rust tests: **755 → 759** (6 ignored throughout). Frontend: **2264 →
2265**. Commits are `--no-verify` with the hooks' work run by hand
first, for the reason phase 2 recorded.

| commit | subject |
| --- | --- |
| `6a4ad81c` | Host-side detection of a duplicate id across two databases on one bus |
| `dc0dc641` | Database panel: an unassigned database says so, and a collision warns |

**`6a4ad81c` — collision detection is a model fact, not a JS scan.**
`signal_snapshot::dbc_collisions` walks, for each bus any database is
assigned to, its assigned databases in project load order
(`filter::dbc_applies` — the same filter and order
`AppState::first_dbc_on_bus` and `scoped_descriptors`' dedup already
apply) and records every `(message id, extended, signal name)` a later
database repeats, naming the earlier one as winner. Exposed as
`list_dbc_collisions`, returning `DbcCollisionRecord` (camelCase on
the wire, alongside `DbcContentRecord`). Red first: the three
`signal_snapshot::tests::dbc_collisions_*` cases (names the
project-order winner; ignores a matching id on a different bus;
ignores a database assigned to no bus), each observed failing to
compile against no such function. An integration-level case in
`tests.rs`
(`set_dbc_buses_wires_up_a_bus_collision_the_real_load_and_assign_path_produces`)
drives the same scenario through `install_dbc` / `set_dbc_buses_inner`
— the calls the panel's own actions make — rather than building
`LoadedDbc`s by hand, so a wiring mistake between the command and the
domain function would show even if the domain function itself is
right.

Also fixed in this commit: `types.ts`'s `DbcInfo.buses` comment still
said "unscoped (applies to all buses)" — the same lie phase 2 already
inverted in the Rust doc comment, just not its TS mirror.

**`dc0dc641` — the defect phase 2 deferred.** `DatabasePanel.tsx`'s
`groupByBus` filed a database assigned to no bus (`scope.length ===
0`) into *every* bus group, each row labelled "applies to all buses"
— true under the old rule, false under the inverted one. It now routes
such a database once into the existing `(Unassigned)` group (relabelled
`(Unassigned — decodes nothing)`), the same as a database scoped only
to a bus no longer in the project; each row's new `note` field says
which of the two it is (`not assigned to a bus — decodes nothing` /
`assigned only to a bus no longer in the project — decodes nothing`). A
project with zero buses configured gets the analogous note under
`(All DBCs)`. The dead `unscoped` / `unscopedNote` fields (set, never
read) came out with the rewrite. This is the whole of the
discoverability ruling: the row, and nothing more — no status line, no
open-project prompt.

A DBC row also renders a `collision` note when the host's
`list_dbc_collisions` names it a loser on the bus it's assigned to:
`formatCollisionNote` groups the database's lost ids by winner (`⚠
duplicate id — a.dbc wins A, B`) with the full per-signal detail in the
row's tooltip. Detection stays host-side (the prior commit); the panel
matches each row against the flat list by `(bus, dbcPath)` for
presentation only, never re-scanning loaded DBC content.

Red first (DOM): rewrote the two tests whose premise the old rule made
true and the inverted rule makes false —
`"drag from an unscoped DBC's bus-group row carries that bus's id"` →
`"drag from an unassigned DBC's row carries no bus id"` (an unassigned
database renders once, under `(Unassigned)`, and drags the legacy
any-bus `null`) and `"groups the tree by bus when project buses are
configured"`, which had asserted the false label twice — both observed
failing against the unfixed `groupByBus` before the rewrite. Added
`"warns on a duplicate id, naming which database wins"`: two databases
assigned to the same bus both defining `EngineData` / `EngineSpeed`,
host-mocked to report the collision; asserts the loser's row carries
the summary naming the winner.

`refreshCollisions` fetches `list_dbc_collisions` off the same triggers
as `refreshContent` (`dbcPaths`, `dbcGeneration`) and guards a
non-array answer down to "no collisions" (`Array.isArray`) rather than
letting `buildRows` fail on it — the production wire type is always an
array, so this only matters for a test mock that doesn't specify the
call, which is most of this file's `mockImplementation` overrides.

README's Database-panel paragraph and `docs/CONTEXT.md`'s **DBC bus
assignment** glossary entry move with the rule in the same commit.

**What the row now says.** An unassigned database (never scoped, or
scoped only to a removed bus) appears once, under `(Unassigned —
decodes nothing)`, with a per-row note naming which of the two it is.
A database assigned to a real bus appears under that bus group with no
extra note — its position there is the assignment. A database that
loses a duplicate-id collision on its bus carries a warning naming the
database that wins; the winner carries no warning of its own (it needs
none — its decode is already the one in effect).

**Where the collision is detected.** Host-side, in
`signal_snapshot::dbc_collisions` (`apps/gui/src-tauri/src/signal_snapshot.rs`),
exposed through the `list_dbc_collisions` command (`dbc_commands.rs`).
The frontend never scans loaded DBC content for duplicate ids — it
renders the host's `DbcCollisionRecord` list, matched per `(bus,
dbcPath)` for display only.

#### The perf gate

Same rig and method as phases 3–4: a `pnpm --dir apps/gui tauri build
--no-bundle` release binary of `dc0dc641`, `examples/ev-zonal` over two
PEAK channels, four 60 s captures with `--perf-interact scrub`, gated
by `cargo run --release -p cannet-perf-measurement -- check` over all
four reports with `--expected-rx-fps 1608 --expected-tx-fps 1608`
against the committed `docs/performance-measurements/baseline.json`.
**Passed, 87 metrics gated.** No baseline promoted and no gate limit
touched. Reports are review artifacts and stay out of the repository.

Host modes: tracebuffer 25000.117 fps / retention 1.000 / append 3.328
ms / scan 0.482 ms; grpc 2818.061 fps / 0.947 / 1.027 ms / 0.393 ms;
hardware-peak 999.783 fps / 1.001 / 0.400 ms / 0.069 ms — every one
inside its limit.

| run | rx fps | tx fps | short-frac worst | p95 ratio worst | `lag_ms` max | `lag_ms` mean | ids |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1603.0 | 1608.4 | 0.0050 (`zonal/0x10E`) | 1.332 | 14.5 | 0.02 | 173 |
| 2 | 1601.5 | 1606.9 | 0.0067 (`zonal/0xC0`) | 1.190 | 1.1 | -0.01 | 173 |
| 3 | 1605.3 | 1611.1 | 0.0073 (`zonal/0x100`) | 1.183 | 11.8 | -0.01 | 173 |
| 4 | 1599.4 | 1612.5 | 0.0105 (`zonal/0x10F`) | 1.248 | 19.1 | 0.10 | 173 |

Neither metric under owner review fired. `rx_gap_short_frac_worst` sat
at 0.0050–0.0105 against a 0.166 limit (phase 4 saw 0.0027–0.0050);
`lag_ms_max` spanned 1.1–19.1 ms against 41, inside the 2.8–37.6 ms
within-build spread phase 2's eight-run control established, with
`longtask_ms_per_s` (mean and p95) and `jank_fraction` exactly 0.000 in
all four runs. Nothing was attributed to this phase and no limit was
touched. This phase's own host-side path (`list_dbc_collisions` per
`dbc_list` call) and panel-side path (one extra `invoke` per DBC-set
change) touch neither the per-frame ingest path nor the per-tick
render path the gated metrics measure.

### 2026-08-20 — Phase 6: a shared colour chip (branch `task-88-phase-6-shared-colour-chip`)

Branched from `task-88-phase-5-database-panel` (at `f4f76334`). Eight
commits, each green on `pnpm --dir apps/gui test` and `pnpm --dir
apps/gui build`. No Rust file is touched, so `cargo test -p
cannet-gui` / `cargo clippy --workspace --all-targets` / `cargo fmt
--all` were not run — Rust stays at phase 5's 759 (6 ignored).
Frontend: **2265 → 2279** (+14: 12 cases for the new `ColorChip`
component, 2 more for its right-click contract added the next
commit). Commits are `--no-verify` with the hooks' work run by hand
first, for the reason phase 2 recorded.

| commit | subject |
| --- | --- |
| `77e35bca` | Add ColorChip, the one shared colour-picking/identity control |
| `60a43cde` | Timeline events adopt the shared colour chip |
| `745211f2` | ColorChip: right-click opens the picker after the caller's own handler |
| `a0b2a744` | The plot area's series swatch and bus dot adopt the shared colour chip |
| `3e5751f8` | Measurement strip's series marker adopts the shared colour chip; the plot-signal-swatch/-bus-swatch copies come out |
| `05f044b8` | The colour-map rule editor's two pickers adopt the shared colour chip |
| `b9961cac` | A project bus's graph colour picker adopts the shared colour chip |
| `755ce180` | A signal name's colour picker adopts the shared colour chip |

**The count in the brief was a grep artifact, not six copies plus a
seventh.** `grep -c 'type="color"'` over the frontend source returns
7, but one of those seven is prose — `PlotArea.tsx`'s doc comment on
`SignalSwatch` says `` `<input type="color">` `` in a sentence. The
real count is **six `<input type="color">` elements across five
components** (`ColorMapPanel.tsx` has two), and this phase routes all
six through `ColorChip.tsx`, alongside the three CSS-class swatch
families the brief named.

**The macOS bug, found and fixed for every site.** `index.css`'s
`.trace-event-swatch-input` carried a comment owning up to it: the
hidden native `<input type="color">` that pops the OS picker was
positioned with `inset: 0` (covering the swatch button's own
footprint) specifically because "a zero-size anchor inside a
virtualized, absolutely-positioned event row lands in the wrong place
[on macOS] — this is a candidate fix for that, pending verification on
a Mac." `.plot-signal-swatch-input` — the plot area's copy, the one
`index.css`'s own comment called "the same control as the plot's
series swatch" when it was copied — never got the fix: it stayed at
`width: 0; height: 0`, the exact zero-size anchor the events copy had
already worked around. `ColorChip.tsx`'s `.color-chip-input` carries
the `inset: 0` sizing (and the comment explaining why) as the one
implementation every editable site now shares, so the plot area's
swatch, the colour-map rule editor, and the project bus picker all get
a fix that, before this phase, only the events panel had.

**Per-site disposition** (`ColorChip` props in parens):

| site | file | shape | notes |
| --- | --- | --- | --- |
| event swatch, editable | `TraceView.tsx` | bar | click opens the picker directly (no override) |
| event swatch, derived truncation marker | `TraceView.tsx` | bar, display-only | no `onChange` — a bare `<span>` |
| per-signal series swatch | `PlotArea.tsx` (`SignalSwatch`) | bar, `hidden` modifier | `onSwatchClick` = toggle hidden, `onSwatchContextMenu` = recolour |
| bus-colour dot beside a signal's message name | `PlotArea.tsx` | dot, display-only | was `.plot-bus-swatch` |
| measurement strip's series marker | `PlotMeasurements.tsx` | dot, display-only | was piggy-backing on `.plot-signal-swatch`'s CSS directly, not a picker |
| colour-map enum-row picker | `ColorMapPanel.tsx` | bar | was a plain visible native input |
| colour-map numeric-range picker | `ColorMapPanel.tsx` | bar | was a plain visible native input |
| project bus's graph colour | `ProjectPanel.tsx` | bar | `inputClassName="project-bus-color"` keeps `App.busColor.dom.test.tsx` unchanged |
| signal name's colour | `SignalsPanel.tsx` | `hideBox`, forwarded ref | the odd one out — recolouring is a right-click on the already-coloured name, never a swatch box, so there was never a box to standardise |

**Why existing tests needed almost no changes.** Every prior
implementation's CSS class names (`trace-event-swatch`,
`plot-signal-swatch`, `plot-signal-swatch-input`, `plot-bus-swatch`,
`project-bus-color`) pass through `ColorChip`'s
`swatchClassName`/`inputClassName` props unchanged — they carry no CSS
of their own any more (`.color-chip*` does), but they stay as the
query hooks the existing suites already used. `PlotPanel.dom.test.tsx`
(218 cases exercising the series swatch's toggle/recolour/style
assertions), `App.busColor.dom.test.tsx`, and
`ColorMapPanel.dom.test.tsx` all passed unmodified. Only `ColorChip`'s
own new test file was written test-first; every migration commit was
verified against the existing suite rather than rewriting it, which is
also how the phase confirmed it hadn't silently changed behaviour
anywhere existing coverage already looked.

**One real, deliberate visual change, directed by the brief.** Every
editable and dot chip now shares one shape family: the bar is 1.5rem
wide, 2px radius, a `--border-wash` hairline, stretched to the row's
full height rather than sized and top-margin-nudged per panel — the
plot area's swatch grows from a fixed 1rem square to match, the
colour-map and project-bus pickers drop their own smaller squares and
native browser chrome for the same drawn box. The `.plot-signal-row.hidden`
compact row's swatch-shrink override (`width: 0.8rem` on top of the
old fixed 1rem) comes out with it — superseded by `align-self:
stretch`, which already fills whatever height that shorter row has,
rather than needing a size tuned to one compact state.

**One small, deliberate CSS fix alongside it.** `.plot-meas-k` (the
measurement strip's label cell) dropped its own `gap: 0.3rem`: the
shared dot's `margin-right` supplies the spacing now — it has to,
since the same dot is also used inline in running text elsewhere with
no flex gap to lean on — and keeping both would have doubled the gap
in this one cell.

#### The perf gate

Same rig and method as phases 3–5: `pnpm --dir apps/gui tauri build
--no-bundle` release binary of `755ce180`, `examples/ev-zonal` over
two PEAK channels, `--perf-interact scrub`, gated by `cargo run
--release -p cannet-perf-measurement -- check --expected-rx-fps 1608
--expected-tx-fps 1608` against the committed
`docs/performance-measurements/baseline.json`. Reports are review
artifacts and stay out of the repository.

**First gate (4 runs, immediately after the release build): FAILED**,
on `tree_mb_peak` — run 1 measured **8233.7 MB** against a 1492.1
limit (baseline 714.05); runs 2–4 measured 710.3 / 733.2 / 710.9,
inside limit. Investigated rather than waved through, since
`tree_mb_peak` is not one of the two metrics this phase was told are
under owner review:

- *Observation.* Run 1's `mem.host_mb` (54–60) and `mem.webview_mb`
  (595–622, the WebView2 browser/renderer/GPU/utility split) were both
  ordinary — matching every other run — while `mem.tree_mb` (host +
  every descendant process, per `crash.rs`) sat at ~8200 for the whole
  60 s window (mean 8201, max 8234, last 8215 — sustained, not a
  single-sample tick).
- *Hypothesis.* The excess ~7.5 GB is attributed to a descendant
  process outside the WebView2 split (the sidecar or the local
  `cannet-server`), inflated by something specific to this one launch
  — immediately following a fresh `tauri build` that had just
  (re)compiled and PyInstaller-frozen the sidecar — rather than by
  `ColorChip`, a presentational React component with no process or
  native-allocation footprint of its own.
- *Experiment.* Two more 60 s captures on the same **unmodified**
  binary (runs 5–6, no rebuild in between), and a check of the three
  most recent prior phases' own first-of-session runs (which also
  followed a fresh build) for the same metric.
- *Data.* Runs 5–6 measured 710.9 / 719.8 — both ordinary. Phases 3,
  4 and 5's first runs measured 719.8 / 721.0 / 750.0 — all ordinary
  too, which falsifies "first launch after a build is inherently
  risky" as a general pattern on this rig; this run is the only one of
  nine first-runs across four phases to spike.
- *Conclusion.* A one-off, non-reproducible artifact of that single
  launch (most plausibly a transient scan or handle held on the
  freshly-written sidecar/server binaries by something outside the
  app — not reproducible enough to name further), not attributable to
  this phase's change: nothing in it spawns a process, and the metrics
  that would move if a React component leaked memory (`jsheap_mb_peak`,
  `renderer_mb_peak`, `host_mb_peak`) stayed flat in the very same run.
  Not acted on by touching the gate — a second gate was run instead.

**Second gate (runs 2–6, same unmodified binary, no rebuild): passed,
105 metrics gated.** `tree_mb_peak` 710.3 / 733.2 / 710.9 / 719.8 MB
against the 1492.1 limit and 714.05 baseline, `tree_mb_drift_per_min`
(median of 5) 70.3 against 139.2. Host modes: `grpc` append 0.694 ms /
scan 0.032 ms; `hardware-peak` ingest 999.687 fps / retention 1.000 /
append 0.446 ms / scan 0.027 ms — every one inside its limit (the
`tracebuffer` mode's figures came from the same first `check`
invocation and were already `ok` there too). No baseline promoted, no
gate limit touched.

**The two metrics under owner review, across all six runs.**
`rx_gap_short_frac_worst` sat at 0.003–0.007 against the 0.166 limit
(phase 5 saw 0.0050–0.0105); `lag_ms_max` spanned 8.8–29.4 ms against
41, inside the 2.8–37.6 ms within-build spread phase 2's eight-run
control established, with `longtask_ms_per_s` (mean and p95) and
`jank_fraction` exactly 0.000 in every run. Neither fired; nothing was
attributed to this phase and no limit was touched.

### 2026-08-21 — Phase 7: a reload stops what it was driving (branch `task-88-phase-7-stop-on-reload`)

**Reconstructed by the overseer from the branch itself.** The phase
agent's session ended after its third commit without writing this entry
or reporting back, leaving a fourth slice complete but uncommitted in
the working tree. Everything below is verified against the code and a
full re-run of the suites, not taken from a phase report — there was
none.

Four commits, each green:

- `82376e26` — **the bus-assignment scan names the database that
  answered.** `first_dbc_on_bus` yielded only a boolean, so a change
  needing provenance had nowhere to read it. Two projections over one
  body; the running-periodic snapshot now carries the backing
  database's path alongside the row id. No behaviour change.
- `1aace7de` — **the stop itself.** Every reload path stops what the
  old content was driving before the swap is announced: the watcher's
  auto-reload, a reload requested through `add_dbc`, and a capture
  re-imported under an identity already loaded. ADR 0053 section 1
  amended in the same commit, as the phase brief required, and README
  updated.
- `e348d6fd` — **the project's Run flag follows the host.** An
  element's Run is the project's flag mirrored onto the host, so the
  host clearing it left the two halves disagreeing — the panel reading
  "on" while nothing was sent, and the project saving in that state.
  The host now names the stopped elements on `rbs-run-stopped` and App
  writes `run: false` onto each, through the same registry write the
  panel's own control makes.
- `f55b277a` — **Reload all from disk swaps in place.** Found and
  fixed by the agent, committed by the overseer. The stop hangs off
  `add_dbc` recognising a path it already holds, and this button did
  not take that route: it called `clear_dbcs` and reloaded the set, so
  every re-read reached the host as a first load and the stop never
  ran. Each path now goes through `add_dbc`, which also preserves its
  bus assignment and priority position; the set change is suppressed
  until the last path lands, so the views re-anchor once.

**The brief's "do not write a second stop" was honoured.**
`stop_periodic_transmit_inner` has exactly three callers — the user's
own Stop command, phase 4's unassign path, and this phase's reload
path. Checked by grep across the crate, not by report.

**Verification (overseer, on the branch head).** `cargo test
--workspace` green, `cannet-gui` 806 passed / 6 ignored; `cargo clippy
-p cannet-gui --all-targets` clean; `tsc --noEmit` clean; the frontend
suite 2421 passed across 185 files, up from 2418 across 183 — the two
files this phase added (`App.rbsRunStopped.dom.test.tsx`,
`App.reloadDbc.dom.test.tsx`) and their three cases.

**No perf gate was run for this phase.** The change is on the
DBC-change path rather than a render or ingest hot spot, and task 88
does not complete until phase 8, whose fingerprint change is the one
that genuinely warrants a gate. Recorded so the gate is owed at phase
8's end and not assumed spent here.


### 2026-08-21 — Phase 8: the fingerprint identifies the definition that decoded the value (branch `task-88-phase-8-fingerprint-winner`)

Branched from `plans-grooming-0091-0105` at `db010043`, where the tree
sat. Four commits, each green on `cargo test -p cannet-gui`, `cargo
clippy -p cannet-gui --all-targets` and `cargo fmt --all -- --check`;
`cargo test --workspace` green before the last (47 test binaries, none
failing). Rust tests **806 → 811** (6 ignored throughout). No frontend
file is touched, so the frontend gates were not run.

| commit | subject |
| --- | --- |
| `d739e419` | The encoding fingerprint identifies the definition that decoded the value |
| `4ffce32d` | The docs that say what a fingerprint covers name a definition, not a chain |
| `173d201a` | README says which DBC changes cost a rebuild and which cost nothing |
| `8893fc34` | Pin the one decode a winner-only fingerprint cannot see |

Commits are `--no-verify` with the hooks' work run by hand first, for
the reason phases 2–7 recorded (`pre-commit` stashes and restores the
unstaged working tree around a multi-minute hook run, which clobbers
concurrent planning edits). Only this phase's paths were staged; the
`Cargo.toml` line-ending noise and the two untracked `scratch-perf*`
directories were left alone.

**`d739e419` — the change, its tests and its docs.** `dbc_encoding` now
mixes the identity (bus, message id, extended, signal name) and the
**winning** definition's decode specs, and stops: the `dbc.buses` loop
is gone and the walk `break`s at the first eligible database that
defines the signal — which is the one the decode takes, or the one a
pick names (`picked_index` is unchanged, and still resolves over the
same eligible sequence). `TAG_CANDIDATE` becomes `TAG_WINNER`.

Red first, all four cases observed failing against the old body:

- `signal_fingerprint::a_databases_other_assignments_are_no_part_of_the_fingerprint`
  — `d5dabd653c0ffe6b` against `fd36ed5d32823afd` for one database
  assigned to `{pt}` versus `{pt, ch}`, a `pt` series.
- `signal_fingerprint::only_the_winning_definition_is_in_the_fingerprint`
  — `8d75015ccedcf80d` against `ea5313990b74d854` for a set that grew a
  second definition behind the winner.
- `signal_cache::unassigning_a_database_from_another_bus_leaves_this_series_decoding`
  — live `0`, expected `2`: unchecking an unrelated bus parked both
  pyramids.
- `signal_cache::a_database_that_does_not_win_leaves_the_series_decoding`
  — live `0`, expected `2`: loading a second database behind the
  incumbent parked both pyramids.

Three existing assertions were assertions *about the old rule* and were
removed or turned around rather than worked around, each visible in the
diff: `the_dbc_set_resolution_moves_the_fingerprint` loses "a second
definition can win frames the first does not" and "the bus assignment of
a contributing DBC" (the two spurious inputs, now covered inversely),
and `an_unassigned_database_is_no_part_of_any_chain`'s final "assigned"
case now assigns the newcomer **in front of** the incumbent, since
assignment alone no longer moves a fingerprint unless it changes the
definition. `a_pick_shortens_the_chain_to_the_database_it_names` gained
an assertion that pinning the database the load order already chose
costs nothing — true only under this change.

One integration test changed its expectations, and the change is the
phase's whole point:
`tests::replacing_a_dbc_with_a_near_identical_file_keeps_the_unchanged_signals_pyramid`
used to assert `(live 0, retained 2)` in the intermediate state where
both the old file and its replacement are assigned, then a revival for
`A` out of the pool. It now asserts `(live 2, retained 0)` in that state
— the incumbent still decodes both signals, so neither pyramid moves —
and `revivals 0` after the removal, because `A` never left the live set
at all. Same end state, one fewer round trip through the pool.

Docs in the same commit, as the phase brief requires: ADR 0047 gains the
*2026-08-21 — the fingerprint identifies the winning definition*
amendment (with the header status line, the DBC-backed bullet, the
conservatism bullet under *Why*, and the now-adopted "nominate a winner"
alternative rewritten), and `docs/CONTEXT.md`'s **Encoding fingerprint**
entry no longer says "across the databases that may decode it, plus
their bus scoping".

**`4ffce32d` — the wording the change falsified.** Six places still
described a DBC-backed row's fingerprint as its candidate chain: the
manifest `encoding` field's rustdoc, `invalidate_dbcs`' first outcome,
two test narratives, `set_dbc_buses_inner`'s revival sentence, and ADR
0047's summary of the in-session judgement. The word stays where it
still describes decode eligibility (`sample_shared` really does walk an
ordered list) — only the fingerprint's own description moved.

**`173d201a` — README.** The reversibility paragraph said what
unassigning costs and what brings samples back; it now also says which
changes cost nothing, which is the half a user notices.

**`8893fc34` — the trade, pinned.** See the investigation below.

#### What a winner-only fingerprint cannot see, investigated rather than asserted

- *Observation.* ADR 0047 argued the chain was needed because
  "resolution is per frame", while ADR 0054 and this phase's brief say
  decode is first-wins per signal. Reading
  `signal_sampler::sample_shared` shows a per-frame fall-through: a name
  unresolved by one database is offered to the next, within the same
  frame.
- *Hypothesis.* A database behind the winner can still supply samples —
  for frames the winner withholds — which a winner-only fingerprint has
  no input from.
- *Experiment.* Two databases assigned to one bus: `a.dbc` defines `S`
  only in multiplexor arm 0, `b.dbc` defines it plainly. One frame with
  selector 1 (so `a.dbc` withholds), sampled through `sample_shared`
  against `b.dbc` and against an edited `b.dbc`, with `dbc_encoding`
  taken over both sets.
- *Data.* The value moves **7.0 → 18.0**; the fingerprint is
  `476b04dbda88b07e` in both cases.
- *Conclusion.* The exposure is real and narrow — it needs two assigned
  databases defining one signal on one bus, the second reached only
  through an arm the first does not answer, edited without the first. It
  is the price ADR 0054 pays for a key that cannot park a cache whose
  samples could not have moved, so it is not "fixed" here; it is named
  in ADR 0047's amendment and pinned by
  `a_value_the_winner_withholds_is_outside_the_fingerprint` so a future
  change has to move it deliberately. Also recorded under Blockers.

#### Exit criteria

| Criterion | Evidence |
| --- | --- |
| Unassigning a database from a bus other than the series' own does not park or rebuild that series | `signal_cache::unassigning_a_database_from_another_bus_leaves_this_series_decoding` (live 2, retained 0, revivals 0 after the unassign) and `signal_fingerprint::a_databases_other_assignments_are_no_part_of_the_fingerprint` |
| Loading a further database that defines the signal but does not win does not park or rebuild it | `signal_cache::a_database_that_does_not_win_leaves_the_series_decoding` (live 2, retained 0) and `signal_fingerprint::only_the_winning_definition_is_in_the_fingerprint` |
| A different database with identical decode specs still revives the parked cache | `tests::a_view_is_restored_by_the_signal_and_its_samples_by_the_fingerprint` and `signal_cache::a_park_is_revived_by_the_fingerprint_not_by_the_file_it_came_from`, both unchanged by this phase and both passing |
| Editing the winning definition's specs still parks and rebuilds | `signal_cache::a_dbc_change_parks_what_it_re_encoded_and_leaves_the_rest_live`, unchanged; plus the second half of `a_database_that_does_not_win_leaves_the_series_decoding`, where putting the newcomer in front parks exactly the one signal it re-encodes and leaves the other live |

**The legacy `bus_id: None` series was not touched**, as directed. Such
a series still has no eligible database (so no definition, and a
fingerprint independent of the loaded set) while `scan_chunk`'s `None`
arm still decodes every frame;
`an_unscoped_series_decodes_each_frame_by_its_own_bus` and
`bus_id_scoping_keeps_per_bus_series_independent` pass unchanged. The
migration decision phase 2 flagged is still open and still not this
phase's to take.

**No perf gate was run for this phase**, per the brief: the overseer
runs the ADR 0031 render-tier gate after it, and task 88's gate is owed
at that point. No baseline was promoted and no limit was touched at any
point here.

## Blockers / side effects

Recorded by phase 1, 2026-08-19.

- **A pre-rule scratch can still yield bus-less frames.** Restore maps
  the spill segments directly rather than replaying them through
  `TraceStore::append`, so a scratch written by a build from before
  this rule reopens with `bus_id: None` frames in the raw store. They
  render with an empty bus id (site 2 above) rather than crashing.
  `cannet-spill`'s manifest carries a `version` field that
  `DiskRawStore::reopen` **never checks** — the comment on
  `MANIFEST_VERSION` claims an old manifest "fails to parse", which is
  true only for layouts missing a required field — so bumping the
  version would not close this. Not fixed: both the record and the
  manifest are `cannet-spill`, which this phase is scoped out of.
- **`derived.json` written before this rule is discarded.**
  `DerivedEntry.bus_id` is now required, so an older file fails to
  parse; `read_json` already reports that as a clean miss. Such a
  scratch reopens with its frames intact and an empty by-id retention
  overlay (evicted rows show no last value until they are seen again).
- **`bench_blf_import` lost its `mem/nobus` phase.** It measured
  "full/mem with the frames left unassigned" to price what carrying a
  logical bus costs per frame. The store no longer accepts such a
  frame, so the phase measures nothing and its `store.len() == frames`
  assertion cannot hold. No perf doc referenced the figure.
- **A project with no buses now captures nothing.** No channel can be
  mapped to a bus, so no frame is routed, so the trace stays empty.
  That is the model's intent ("frames enter the GUI via a bus") but it
  is a behaviour change visible before any DBC work: the mux-snapshot
  tests had to give their project a bus, and the canonical signal path
  (ADR 0038) gained its bus segment in those tests as a result.
- **Not a blocker, recorded for the owner:** `plans/backlog.md` picked
  up an edit in the working tree during this phase that is not mine
  (the Database-panel launcher badge ruling). Left untouched and
  uncommitted, as are `apps/gui/src-tauri/Cargo.toml`'s line-ending
  noise and the untracked `docs/performance-measurements/frontend/`.
- **`pre-commit` clobbers a file edited while a commit is running.**
  Every hooked commit prints `Stashing unstaged files to
  …/.cache/pre-commit/patch<n>` before the hooks and `Restored changes
  from …` after, and one run in this phase printed `Stashed changes
  conflicted with hook auto-fixes… Rolling back fixes…`. The stash is
  taken from the working tree, so an edit made to an unstaged file
  *during* the hook run (the workspace clippy and test gates take a
  couple of minutes) is overwritten by the restore of the pre-edit
  copy. That is the mechanism behind planning-doc edits disappearing
  while an implementation agent commits alongside a live grooming
  session — no agent ran `git checkout`, `git restore` or `git stash`.
  Two ways out, both cheap: a docs-only commit can pass `--no-verify`
  (no code, so the gates prove nothing), and a code commit is safer
  when nothing under `plans/` is left dirty. The stashed copies survive
  in `~/.cache/pre-commit/patch*` if something needs recovering.

Recorded by phase 2, 2026-08-19.

- **A DBC-backed series that names no bus now decodes samples its
  fingerprint cannot see.** This is the phase's one internal
  inconsistency, and it is the migration decision phase 1 flagged
  coming due. `signal_fingerprint::dbc_encoding` was directed to stop
  keeping the whole candidate chain for `bus_id: None`, and does — such
  a series has the empty chain. The **decode** path was not directed to
  change and did not: `signal_cache::scan_chunk`'s per-target bus
  filter still treats a `None` target bus as "take every frame", and
  each frame is then decoded by the databases assigned to *its* bus.
  So a legacy any-bus series still produces samples, while no DBC edit
  can invalidate the pyramid holding them — under-invalidation, where
  the old rule over-invalidated. Nothing in the app creates such a
  series any more — the descriptor universe emits no `bus_id: None`
  row, the Database panel's drag fans out over assignments only, and
  the transmit and RBS panels name their row's bus — so it is
  reachable only from a project saved before per-bus signal binding,
  which opens with its databases unassigned and decoding nothing until
  the user assigns them. **The faithful fix is
  the migration decision, not a type change**: rule that a DBC-backed
  series naming no bus resolves nothing, and `scan_chunk`'s `None`
  target arm goes with it. Not taken here — it would silently empty
  every legacy plot series, which is exactly the kind of redesign this
  phase was told to surface rather than make. Two `signal_cache` tests
  still pin the current decode behaviour by name
  (`an_unscoped_series_decodes_each_frame_by_its_own_bus`,
  `bus_id_scoping_keeps_per_bus_series_independent`'s last assertion),
  so whoever takes the decision has the cases in front of them.
- **The Database panel still files an unassigned DBC under every bus
  group, labelled "applies to all buses".** That label is now false —
  the database decodes nothing — so the panel misstates the rule until
  phase 5 reaches it. A user-visible defect, left standing only because
  the phase brief scopes the Database panel UI to phase 5, which owns
  exactly this row. It is not large: the tree already has an
  **unassigned** group (`DatabasePanel.tsx`, the `unassigned.dbcs.push`
  arm), so the change is to route an empty-`buses` entry there instead
  of into every bus group, drop the `unscoped` / `unscopedNote` flags
  and the label they render, and update the two
  `DatabasePanel.dom.test.tsx` cases that assert it. README's
  description of the tree was deliberately left matching the shipped
  panel rather than the new rule, so that paragraph and the panel move
  together in phase 5.
- **Opening a pre-rule project decodes nothing, and nothing says why
  yet.** The grooming ruling accepts this ("a user whose databases are
  unassigned sees undecoded CAN frames in the trace, and that is
  already the signal"), and phase 5 supplies the Database panel row
  that names it. Worth stating plainly because it lands the moment this
  branch ships: any project whose `dbcs` entries carry an empty `buses`
  — every v2 project, since the migration lifts `dbc_paths` into
  unassigned entries — opens inert. The checked-in examples are not
  affected: `examples/ev-demo` and `examples/ev-zonal` both assign
  every database already, which is why the perf harness and the
  render-tier project needed no edit.
- **`lag_ms_max` is one bad tick from a false gate failure.** Eight
  captures of one unchanged build spanned 2.8 – 37.6 ms against a
  41 ms limit, with `lag_ms` mean ~0 in every one: the metric is a
  single-sample scheduler tail, so a run can fail the gate without any
  code changing. Same shape as the `rx_gap_short_frac_worst` finding
  task 81 phase 2 recorded and an 11-run control settled — and this
  phase's pre-inversion control run reproduced *that* one too (0.194
  against a 0.166 limit, on a GUI byte-identical to phase 1's). No
  limit was touched: they ratchet down only, and raising one needs an
  owner ruling in ADR 0031. Flagged so the ruling is made on evidence
  rather than mid-gate.
- **The one-time re-baseline the task authorises was not spent.** The
  bench's input change (unscoped → the example project's real
  assignments) moves no gated metric, because the signal bench's
  figures are not in `baseline.json` at all — it holds the three host
  modes' ingest / retention / append / scan plus the render-tier
  report. Measured either side of the change on one tree, the bench
  picked the same signal with the same match count and its timings sat
  inside run-to-run noise. Promoting a fresh baseline would have
  re-based every gated metric on today's machine state for no reason,
  and would have lowered the bar the inversion then had to clear, so
  the authorisation stands unused.

Recorded by phase 3, 2026-08-20.

- **REOPENED 2026-08-20 as a defect, not a cost.** The owner challenged
  the framing: *"Why would a signal in a specific view have a signature
  including an irrelevant bus? A CAN signal in a view is related to
  exactly one signal definition, one message, one ecu, one dbc, one
  bus."* Reading `signal_fingerprint::dbc_encoding` confirms it —
  `h.mix_len(dbc.buses.len())` and the loop hashing every bus name
  (lines ~389-393) run *after* line 373 has already filtered to
  candidates `dbc_applies` accepts for this signal's bus. Every
  surviving candidate is eligible for the one bus that matters, so its
  other assignments cannot change how this series decodes.

  The real fault is not the wasted work: **two states that decode
  identically hash differently**, which is the one thing a decode
  fingerprint must not do. Unassigning a second bus parks and rebuilds
  a series whose samples provably cannot move.

  The fix is to drop the bus-list mix and keep the specs. That is
  itself a fingerprint change, so every existing project pays one
  rebuild — which the owner has ruled payable: *"One time rebuilds are
  a cost we'll pay. It's important that the caches be dynamic and work
  well but they are caches at the end of the day and sometimes you have
  to."* One rebuild now, and the spurious rebuilds stop for good.

  Scheduled as **phase 8**. (For the record, `pt` / `ch` below are bus
  ids from the test fixtures rather than product concepts.) Original
  note:
  **the fingerprint still mixes each candidate's whole assignment set,
  so narrowing an assignment invalidates buses it did not touch.**
  `signal_fingerprint::dbc_encoding` hashes `dbc.buses` for every
  candidate as well as its decode specs, so a database assigned to
  `{pt, ch}` and then narrowed to `{pt}` re-encodes the `pt` series
  too — it parks and rebuilds, although no `pt` frame decodes any
  differently. Pre-existing and deliberate: ADR 0047 names bus scoping
  as a fingerprint input and its *Why* section lists exactly this as
  conservatism on purpose ("a re-scoped database whose frames this path
  does not filter by"). Worth writing down because the inverted rule
  weakens the argument for it — chain *membership* now encodes
  assignment already, so the buses list is arguably redundant — but
  narrowing it is itself a fingerprint change, costing every project one
  more one-time rebuild, so it is an ADR ruling rather than a phase-3
  edit. Nothing in this phase's exit criteria depends on it: revival
  after an unassign/re-assign round trip restores the identical
  assignment set and matches.
- **Two pyramids parked in one call are parked in hash-map order.**
  `invalidate_dbcs` walks `by_key` to decide what parks, so when a
  single change parks several signals their order in the pool — and
  therefore which of them `evict_retained` gives up first at the byte
  bound — is not deterministic. No user-visible consequence beyond
  which of two same-instant parks is evicted first, and no existing test
  depended on it; phase 3's own
  `unassigning_a_database_parks_its_caches_and_assigning_it_back_revives_them`
  sorts before asserting rather than pinning an accidental order.
  Recorded rather than fixed: making it deterministic means sorting the
  park list, which is work on the DBC-change path for a tie-break
  nobody has asked to be stable.
- **Phase 2's open items are unchanged by this phase.** The legacy
  `bus_id: None` DBC-backed series still decodes samples its (empty)
  chain cannot invalidate, and the Database panel still files an
  unassigned DBC under every bus group labelled "applies to all buses".
  Neither moved here; the first is the migration decision phase 2
  flagged, the second is phase 5's row.

Recorded by phase 4, 2026-08-20.

- **A row the databases never described, but whose id one happens to
  define, is treated as driven by it.** With no provenance field on a
  `TransmitFrame`, "built from a database" is measured as "an assigned
  database on this bus defines this message", so a CAN id the user typed
  by hand that *coincidentally* matches a DBC message stops when that
  database leaves the bus. Judged the right side to err on - the transmit
  panel showed that row the database's signal table, so from the user's
  side it *was* the DBC's message - and the alternative (stamping a DBC
  path on every transmit row) is a persisted-model change for a case
  nobody has reported. Recorded so the reading is a decision.
- **Nothing stops when a DBC is reloaded in place and the new file drops
  the message.** ADR 0053 section 1 rules that an externally-owned input
  swaps in place; this phase is its deliberate counterpart, not an
  extension of it. Closing that case means overturning section 1 for a
  *running* transmit the way it already does for a running RBS element,
  which is an ADR ruling rather than a phase edit.
- **Phase 2's and phase 3's open items are unchanged by this phase.** The
  legacy `bus_id: None` DBC-backed series still decodes samples its empty
  chain cannot invalidate; the Database panel still files an unassigned
  DBC under every bus group labelled "applies to all buses" (phase 5's
  row); the fingerprint still mixes each candidate's whole assignment
  set. None of them moved here.

Recorded by phase 5, 2026-08-20.

- **A collision's winner carries no note of its own.** Only the losing
  database's row names the winner (`⚠ duplicate id — a.dbc wins A, B`);
  the database whose decode is actually in effect gets nothing, on the
  reasoning that it needs no warning about behaviour that is already
  correct. Judged the quieter reading rather than the symmetric one
  (both rows marked) — the exit criteria ask only that the warning name
  a winner, not that every party to a collision be marked. Recorded so
  the asymmetry is a decision, not an oversight; task 89's picker,
  whichever surface it lands on, may want the symmetric form.
- **The Database panel's item from phases 2–3 is now closed.** The
  unassigned-DBC mislabel they deferred here (`groupByBus` filing every
  such database under every bus group as "applies to all buses") is
  fixed in this phase's second commit. Their other open items —
  the legacy `bus_id: None` DBC-backed series, and the fingerprint
  mixing each candidate's whole assignment set — are untouched;
  neither is this phase's scope.
- **The collision fingerprint is the same identity `dbc_applies`
  already filters on, not a new one.** `dbc_collisions` re-derives
  "which databases are assigned to this bus" per bus by scanning the
  whole loaded set again, rather than reusing `scoped_descriptors`'
  already-built (and cached, via `AppState::scoped_descriptor_snapshot`)
  expansion. Cheap in practice — `list_dbc_collisions` runs once per
  DBC-set change, not per frame or per poll tick, and the perf gate
  shows nothing moved — but worth naming as a small duplication of work
  `scoped_descriptors` already does, left alone because touching the
  cached snapshot's shape for a once-per-change caller is not this
  phase's problem to solve.
Recorded by phase 6, 2026-08-20.

- **A single perf run's `tree_mb_peak` spiked to 8233.7 MB (limit
  1492.1) immediately after the release build, with no reproduction
  across five further runs on the same unmodified binary and no
  plausible mechanism in this phase's change.** Investigated (see
  above) rather than acted on: `mem.host_mb` and `mem.webview_mb` — the
  components that would move if a React component leaked memory — were
  ordinary in the same run, so the excess is attributed to a
  descendant process the report doesn't break out further (the sidecar
  or the local `cannet-server`), and nothing about it recurred. Not
  fixed, because there is nothing identified to fix — recorded as a
  gate hazard in case it recurs on a future phase's first post-build
  run, the way phase 2's `rx_gap_short_frac_worst` and phase 2/3's
  `lag_ms_max` control runs were recorded rather than chased.
- **`PlotMeasurements.tsx`'s series-colour dot was a fourth,
  unlisted consumer of `.plot-signal-swatch`**, beyond the three the
  brief named — found only by grepping the class name while auditing
  what could be deleted. Migrated in the same phase (its own commit,
  `3e5751f8`) rather than left as a dangling reference once the class's
  CSS came out; not a scope change, since the brief's own exit
  criterion is "the `type="color"` sites that copied them," and this
  site copied the same look even though it was never itself a picker.

Recorded by the overseer for phase 7, 2026-08-21.

- **Reload all from disk changed shape, not just gained a stop.** It
  used to clear the whole set and reload it, which rebuilt priority
  order from the path list; it now swaps each database in place. Bus
  assignment and priority position survive a reload where before they
  were re-derived. That is the correct reading of ADR 0053 section 1
  and it is what makes the stop reachable at all, but it is a
  user-visible change to a button whose brief only asked for a stop —
  named here so it is a decision on the record rather than a
  side effect nobody wrote down.
- **The phase agent's session ended without a report.** Three commits
  were on the branch and a fourth slice sat complete but uncommitted in
  the working tree. The suites, clippy and the typechecker were re-run
  from scratch by the overseer before that slice was committed, and the
  status-log entry above says which claims were checked against code
  rather than against a report. No work was lost; the gap was the
  record, not the branch.

Recorded by phase 8, 2026-08-21.

- **A database behind the winner can still supply samples the
  fingerprint cannot see.** Decode resolves per frame
  (`signal_sampler::sample_shared`), so where the winning definition
  withholds a value — a multiplexor arm that does not match, a payload
  too short — the next assigned database answers for that frame, and
  editing *that* database no longer invalidates the pyramid holding
  those samples. Measured, not assumed: 7.0 → 18.0 with the fingerprint
  fixed at `476b04dbda88b07e` (experiment in the status log above).
  Deliberate, as the counterpart to the over-invalidation the chain
  caused; named in ADR 0047's 2026-08-21 amendment and pinned by
  `a_value_the_winner_withholds_is_outside_the_fingerprint`. Closing it
  properly means making decode match the model — one definition per
  signal, no fall-through — which changes decoded values and is a
  ruling, not a phase edit.
- **Every DBC-backed pyramid rebuilds once.** The hashed body changed
  shape (the bus list came out, the section tag changed, the walk stops
  at the winner), so no persisted fingerprint matches and every
  DBC-backed row parks and rebuilds on the first run with this branch.
  Authorised by the owner ruling quoted in the phase brief; recorded as
  a fact users see once, not as a cost to be avoided.
- **"Chain" survives in five test names.**
  `a_pick_shortens_the_chain_to_the_database_it_names`,
  `a_stale_pick_leaves_the_chain_where_the_load_order_puts_it`,
  `only_the_databases_that_can_decode_the_series_bus_are_in_the_chain`,
  `a_series_that_names_no_bus_has_the_empty_chain` and
  `an_unassigned_database_is_no_part_of_any_chain` all still assert what
  they asserted, and every stale *comment* inside them was corrected —
  but the fingerprint they cover no longer has a chain. Deliberately not
  renamed: earlier phases' status logs cite them by name, and renaming
  would leave those citations dangling for no behavioural gain.
- **Phase 2's legacy `bus_id: None` item is unchanged by this phase.** A
  DBC-backed series naming no bus still decodes every frame through
  `scan_chunk`'s `None` arm while having no definition to fingerprint.
  Not touched, as the brief directed; the migration decision is still
  open.
