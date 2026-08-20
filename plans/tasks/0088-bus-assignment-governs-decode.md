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
  already the signal.
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
  version change is a different problem, recorded in
  [`plans/backlog.md`](../backlog.md) as the per-DBC-file signal remap
  view.

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

## Phases (draft)

Firm at grooming; one entry is already settled:

- **A shared colour chip, as its own phase** (owner ruling
  2026-08-19). The app has three parallel swatch implementations —
  `.trace-event-swatch` (+`-wrap`/`-input`), `.plot-signal-swatch`
  (+`.hidden`/`-wrap`/`-input`) and `.plot-bus-swatch` — plus seven
  `type="color"` sites across five components. `index.css`'s own
  comment on the events swatch says "(same control as the plot's series
  swatch)", so the duplication was noticed and copied anyway; both
  wrappers carry near-identical commentary about anchoring the native
  picker, and a macOS positioning bug is written down in only one of
  them, which is the failure this rule exists to prevent
  (`CLAUDE.md`: one shared implementation over per-panel copies). The
  events panel's shape — 1.5 rem bar, full row height, 2 px radius,
  `--border-wash` hairline — is the one to standardise on. **Independent
  of this task's decode rule**: it neither blocks nor is blocked by the
  assignment work, so it can be sequenced wherever it fits, and split
  into its own task if these phases get long.

## Exit criteria (draft — firm at grooming)

- A database assigned to no bus decodes nothing, on every consumer;
  tested.
- Assigning a database to a bus revives the parked caches whose
  fingerprints match, rather than re-decoding them; unassigning parks
  them; tested both directions.
- A pyramid built in the current session parks like any other.
- No frame in the store lacks a bus; an unmapped import channel is
  dropped.
- Opening a pre-rule project decodes nothing and says why on the
  Database panel rows.
- Two databases on one bus defining the same id warn, naming the
  winner.
- The perf bench measures the example project's real assignments, with
  its one-time re-baseline recorded.

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
