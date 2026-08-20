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
