# Task 89 — The Signal Mapping Panel

Opened by owner ruling 2026-08-19, groomed the same day out of a
prototyping session. A live status panel over the signals the open
views reference: what each one is, what currently decodes it, and which
of them need attention. It is the one place the user goes to see and
repair the mapping between a view's signal selections and the databases
currently assigned to the buses.

Prototypes (static mocks with hard-coded rows — the layout, column set,
status taxonomy and filter behaviour are the deliverable, not the code;
open in a browser, the button top-right switches themes):

- [`plans/prototypes/view-signals-panel.html`](../prototypes/view-signals-panel.html)
  — the views grid.
- [`plans/prototypes/rbs-signals-panel.html`](../prototypes/rbs-signals-panel.html)
  — the same grid over one RBS config's DBC fields.

It is the sibling of [task 88](0088-bus-assignment-governs-decode.md),
which makes bus assignment govern decode. 88 ships the *warning* when
two databases on one bus define the same id; this task ships the
**resolution affordance** (owner ruling 2026-08-19). 88 also rules that
a view configured against an unassigned database keeps its
configuration and comes back when the database is re-assigned; this
task covers the adjacent half 88 says nothing about — a signal that no
longer exists under its old name.

## The model (owner, 2026-08-19)

1. **It is not scoped to a database.** Anchoring it to one file
   ("powertrain.dbc -> pt") was the original framing and was rejected:
   the panel lists *every signal the open views reference* and what
   currently serves it, live, so assigning / unassigning / replacing a
   database moves rows in it without a reopen. A database picker was
   tried and rejected on the way — it read as an assignment gesture,
   which is exactly what task 88 makes load-bearing. Columns for the
   serving database and which views use each signal replace the scope
   header.
2. **There is no apply step.** A pick takes effect immediately, like
   any other panel.
3. **One signal is one row, and a pick applies everywhere.** The
   frontend must not support Plot 1 configured differently from Plot 2,
   and a user must never have to repeat a fix per view. The grid is
   keyed on signal identity, and the "used by" column is *blast
   radius*, not a list of things to fix one at a time.
4. **It is a separate launchable panel**, not an embedded section, and
   **its launcher carries a badge with the needing-attention count** —
   the same count the panel's own attention control shows: Not Decoded
   + Scale + Ambiguous. The number appears on the button when there is
   something to look at, and the button is otherwise quiet.

## Grooming resolutions (2026-08-19)

- **The grid is shared; the scope is not.** The views grid combines
  across every view, because per-view divergence is a defect the owner
  ruled out. An RBS grid is scoped to **one** `.cannet_rbs`, because
  two RBS sims are *meant* to hold different values and timings, and
  combining them would invite editing across configs the user thinks of
  as independent. Same component, opposite scoping rule, and the reason
  is which kind of divergence is a bug. The config is named in the
  panel title; the app's internal word "element" stays out of the UI.
- **The RBS grid answers "where did this value come from".** A
  `.cannet_rbs` is a sparse override document while every transmitted
  frame is fully populated, by the precedence
  `fill_bit -> GenSigStartValue -> override` (ADR 0028,
  `rbs/runtime.rs`). The status chip is already the column that answers
  it, which is why the reuse is more than cosmetic. The chip says
  whether a field is the user's or not — **Default** covers both the
  DBC's start value and the file's fill, since neither is something the
  user set, and Detail names which supplied the bits.
  `GenSigStartValue` is not user-set state.
- **The RBS statuses are derived from what the encoder actually
  reports.** `reconstruct_payload` warns per override it cannot apply —
  unknown signal, unknown enum label, malformed hex — and *drops* it, so
  the frame goes out carrying the default while the file still says
  otherwise. That silent substitution is what the error rows exist to
  surface. The taxonomy is Not Encoded / Out of Range / Unknown Value /
  Override / Default / Muted.
- **Out of Range is a frontend concern, and clamping is shared code.**
  Truncation to the signal's width is correct on transmit — it is what
  the bus would see — so the check belongs in the frontend, which
  highlights it here and **clamps on entry**. The RBS panel's own value
  cells and this grid must clamp identically; two implementations would
  disagree at the boundary.
- **Reuse the existing gridview** (ADR 0044) rather than a bespoke
  table, **sortable, sorted by bus by default**.
- **The problem highlight is toggleable**, with the status column
  carrying the fact when the row washes are off.
- **Filtering is by status chip and by bus**, as toolbar controls with
  fly-out checklists. The selection model is: nothing selected is no
  filter; any one selected is just those items; multiple selected is all
  selected (owner ruling, overruling an earlier "cannot all be disabled"
  design).
- **A database assigned to several buses shows rows from all of them in
  one grid** — the mapping is name-to-name within the database, so one
  pick fixes every bus and every view that reads it.
- **Two highlights the owner wants**: *signals with no scale they can
  reach* — a candidate whose unit differs from the signal it replaces,
  so it cannot join the y-scale group it used to share and would land on
  an axis of its own (ADR 0026 groups y scales by unit); and *signals
  with multiple matches* — more than one assigned database defines that
  name, so the mapping is ambiguous and the user should pick rather than
  inherit load order.
- **A fifth case fell out of prototyping: same name, changed scaling**
  (factor 0.1 -> 0.5). Nothing looks broken, but the fingerprint
  differs, so the parked cache will not revive and the signal silently
  re-decodes. Invisible without this view.

### The ambiguous case, and where its answer lives

**The ambiguous case is the one that is not free.** Every other repair
is a rewrite of view state that already exists, but "which database wins
for this signal" has no home in the model. Measured: the signal catalog
*deduplicates the collision away* — `list_signals` dedups on
`(bus_id, message_id, signal_name)` (`dbc_commands.rs`) — and the
decoder settles it silently by load order, the first database yielding
the signal name winning (`signal_cache.rs`, pinned by
`first_dbc_wins_per_signal_not_per_message`). The existing
signal-focused views are therefore blind to it and not responsible for
it: it is resolved upstream of them and never reported.

Owner rulings on persisting the selection:

- It belongs in the **project file, attached to the signal**. The
  decoder being a consumer is a *driver* for putting it there, not an
  argument against it.
- **Not persisted when not set**, so an absent entry means the databases
  resolve in their consistent order and default behaviour stays
  predictable.
- **Dropped silently from the project when the selected DBC is
  removed**, falling back to that same default.
- **`SignalKey` does not grow a DBC field** — that would mean two
  decodes of one signal, which defeats the purpose.
- **No DBC disambiguation appears in views that report signals or
  messages.** The plot stays `bus.ecu.signal`, clear and minimal; this
  panel is the one place the rare ambiguity is resolved.
- Expected shape of that rare case: a client-facing DBC alongside a
  private one carrying extra enum values, rather than two databases
  genuinely defining the same message / signal / scaling combination.

## Questions resolved at grooming (2026-08-19)

- **RESOLVED — how "a pick applies everywhere" is enforced: rewrite on
  pick** (owner ruling 2026-08-19).

  Reading the question against the code first separated two picks that
  the framing had run together. **The ambiguity pick** ("two databases
  define this signal — use this one") is a project-level map from signal
  to chosen database, consumed by the decoder; every view reads the same
  decoded signal, so nothing needs enforcing and no view config changes.
  **The remap pick** ("this name is gone — point at this one instead") is
  the one with the problem: each view stores its own
  `bus | messageId : signalName`, spread across plot panel config, the
  colormap resolver, the signal generator, solo and selection state.

  The ruling covers the second: a pick rewrites every persisted signal
  reference. Rejected alternative was a project-scoped alias table
  resolving old name -> current signal — it keeps both names working but
  adds durable indirection consulted on every resolution, which outlives
  its reason and mis-resolves quietly.

  **Build it as one shared operation**, not a rewrite call per store.
  That is what makes the guarantee true rather than aspirational, and it
  is the enforcement point for "the frontend must not support Plot 1
  configured differently from Plot 2". It also self-heals: reverting to
  the old database reports the difference the other way round through
  this same panel.
- **RESOLVED — the gridview does not constrain the sort** (measured,
  overseer 2026-08-19). `gridviewColumns.tsx`'s own header comment says
  the gridview owns the sort *affordance* and that "sort **execution**
  stays with the panel", so a severity ordering is not a reuse question.
  Follow the existing shape rather than sorting in JS: `useByIdView` and
  `useSignalView` both pass `sortKey` / `sortDir` to the host and let it
  sort, which is what `CLAUDE.md` requires of a paged view. The severity
  order is the status taxonomy's own order.
- **RESOLVED — there is no separate per-DBC-file remap view; this
  panel is it.** An earlier idea (from before the prototype existed)
  proposed a second gridview scoped to one DBC file, with a combobox
  picker per signal, filtered to those not mapped to a live signal. The
  prototype already answers that: every row carries the candidate
  picker, "Stale" is precisely the renamed-signal case (*mapped as*
  `<view name>`, *decoded by* `<database signal>`), and filtering to Not
  Decoded gives the short list of what actually broke. A second grid
  doing a near-identical job is the per-panel copy ADR 0044 exists to
  prevent. Note the deliberate consequence of the panel's scope: it
  lists signals the open views reference, so a rename in a database no
  view currently uses does not appear — nothing is broken while nothing
  references it.
- **RESOLVED — the attention count is host-side.** The badge is live
  whether or not the panel is open, so the count cannot be a frontend
  scan over view configs (`CLAUDE.md`: domain computation belongs in the
  model, and frontend state is view-local). The panel's rows and the
  badge's count come from the same host command; the badge reads the
  count alone. It invalidates on the DBC-change generation
  ([ADR 0053](../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md)),
  which already carries assignment changes, and on view-config edits.
- **RESOLVED — this panel's badge is the second discoverability
  surface, and that is intended.** Task 88 rules that discoverability is
  the Database panel row *and nothing more* — no status-line warning, no
  prompt on project open. The launcher badge ruled here is a third
  thing: a number on a button, not a warning and not a prompt, quiet
  when there is nothing to show. A pre-rule project opens with
  everything unassigned, so every referenced signal reads Not Decoded
  and the badge carries a large number — which is the intended
  behaviour, not a violation. Task 88's bullet is annotated to point
  here so the two documents do not read as contradicting each other.

## Scope

- A launchable panel over the shared gridview (ADR 0044), keyed on
  signal identity, listing every signal the open views reference.
- The status taxonomy, row washes with a toggle, and the status-column
  fallback when the washes are off.
- Toolbar filters: status chips and a bus fly-out, on the
  nothing-selected-is-no-filter model.
- The launcher badge and its host-side attention count.
- The RBS variant: same grid, scoped to one `.cannet_rbs`, with the RBS
  status taxonomy and the shared clamp-on-entry.
- The persisted per-signal database selection in the project file.

## Phases (2026-08-19)

Sequential, each on its own branch chained from the last. Phase 1 is
the model and is tested without any UI; nothing after it re-derives a
model fact in JS.

1. **The panel's model, host-side.** One command returning a row per
   signal the open views reference — status, serving database, used-by
   set, and the candidates where there is a choice — plus the
   needing-attention count as a single number. Statuses: Not Decoded,
   Scale, Ambiguous, Stale, Decoded, severity-ordered. Takes `sortKey` /
   `sortDir` and sorts host-side, as `useByIdView` and `useSignalView`
   do. Invalidates on the DBC-change generation (ADR 0053) and on
   view-config edits. Fully tested with no frontend.
2. **The panel.** A launchable panel over the shared gridview (ADR
   0044): the column set, the status chips, the row washes with their
   toggle and the status-column fallback when they are off, and the
   toolbar filters — status chips and a bus fly-out — on the
   nothing-selected-is-no-filter model. Sorted by bus by default.
3. **The launcher badge.** The attention count from phase 1's command,
   on the panel's launcher; quiet when the count is zero.
4. **The ambiguity pick.** The per-signal database selection: persisted
   in the project file attached to the signal, absent when not set,
   dropped silently when the selected DBC is removed. The decoder
   consumes it; `SignalKey` does not grow a DBC field.
5. **The remap pick.** One shared operation that rewrites every
   persisted signal reference — plot panel config, the colormap
   resolver, the signal generator, solo and selection state — so a pick
   reaches every view that referenced the old name. Built once, not per
   store; this is the enforcement point for "Plot 1 cannot differ from
   Plot 2".
6. **The RBS variant.** The same grid scoped to one `.cannet_rbs`, with
   the encoder-derived taxonomy (Not Encoded / Out of Range / Unknown
   Value / Override / Default / Muted) and clamp-on-entry shared with
   the RBS panel's own value cells — one implementation, since two would
   disagree at the boundary.

## Exit criteria (2026-08-19)

- The panel lists every signal the open views reference, live: assigning
  or unassigning a database moves rows without a reopen; tested.
- Row status, the serving database, the used-by set and the attention
  count are all computed host-side; no model fact is re-derived in JS,
  and the panel holds no state that grows with the project.
- One signal is one row, and a pick applies to every view that
  references it; divergence between two plots is not reachable; tested.
- The launcher badge shows the attention count and updates on a DBC
  change, including assignment changes.
- The ambiguous case is selectable, the selection persists in the
  project file only when set, and it is dropped silently when the
  selected DBC is removed; tested all three.
- A remap pick rewrites every persisted reference through the one
  shared operation; tested across at least two different stores.
- The RBS variant shows one config's DBC fields with the encoder's own
  statuses, and clamps values on entry through the same code the RBS
  panel uses.
- Prototypes retired or updated to match what shipped.

## Status log

### Phase 1 — the panel's model, host-side (2026-08-20)

Branch `task-89-phase-1-panel-model`, from `task-90-phase-2-housekeeping`
(`69a066ce`). One commit of code (`efe546d9`) plus this log. Workspace
tests 1457 → 1478 (+21), zero failures; `cargo clippy --workspace
--all-targets` clean; `cargo fmt --all` applied. No frontend touched.

**What shipped.** A new host module `apps/gui/src-tauri/src/view_signals.rs`
and four commands:

| Command | What it does |
| --- | --- |
| `list_view_signals(sortKey, sortDir, busNames)` | the rows **and** `attentionCount` + `total` |
| `set_view_signals(viewId, viewName, signals)` | replace one view's references |
| `remove_view_signals(viewId)` | a view closed |
| `clear_view_signals()` | the project closed |

**Where the view configs come from, and why it had to be a push.** The
host owns the model but deliberately does not interpret the project's
`elements` blob (`project.rs`: "the host doesn't read these; the
frontend owns the shape"), and the element registry is frontend state
that is only handed over at Save. So there was no way to *read* the
view configs host-side. The frontend pushes them instead — one
`ViewSignalRefs` per view, replaced when that view's config is edited —
which is the shape `transmit_frames` and the RBS runtime already use:
the host holds the model, the frontend edits it through commands. The
count is then host-side for real, available with the panel shut, which
is what the launcher badge needs. Wiring the push into the views is
phase 2's job; phase 1 ships the model and its commands, tested with no
frontend.

**How each status is decided.** Severity order is the declaration order
of `ViewSignalStatus`, and a signal qualifying for more than one reads
as the most severe:

| Status | Decided by |
| --- | --- |
| Not Decoded | no database assigned to the reference's bus defines it (a reference naming no bus lands here too — `filter::dbc_applies`) |
| Scale | the serving database's **unit, factor or offset** differs from what the view recorded |
| Ambiguous | more than one assigned database defines it; load order settles it silently |
| Stale | it decodes on the expected scale, but the **message name** differs from what the view recorded |
| Decoded | the serving database matches every field the view recorded |

`needs_attention()` is the first three, and `attention_count` is that
predicate counted over the rows in `list_view_signals_inner` — the same
pass that builds the panel's rows, so the badge and the panel can never
disagree.

**Where Scale's boundary was drawn, and why.** The brief defines Scale
as a unit difference (ADR 0026 groups y scales by unit, so the series
lands on an axis of its own). The prototype additionally classifies
`×0.1 → ×0.5` — the "fifth case" grooming called out as invisible today
— under the same `warn` chip. Both sources agree unit → Scale; only the
prototype speaks to factor, and it says Scale. Scale is therefore *the
value's scale changed*: unit, factor or offset. That leaves Stale as
*the identity/labelling drifted*, which today is the renamed message and
which is where a renamed **signal** will join it once the remap pick
exists — at that point "mapped as X, decoded by Y" reads on the signal
name as the prototype draws it. Until then a renamed signal is honestly
Not Decoded, because nothing decodes it.

**What the drift is measured against.** A view records more than
identity: a plot's `SignalRef` carries `messageName` and `unit`. Those
recorded fields are the comparand, and `ViewSignalRef` carries `factor`
and `offset` alongside them for the fifth case. A view that records only
identity (colormap, generator, solo state) can only ever read Not
Decoded / Ambiguous / Decoded — correct, because there is nothing
recorded for the database to have drifted from, and there is a test
pinning it. Floats compare bit-wise, matching `signal_fingerprint`'s
stated policy (conservative in the safe direction, no NaN special case).

**Reuse rather than a second ambiguity detector.** Task 88's
`signal_snapshot::dbc_collisions` walked each bus's assigned databases
itself. It and this model now share one `DefinitionIndex` — built once
per call by `definition_index`, mapping `signal_identity` to the
assigned databases that define it, in project load order, borrowing from
the loaded set so it costs no string clones. `dbc_collisions` is
rewritten as "every indexed identity with more than one definer";
`build_rows` reads the same entries per referenced signal for the
serving database (`definers.first()` — the one the decoder resolves
from) and for ambiguity (`definers.len() > 1`). One rule, two consumers,
so the Database panel's warning and this panel cannot disagree about
which database wins.

**Bug found and fixed in passing** (observation → hypothesis →
experiment → data → conclusion):

- *Observation.* `dbc_collisions` keyed on `(message id, extended,
  signal name)` while walking `Database::signals()`, which yields one
  entry per `SG_` line.
- *Hypothesis.* A message declaring one signal name in several
  multiplexor arms therefore collides with **itself**, and the Database
  panel warns that `a.dbc` loses to `a.dbc`.
- *Experiment.* Added `dbc_collisions_does_not_collide_a_database_with_itself`
  over a one-database DBC whose `PackStatus` declares `Reading` in arms
  `m0` and `m1`, then ran it against the pre-fix scan.
- *Data.* `[DbcCollision { bus_id: "power", message_id: 256, extended:
  false, signal_name: "Reading", winner_path: "a.dbc", loser_path:
  "a.dbc" }]`.
- *Conclusion.* Confirmed. `definition_index` records a database at most
  once per identity ("which database serves this" is not a question a
  database can disagree with itself about); the test stays as the
  regression guard.

**Invalidation.** Nothing is cached: `list_view_signals` reads the
registry and the loaded DBC set live on every call, so there is no
stale-cache failure mode to get wrong and the answer is current by
construction. What has to be right is that the consumers are *told*:
the DBC half already announces itself as `dbc-changed` (ADR 0053 §2,
which since task 88 covers assignment changes), and the view-config half
now announces itself as `view-signals-changed` — emitted only when the
stored references actually differ, so a panel re-persisting what it
already had cannot loop itself into a refetch. Three tests carry this:
assigning then unassigning a database through the real
`set_dbc_buses_inner` path moves a row between Not Decoded and Decoded
and moves the count with it; reinstalling an edited database under the
same identity (the watcher's path) moves it to Scale; and dropping a
view's references drops the rows only it held.

**Deliberate scope calls, all recorded in rustdoc:**

- **File-backed series are not rows.** They are read out of the capture
  file and no database ever bore on them, so they have no mapping to
  repair — including them would park them in the grid reading Not
  Decoded forever and inflate the badge.
- **Candidates are returned for every status except Decoded** ("the
  candidates, where there is a choice to be made"). They are every
  `(database, signal)` the referenced message offers on that bus, in
  load order then declaration order — which yields the several-databases
  picker for the ambiguous case and the sibling-signals picker for the
  remap case from one rule. A Decoded row already has what the view
  asked for.
- **A row nothing decodes sorts last on the database column in either
  direction**, matching `signal_snapshot::sort_rows`' existing
  blanks-last rule; ties everywhere break ascending on `(bus, signal)`
  so flipping the direction on a tied column does not reshuffle rows
  that column cannot tell apart.
- **Two views recording different things for one signal**: the lowest
  view id wins, deterministically. Per-view divergence is the defect
  this panel exists to surface, not a state the model represents.

**Not touched:** `TraceStore::frame_index_at_ns` (task 91) — nothing in
this phase reads it.
