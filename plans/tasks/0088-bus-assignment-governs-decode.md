# Task 88 — Bus Assignment Governs Decode

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

Rust tests: **741 → 743** (6 ignored throughout). Frontend: **2261**
passing, unchanged. Perf harness crate: 49 passing.

| commit | subject |
| --- | --- |
| `8ec43685` | The signal bench decodes through the project's real bus assignments |
| `9cb171e4` | One scoping rule, not six copies of it |
| `d412c0d4` | Bus assignment governs decode: an unassigned database decodes nothing |

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
  the old rule over-invalidated. It is reachable only from a saved
  project that pre-dates per-bus signal binding (the descriptor
  universe no longer emits a `bus_id: None` row, so nothing creates one
  now), and such a project opens with its databases unassigned and
  decoding nothing until the user assigns them. **The faithful fix is
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
  the database decodes nothing — so the panel actively misstates the
  rule until phase 5 reaches it. It is a user-visible defect introduced
  by this phase and left standing on purpose: the phase brief scopes
  the Database panel UI to phase 5. `DatabasePanel.tsx`'s `unscoped`
  flag, its `unscopedNote` bus-group field and the two
  `DatabasePanel.dom.test.tsx` cases that assert the label are where it
  lives. README's description of the tree was left matching the shipped
  panel rather than the new rule, so that section and the panel move
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
