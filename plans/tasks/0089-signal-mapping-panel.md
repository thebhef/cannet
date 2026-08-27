# Task 89 — The Signal Mapping Panel

> **Status 2026-08-23 — code-complete, awaiting acceptance.** All six
> phases landed 2026-08-20 on the chain (nothing has merged) and both
> prototypes are deleted. **The exit criteria below were never walked** —
> this file carries no per-criterion verdict anywhere (owner-review-queue
> 3.45). Queue item 1.13 was split 2026-08-25: parts a/b became task
> 116, part c was ruled (row highlighting is a gridview behaviour, task
> 113). Still owed a verdict: **3.46**, **3.47**.

Opened by owner ruling 2026-08-19, groomed the same day out of a
prototyping session. A live status panel over the signals the open
views reference: what each one is, what currently decodes it, and which
of them need attention. It is the one place the user goes to see and
repair the mapping between a view's signal selections and the databases
currently assigned to the buses.

Prototypes (static mocks with hard-coded rows — the layout, column set,
status taxonomy and filter behaviour are the deliverable, not the code;
open in a browser, the button top-right switches themes):

- `plans/prototypes/view-signals-panel.html` — the views grid.
- `plans/prototypes/rbs-signals-panel.html` — the same grid over one RBS
  config's DBC fields.

**Both were deleted by phase 6**, superseded by the shipped panels, so
the names above are history rather than links.

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

### Phase 2 — the panel (2026-08-20)

Branch `task-89-phase-2-panel`, from `task-89-phase-1-panel-model`
(`0479f5f8`). Two commits (`660647b2` push wiring, `1b84d561` the
panel) plus this log. Frontend tests 2279 → 2331 (+52, 176 files, was
171), zero failures; `pnpm build` (tsc + vite) clean. Workspace Rust
tests unchanged at 1478 (no host file touched this phase); `cargo test
--workspace` reconfirmed it green regardless. No Rust files changed,
so `cargo clippy`/`cargo fmt` had nothing new to check.

**Half one: wiring the push.** Phase 1 built `set_view_signals` /
`remove_view_signals` and left feeding them to phase 2, since the host
does not interpret the project's opaque `elements` blob. One shared
hook, `usePushViewSignals` (`viewSignalsPush.ts`), pushes on mount and
on every change to a view's own `ViewSignalRef[]`, de-duping a same-
value re-push before it costs a round trip, and un-pushes on unmount.
Four call sites, each with its own pure `*ViewSignalRefs` builder over
whatever that view already persists:

| View | What it pushes | Recorded fields |
| --- | --- | --- |
| Plot (`PlotPanel`) | every area's manual `signals` | `messageName`, `unit` |
| Signals / "Trace" view (`SignalsPanel`) | manual `selection.keys` | `messageName`, `unit` |
| Color map (`ColorMapPanel`) | the element's one target signal | identity only |
| Transmit (`TransmitPanel`) | a frame's counter/CRC calculated-field signal (ADR 0027) | identity only |

**Deliberately not wired, and why — a scope call, not an oversight.**
Every other "signal reference" in the app turned out to be a live
pattern, re-evaluated against the current catalog on every render, with
no recorded configuration for a database to have drifted from:

- A plot area's `patterns` and the signals view's selection patterns
  (regex over the catalog, materialized fresh each render — same
  reasoning `plotSolo.ts` already documents for why solo masks
  `signals`, never adds to it).
- The signal-generator's rules (`GeneratorPanel`/
  `signalGeneratorContext.tsx`): a `generator` element is a list of
  regexes matched against catalog signal *names* for a colour-wheel
  slot, with no persisted per-signal identity at all — there is
  nothing here that can go stale in the sense this panel repairs.
- A transmit frame's own byte-level signal edits: resolved against
  whichever DBC is assigned at edit time and flattened to bytes
  immediately, leaving no persisted pick behind (unlike the calc-field
  signal names above, which *are* persisted identities).

Each of these is recorded in `viewSignalsPush.ts`'s module doc so the
reasoning doesn't have to be re-derived by the next reader.

**Bug caught before it shipped.** The panel's first draft used two
separate `useEffect`s to fetch — one on `[refresh]`, one on
`[dbcGeneration, refresh]` — both firing on mount, so every mount paid
two `list_view_signals` round trips. `ViewSignalsPanel.dom.test.tsx`'s
`view-signals-changed` test caught it on its first run (2 calls where 1
was asserted); folded into one effect on `[dbcGeneration, refresh]`
before either commit landed, so it never reached history as its own
bug.

**Half two: the panel.** `ViewSignalsPanel.tsx`, a singleton (same
rationale as the Database panel — the model is project-wide, so a
second instance would carry no differentiation), over the shared
gridview (ADR 0044): a flat leaf row space (`arrayRowSpace`, no
expansion), the column set from the brief (status chip, bus, signal,
message, database, an inert source/candidate picker, applies-to,
detail), toggleable per-status row washes (`color-mix()` against the
existing theme tokens, so it needs no per-theme duplicate) with the
status column falling back to the text label when washes are off, and
the toolbar filters — status chips and a bus fly-out — on the owner's
selection model (nothing selected is no filter; one selected is just
those rows; several is their union; `viewSignalsFilter.ts`, unit
tested independent of the DOM). Sorted by bus by default
(`DEFAULT_VIEW_SIGNAL_SORT`); every header click re-fetches from the
host with the new `sortKey`/`sortDir` rather than reordering
client-side — the `source`/`detail` columns have no host sort, so
their header click is a no-op, the same shape the signals view's
`section` column already uses. Refetches on `view-signals-changed`
and on the DBC-change generation (ADR 0053 §2/§3, which already covers
assignment changes since task 88); not paged, since `list_view_signals`
itself is one unbounded fetch bounded by how many signals the open
views reference, not by capture length — there is nothing here for
`CLAUDE.md`'s paging rule to apply to.

**Binding respected.** Status, serving database, used-by, candidates
and the attention count are read straight off `ViewSignalRow` — the
panel's own code computes none of them, only shapes already-fetched
rows for the gridview (busName fallbacks, the diff pairs' "mapped as /
decoded by" phrasing, a status-keyed note where the host reports no
diff to state). The wash toggle, the two filters, the column layout and
the sort state are workspace-local (persisted in the dockview panel's
own params, like the Database panel's `filter`/`expanded`), and none of
it grows with the project.

**Deliberately inert this phase:** the candidate `<select>` renders
every row's choices (or the single answer a Decoded row already has)
but is `disabled`, with a tooltip naming phases 4/5 as where picking
gets wired. No badge on the launcher yet (phase 3) — the toolbar
button, the command palette entry (`panel.show.viewSignals`) and the
go-to-view palette entry are quiet buttons today, the way the Database
panel's was before task 88.

**Not touched:** `TraceStore::frame_index_at_ns` (task 91); no host
file at all this phase, so nothing here reads it either.

### Phase 3 — the launcher badge (2026-08-20)

Branch `task-89-phase-3-launcher-badge`, from `task-89-phase-2-panel`
(`4eef42a9`). Three commits (`69083380` the hook, `e61e8f9d` the
toolbar wiring, `51828233` a mount-fetch fix caught by its own test)
plus this log. Frontend tests 2331 → 2336 (5 new, still 177 files, no
new file added past the hook's own test), zero failures; `pnpm build`
(tsc and vite) clean. No host file touched this phase, so workspace
Rust tests stayed at 1478 (reconfirmed green) and `cargo clippy`/`cargo
fmt` had nothing new to check.

**What shipped.** `useViewSignalsAttentionCount`
(`viewSignalsAttention.ts`) and one bespoke toolbar item on the
"View signals" button, the same shape the System Messages button's
unread badge already uses (`system-messages-button` /
`system-messages-badge`): a small pill next to the label, rendered only
when the count is above zero.

**Where the count comes from.** The hook calls the same
`list_view_signals` command the panel calls and reads its
`attentionCount` field — the same number `build_rows` /
`needs_attention()` computed in phase 1, over the same row pass that
builds the panel. There is no second counting rule to disagree with the
panel's: `sortKey`/`sortDir`/`busNames` are irrelevant to the count (it
is `rows.iter().filter(needs_attention).count()` before any sort is
applied), so the hook passes `null`/`null`/`[]` and only reads the one
field back.

**Live with the panel closed.** The hook is called directly in `App`,
which is always mounted, independently of whether `ViewSignalsPanel`
is. It refetches on the same two triggers the panel itself refetches
on, so the two can never disagree about *when* to ask: the
`view-signals-changed` event (a view's pushed references changed) and
the DBC-change generation (ADR 0053 §2/§3, already covering assignment
changes since task 88). The event half reuses the shared host-mirror
pattern (`useHostMirror.ts`, also `TransmitPanel`/`RbsPanel`'s
fetch/listen/launch-race machinery) rather than a third hand-rolled
fetch/listen pair; the generation half folds `useDbcGeneration` on top,
guarded by a `seenDbcGenerationRef` the same way `App`'s own trace-model
re-anchor effect guards it (see the bug below for why the guard is
there).

**Quiet at zero.** `viewSignalsAttentionCount > 0` gates both the badge
`<span>` and the count inside it — at zero the button renders exactly
like every other command-backed toolbar button, no empty pill, no "0".

**Bug found and fixed before it shipped** (observation → hypothesis →
experiment → data → conclusion), the same shape phase 2's panel caught
for its own two-effects-both-firing-on-mount bug:

- *Observation.* A test asserting `listCalls().length` after mount
  passed at "greater than 0" without pinning a number, which felt too
  loose for a hook whose whole cost note is "fires only on real
  changes, never a timer."
- *Hypothesis.* `useHostMirror` already fires two fetches on mount by
  contract (the initial paint, then the post-listener refetch that
  closes the async-`listen` launch race) — folding `dbcGeneration`
  straight into a second `useEffect(() => refresh(), [dbcGeneration,
  refresh])` should cost nothing extra, since it is one more listener,
  not a poll.
- *Experiment.* Logged the mock's call count after a bare mount.
- *Data.* Three calls, not two.
- *Conclusion.* Confirmed: a fresh effect's first run always reads its
  dependency as "changed from nothing," so the naive fold fired a third
  mount fetch — exactly the shape phase 2's two-effects bug took, just
  inside one hook instead of across two. Fixed with the same guard
  `App` already uses for the identical hazard on its own trace-model
  epoch (`seenDbcGenerationRef`, seeded with the generation already in
  hand so only a genuine post-mount change refetches).
  `does not pay a third fetch for folding the DBC generation onto
  useHostMirror's own mount + launch-race pair` pins the count at
  exactly 2 as the regression guard.

**Cost note, not built speculatively.** There is no count-only host
command, so every refresh — mount, `view-signals-changed`, a DBC
change — pulls the full row set even though the badge renders none of
it. Judged not obviously real: the row count is bounded by how many
signals the open views reference (typically small), and the fetch is
event-gated rather than a poll, so it does not compound with capture
length or session time. A count-only command would drop the row
payload; the module doc names this so a future reader who wants to
build one knows why it wasn't done here.

**Palettes left alone, on purpose.** The command palette entry
(`panel.show.viewSignals`) and the go-to-view palette entry are
unchanged plain-label rows — no other launcher's badge (System
Messages' unread count included) appears in either list today, and a
number stapled onto a palette row's label reads as noise there, not as
the same "something needs a look" signal the toolbar pill carries. The
toolbar button is the one place the ruling names, so this phase leaves
both palettes as phase 2 shipped them.

**Not touched:** `TraceStore::frame_index_at_ns` (task 91); no host
file at all this phase, so nothing here reads it either.

#### ADR-0031 perf gate

`pnpm --dir apps/gui tauri build --no-bundle` (`target/release/cannet-gui.exe`,
frontend embedded), `cargo build --release -p cannet-perf-measurement`;
`examples/ev-zonal` at ~1608 fps, `--connect-on-start`,
`--perf-interact scrub`, four 60 s captures into an isolated
`--app-data-dir` (`scratch-perf/app-data`), gated by `cargo run
--release -p cannet-perf-measurement -- check --expected-rx-fps 1608
--expected-tx-fps 1608` (one `--frontend-report` per run) against the
committed `docs/performance-measurements/baseline.json`. **No baseline
was promoted and no gate limit was touched.** Reports are review
artifacts and stay out of the repository.

Four runs, `check` over all four: **passed, 87 metrics gated.** Every
metric read `ok`; nothing regressed and nothing widened.

| run | rx fps | tx fps | `rx_gap` short-frac worst | `rx_gap` p95 ratio worst | `lag_ms` max | `tree_mb` peak |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1602.7 | 1607.3 | 0.0025 | 1.178 | 1.9 | 733.2 |
| 2 | 1608.9 | 1611.9 | 0.0053 | 1.173 | 9.1 | 725.6 |
| 3 | 1607.2 | 1608.2 | 0.0043 | 1.143 | 3.9 | 727.8 |
| 4 | 1601.4 | 1608.4 | 0.0071 | 1.161 | 2.8 | 732.3 |

Both `rx_gap_short_frac_worst` (0.0025–0.0071) and `lag_ms_max`
(1.9–9.1) sat inside the bands task 89 phase 3's brief named as
known-jittery and under owner review (0.002–0.0105 / 1.1–29.4);
`tree_mb_peak` (725.6–733.2 MB) sat inside the 705–768 MB range prior
phases already reported, with no repeat of task 88 phase 6's
unreproduced 8233 MB outlier. The three memory-drift metrics gated on
the median across the four reports (`jsheap_mb_drift_per_min` 8.7 vs a
24.1 limit, `renderer_mb_drift_per_min` 42.5 vs 85.3,
`tree_mb_drift_per_min` 74.6 vs 139.2), all `ok`. Host modes
(tracebuffer/grpc/hardware-peak) gated on their own baselines and were
all `ok` too, unaffected by a frontend-only change.

### Phase 4 — the ambiguity pick (2026-08-20)

Branch `task-89-phase-4-ambiguity-pick`, from
`task-89-phase-3-launcher-badge` (`9b101662`). Five commits (`8e30c96e`
the decode model, `92f68c1d` persistence + the command, `80114808` the
panel's model, `41833003` the frontend picker, `08d905ef` the collision
winner) plus this log. Workspace Rust tests 1478 → 1494 (+16), zero
failures; frontend 2336 → 2340 (+4, still 177 files), zero failures;
`cargo clippy --workspace --all-targets` clean, `cargo fmt --all`
applied, `pnpm build` (tsc + vite) clean.

**The shape, and how an untouched project stays byte-identical.** The
pick lives in the project file as `signal_dbc_picks`: signal identity
(ADR 0038 — the same `bus|s:id:name` string the row id, `signal_colors`
and `plotData.ts::signalKey` all use) → the chosen database's loaded
path. It is host-managed like `transmit_frames`, because the decoder
consumes it: `open_project` installs it into
`AppState::signal_dbc_picks`, `save_project` snapshots that registry
back, and the frontend's save payload never carries it. The field is
`skip_serializing_if = is_empty`, so a project with no resolved
ambiguity serialises with no such key at all —
`a_project_with_no_database_pick_carries_no_such_field` asserts the
*absence*, because a round-trip assertion would pass either way. No
schema bump: an additive field the loader defaults when absent is
exactly what ADR 0011 says is not a shape change.

Recording is narrower than "whatever the caller sent", and that is what
makes the not-persisted-when-not-set ruling hold in practice rather than
only at the serializer. `set_signal_dbc_pick` keeps an entry only for a
**real, non-default** choice, which collapses three cases into one
clear: `None`, the database load order already picks, and a path that
does not define this signal on this bus. Choosing the load-order winner
is therefore how the user reverts, and the map only ever holds choices
that differ from the default.

**How a removed DBC drops its entry.** `remove_dbc_inner` calls
`AppState::forget_dbc_picks(path)` before it re-judges the pyramids, so
the model the invalidation sees is already the one without the pick.
Silently — no log line, no notice — and
`removing_the_picked_database_drops_the_pick_silently` pins both halves
(the entry gone, the system log unchanged in length).
`close_project` drops them all, as it already drops the view-signal
references.

`clear_dbcs` deliberately does **not** prune, and that is load-bearing
rather than an omission: it is the first half of an *open project*
(`loadDbcSet` clears, then re-adds each database), and it runs *after*
`open_project` has installed the file's picks. Pruning there would wipe
every pick a project carried, every time it was opened.
`clearing_the_whole_set_keeps_the_picks_the_project_just_installed`
guards it, and also that a pick comes back into force the moment its
database does.

**How the decoder consumes it.** `DecodeModel` bundles the scoped DBC
set with the picks and travels where `Vec<DbcScope>` used to. It derefs
to the scope slice, so the many consumers that only need the set read
exactly as before, while the ones that resolve a signal's *source*
cannot pass the set and forget the picks. `DbcScope` grew the loaded
path — the identity a pick names, and mixed into no fingerprint, since a
fingerprint is over the parsed model and not the file it came from.

The rule is stated once, in `DecodeModel::picked_index`: where a pick
names a database that is loaded, assigned to the signal's bus, and
actually defines the signal, that is its position among the databases
eligible for a frame on that bus — and that database alone is the
chain. Three consumers apply it, over three materialisations of the same
"assigned to the bus and defining the signal, in load order" sequence:

| Consumer | What the pick does |
| --- | --- |
| `signal_sampler::sample_shared` (through `scan_chunk`) | pins the name to that database's decode, resolved once per bus turnover alongside the `eligible` list it indexes into |
| `signal_fingerprint::dbc_encoding` | shortens the candidate chain to the same one database |
| `signal_snapshot::DefinitionIndex::resolved` | the serving database the panel names, and whether the row is still Ambiguous |

**A pinned name takes its value from that database or from none.** The
default rule lets a database withhold a frame (a multiplexor arm that
does not match) and the next one answer; under a pick that fall-through
would put back exactly the silent substitution the pick was made to
stop, so it is not offered. The safe direction *is* offered: a **stale**
pick — the database removed, unassigned, or edited until it no longer
defines the signal — is ignored rather than honoured-and-empty, so a
pick can never silence a signal that something still decodes. The
asymmetry is deliberate and tested from both ends.

**What a pick does to the caches, and the test that proves it.** This is
the half that would otherwise have been a silent wrong answer. A pyramid
holds *decoded* samples and revives against its encoding fingerprint
(ADR 0047), so if only the decode honoured the pick, the pyramid built
under the load-order default would keep serving the **other** database's
samples under the picked database's name. Because `dbc_encoding` applies
the same shortening, a pick moves the fingerprint;
`set_signal_dbc_pick` then runs `invalidate_derived_caches`, which
re-encodes every live pyramid, retires the one the pick invalidated and
parks it. Reverting restores the fingerprint the park carries, so the
old pyramid revives instead of decoding into a third answer.

Falsified before it was believed (observation → hypothesis → experiment
→ data → conclusion):

- *Observation.* `a_pick_retires_the_pyramid_the_other_database_decoded`
  passed on its first run, which proves nothing about *which* half of
  the change made it pass.
- *Hypothesis.* The decode half alone is not sufficient — without the
  fingerprint half the pyramid survives the pick and keeps serving the
  old scaling.
- *Experiment.* Deleted the three-line pick check from `dbc_encoding`,
  leaving `sample_shared`'s intact, and re-ran that one test.
- *Data.* `assertion left == right failed: a stale pyramid served the
  retired database's samples / left: [3.0, 4.0] / right: [30.0, 40.0]` —
  the *pre-pick* database's samples, served after the pick.
- *Conclusion.* Confirmed, and it is the fingerprint that carries it.
  The same falsification was run against `sample_shared`'s half (both
  decode pick tests fail without it) and against the frontend picker's
  `disabled` attribute (three panel tests fail), so no test added here
  passes for a reason other than the change it names.

**`SignalKey` did not grow a DBC field** — confirmed; nothing in this
phase touches it. The pick is keyed on the *signal identity*, not
carried in the cache key, so one signal still has exactly one decode and
one pyramid. That is precisely why the cache work above is necessary:
with the key unchanged, the existing pyramid *is* the one that has to be
retired.

**The picker, live.** Phase 2 rendered the source `<select>` inert; it
now records the choice through `set_signal_dbc_pick`, keyed on the row's
own id. No apply step and no local state — the host records, re-judges
and announces a DBC change (ADR 0053 §2, which is what a change to what
the loaded set decodes means), and that is one of the two events the
panel and its badge already refetch on. A pick the host declines simply
comes back unchanged, by the same path as any other refetch. Options
naming a *different signal* are the remap case and stay disabled with a
title saying so; a row with nothing to offer keeps a disabled control.
`ViewSignalRow` gained `pickedDbc`, reported only while the pick is in
force, and a `Decoded` row now keeps its candidates when one is —
otherwise the control that made the pick could not undo it.

**A resolved row leaves Ambiguous** because its chain no longer holds
more than one candidate: the status falls out of the shared resolution
rather than being special-cased. Choosing a database that scales the
signal differently from what the view recorded moves the row to
**Scale**, which is the panel saying what the choice cost rather than
hiding it.

**Bug found and fixed in passing: the Database panel named the wrong
winner.** Task 88's `dbc_collisions` split the definer list and called
the first entry the winner. After a pick that is false, and the Database
panel would name one database while the decoder used another — the exact
disagreement phase 1 built one shared `DefinitionIndex` to prevent. It
now reads the winner through `resolved`. A settled collision is still a
collision (two databases really do define the signal), so the warning
stays; only which side is winner and which is loser changes.
`dbc_collisions_names_the_winner_the_user_picked` is the guard, and
README's sentence about that warning was corrected in the same commit.

**Second small fix in passing:** the source `<option>`'s value packs the
database path and the signal name around a separator that phase 2 wrote
as a **literal NUL byte in the .tsx source**, which made the whole file
read as binary to `grep` and `diff`. Same value, written as the `\0`
escape, and both halves now go through one pair of functions instead of
being spelled out at three call sites.

**What a pick does not reach, and why — for an owner ruling.** The pick
is per *signal*, and so is exactly one decode path: `signal_cache` /
`sample_shared`, the decoder grooming measured and named
(`first_dbc_wins_per_signal_not_per_message`). The app's other decode
paths resolve one database **per message** and then read every signal
out of that single decode: the trace view's rows (`decode_against`), the
signals view's latest-value snapshot (`decode_snapshot_frame`), and the
descriptor catalog's dedup (`scoped_descriptors`, which
`AppState::first_dbc_on_bus` matches). Honouring a per-signal pick there
means splitting one message's decode across two databases and
re-deriving individual signals out of the loser — a different change
from the one groomed, and one with a per-frame cost on the trace path.

The consequence is bounded, and surfaced rather than silent: for a
signal whose two definitions differ in scaling, a pick moves the
**plot's** samples but not the signals view's latest value or the
catalog's unit — and the panel says so, because that row then reads
**Scale**, naming what the view recorded against what the picked
database says. For the shape the owner expects this to be used for (a
client-facing DBC beside a private one carrying extra enum values) the
definitions agree on scaling and the divergence does not arise; what a
pick does *not* yet deliver in that case is the private database's extra
value labels, which come from the catalog rather than from the decode.
Named here for a ruling, not decided.

**Not touched:** `TraceStore::frame_index_at_ns` (task 91) — nothing in
this phase reads it.

#### ADR-0031 perf gate

`pnpm --dir apps/gui tauri build --no-bundle`
(`target/release/cannet-gui.exe`, frontend embedded), `cargo build
--release -p cannet-perf-measurement`; `examples/ev-zonal` at ~1608 fps,
`--connect-on-start`, `--perf-interact scrub`, 60 s captures into an
isolated `--app-data-dir` (`scratch-perf/app-data`), gated by `cargo run
--release -p cannet-perf-measurement -- check --expected-rx-fps 1608
--expected-tx-fps 1608` against the committed
`docs/performance-measurements/baseline.json`. **No baseline was
promoted and no gate limit was touched.** Reports are review artifacts
and stay out of the repository.

**The gate did not pass on the first four runs**, so the population was
extended to twelve. One report of the twelve — run 3 — fails two
metrics; the other eleven pass all 213 gated metrics with nothing
regressed and nothing widened.

| run | rx fps | tx fps | `rx_gap` p95 ratio worst | `rx_gap` short-frac worst | `lag_ms` max | `tree_mb` peak |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1625.5 | 1611.7 | 2.144 | 0.0931 | 13.6 | 732.3 |
| 2 | 1601.3 | 1601.4 | 1.166 | 0.0032 | 16.7 | 750.8 |
| **3** | 1627.8 | **1530.6** | **3.307** | **0.2362** | 6.5 | 729.1 |
| 4 | 1600.4 | 1607.6 | 1.367 | 0.0278 | 17.2 | 728.5 |
| 5 | 1604.1 | 1608.9 | 1.148 | 0.0070 | 2.7 | 729.3 |
| 6 | 1602.6 | 1607.3 | 1.183 | 0.0025 | 4.4 | 735.5 |
| 7 | 1605.8 | 1607.6 | 1.153 | 0.0030 | 7.1 | 724.8 |
| 8 | 1604.6 | 1609.5 | 1.138 | 0.0045 | 14.3 | 732.4 |
| 9 | 1603.4 | 1606.9 | 1.168 | 0.0032 | 11.9 | 737.5 |
| 10 | 1605.5 | 1611.2 | 1.147 | 0.0027 | 12.0 | 729.7 |
| 11 | 1601.8 | 1609.0 | 1.162 | 0.0033 | 1.2 | 732.1 |
| 12 | 1608.5 | 1610.3 | 1.176 | 0.0028 | 22.2 | 730.6 |

Limits: `rx_gap_p95_ratio_worst` 2.898, `rx_gap_short_frac_worst` 0.166.
Run 3 breaches both; run 1 is elevated on both but inside them.
`ids_measured` is 173 on every run (no sidecar throttling — the
fingerprint from the gotchas note is 156). The three memory-drift
metrics gate on the median across reports and are `ok` over all twelve
(`jsheap` 5.8 vs 24.1, `renderer` 41.9 vs 85.3, `tree` 72.4 vs 139.2),
as are the tracebuffer / grpc / hardware-peak host modes.

**What the outlier looks like** (observation → hypothesis → experiment →
data → conclusion, as far as the delegation contract allows):

- *Observation.* Run 3 is the only run of twelve whose **tx** fps sits
  materially below 1600 (1530.6, ~5 % under) while its **rx** is the
  second highest of the set (1627.8). Its two failing metrics are both
  properties of the *inter-arrival distribution per id*, and both name
  `zonal/` ids.
- *Hypothesis.* The stutter is on the transmit side — the sidecar
  producing frames unevenly for 60 s — not on the read path this phase
  changed. A transmit that under-produces by 5 % widens and shortens
  inter-arrival gaps by construction, which is exactly what both
  metrics measure.
- *Experiment.* Two, since the contract rules out the obvious control
  (a run on the parent commit would mean switching branches, and a
  worktree is not permitted): (a) extend the population from four runs
  to twelve; (b) read what this phase actually added to the ingest and
  serve paths.
- *Data.* (a) Runs 4–12 — nine consecutive — are uniform and sit inside
  the band prior phases reported (p95 ratio 1.14–1.37, short-frac
  0.0025–0.028). The two elevated runs are 1 and 3, the earliest, taken
  minutes after two release builds. (b) The diff adds **nothing** to the
  ingest path (`TraceStore::append`, `decode_against`, the mux
  extractor, verification are all untouched); on the serve path, with no
  picks recorded — which is this workload — `picked_index` and
  `pick_path` return on `picks.is_empty()` before building an identity
  string, `scan_chunk` builds no pick vectors at all, and the per-name
  cost inside the existing decode loop is one bounds-checked `get` on an
  empty slice.
- *Conclusion.* The evidence says machine contention on the earliest
  captures, not a regression: the failing metrics track a transmit
  under-production this change cannot cause, and nine consecutive later
  runs are indistinguishable from the phase-3 baseline runs. It is
  **not** discarded and it is **not** ruled harmless by me — the failing
  report is reported here with the full population so the owner can rule
  on whether the rx-gap pair is jittery beyond the band its brief
  currently names (0.002–0.011), which two runs of twelve exceeded.

### Phase 5 — the remap pick (2026-08-20)

Branch `task-89-phase-5-remap-pick`, from `task-89-phase-4-ambiguity-pick`
(`d55f7910`). Two commits (`85780fd4` the shared operation, `33c8896a`
the panel's picker) plus this log. Frontend tests 2340 → 2367 (+27, 178
files, was 177), zero failures; `pnpm build` (tsc + vite) clean.
Workspace Rust tests unchanged at 1494 (the only Rust edit this phase is
a module-doc correction); `cargo test --workspace`, `cargo clippy
--workspace --all-targets` and `cargo fmt --all` all reconfirmed green.

**The one operation, and where it lives.** `remapSignal`
(`apps/gui/src/signalRemap.ts`) — one function over every store, with
`useRemapSignal` binding it to the live element registry and the
project's colour overrides. The ruling's "built once, not per store" is
the module's whole reason for existing, and its doc says so: a rewrite
spread across call sites is one missed store away from a repair that
silently did not happen, and *a new persisted signal reference anywhere
in the app belongs in here*.

| Store | What holds the reference |
| --- | --- |
| plot element `config` | each area's manual `signals`, and the area's `primarySignalKey` |
| signals element `config` | the manual `selection.keys`, and the `sections.assignments` entry keyed on the signal |
| colormap element | its one target signal (ADR 0029) |
| transmit pool (host) | a frame's calculated-field counter / CRC target (ADR 0027) |
| project `signal_colors` | the user's colour override for the signal (ADR 0026) |

**The test that proves the guarantee**, at both levels. At the
operation: `reaches every store from a single invocation`
(`signalRemap.test.ts`) — one `remapSignal` call, and all five stores
above are asserted to have moved. At the gesture:
`a remap pick reaches every view's stored reference from one gesture`
(`ViewSignalsPanel.dom.test.tsx`) — one `change` event on the picker,
and a **plot element's series** and a **colour map's target** both move,
two different stores neither of which the panel knows anything about.
That test renders the panel under a real element registry
(`registryTestKit`, real state and real `applyElementPatch`) rather than
a per-file fake, so what it observes is what a mounted view would.
`rewrites the transmit pool's calculated-field target in the same
gesture` covers the host-side store from the same click.

Falsified rather than assumed: deleting the colormap branch from
`remapElementPatch` fails both of those tests and nothing else, so
neither passes for a reason other than the store it names.

**How the panel's own rows come back.** Nothing new was built for this;
the rewrite lands on the chain phases 1–2 already wired, which is part
of why it had to be a rewrite of the element registry rather than a
host-side edit. `registry.update` is called **without a writer token**,
which is precisely the app's "this is an external write" signal:
`applyElementPatch` bumps `configEpoch`, `useElementRehydrate` re-reads
the config into the mounted panel's state (`setAreas` for the plot,
`setSelection` for the signals view; a colormap reads its element live
every render), the panel's `viewSignalRefs` memo recomputes, and
`usePushViewSignals` pushes — at which point the host emits
`view-signals-changed`, one of the two events this panel and its badge
already refetch on. The transmit half rides the same shape through
`transmit-frames-changed`. No manual refresh, and no fifth event.

**Closed views are rewritten too, and that is the point.** The panel
lists what the *open* views reference, but the registry holds every
element. A plot whose panel is shut has no row here and is rewritten
anyway, so reopening it does not resurrect the dead name — the ruling is
"every persisted signal reference", not "every visible one".

**What deliberately holds nothing to rewrite.** The ruling names the
signal generator and solo state among the stores; measured against the
code, neither carries a stored identity. A generator rule is a regex
matched against catalog signal *names* for a colour-wheel slot
(ADR 0026); solo is a regex over the canonical path, composed as a
view-layer mask that `plotSolo.ts` documents as never written back; a
plot area's `patterns` and the signals view's selection patterns are the
same. All four are re-evaluated against the live catalog every render,
so a rename makes them start (or stop) matching on their own, which is
what a user who typed a pattern asked for. This is the same split
`viewSignalsPush.ts` already drew for what a view *reports* here, and
for the same reason; it is recorded in `signalRemap.ts`'s module doc so
it does not read as an omission.

**Two stores the ruling did not name, both included.** A transmit
frame's calculated-field target (ADR 0027) is a persisted per-signal
identity and *does* become a row here (phase 2 wired its push), so
leaving it out would be exactly the silent miss the ruling warns of —
the panel reporting a repair while a frame still names the dead signal.
The project's `signal_colors` entry is keyed on the same identity: the
series is the same series under a new name, so the colour the user
picked travels with it. A target that already carries a colour of its
own keeps it, rather than being clobbered.

**The pick names a pair, so both halves are acted on.** The picker's
options are `(database, signal)`, and a remap option would otherwise
have made its database half decorative — two databases defining the
target would offer two options doing the same thing. So the operation
also records the chosen database for the *target* through phase 4's
`set_signal_dbc_pick`, which keeps only a real, non-default choice: in
the common case (one database defines the target) it records nothing and
announces nothing. Whatever was recorded against the **old** name is
dropped in the same breath — nothing references it any more, and a pick
nothing consults is precisely the durable indirection the ruling
rejected.

**It self-heals, and the residue is nil.** There is no undo path here
and no memory of the old name: revert the database and the panel reports
the difference the other way round, on the same row, through the same
picker. `round-trips a config when the opposite pick is made` pins the
symmetry — the opposite pick restores the config object exactly,
`toEqual` on the whole blob, so nothing accumulates across a
there-and-back.

**Small correctness calls, each with a test.** A rewritten reference
keeps every field it carried that the rename does not touch (a series'
colour pick, its hidden flag) and is **dropped** where the list already
holds the target, so a view that showed both the stale and the new name
does not end up with the same series twice. A **file-backed** series can
never match: its identity keys under its own flag, and no database ever
bore on it. An area's `primarySignalKey` follows the rename, and a
section assignment moves onto the new identity unless the target already
has a section of its own. Config blobs are edited structurally and
tolerantly (`unknown` in, `unknown` out) — every key the operation does
not understand rides through untouched, which a test pins on `cursorX`.

**Doc-vs-code fixes in passing.** `view_signals.rs`'s taxonomy said
Ambiguous was "the one status the panel can *resolve*"; it is now the
one it resolves **host-side**, with the remap named as a rewrite of
references the host deliberately does not interpret. README had no entry
for this panel at all — phases 2–4 shipped the panel, its badge and the
ambiguity pick without one — so it gains a paragraph covering the row
model, the attention badge and both picks.

**Recorded for task 92, not fixed here:** the remap rewrites what the
views *store*, so it is unaffected by the per-message decode paths that
do not honour phase 4's per-signal pick. The one boundary it touches is
the pick it records for the target, which inherits that same bounded
consequence and nothing more.

**Not touched:** `TraceStore::frame_index_at_ns` (task 91) — nothing in
this phase reads it.

#### ADR-0031 perf gate

`pnpm --dir apps/gui tauri build --no-bundle`
(`target/release/cannet-gui.exe`, frontend embedded), `cargo build
--release -p cannet-perf-measurement`; `examples/ev-zonal` at ~1608 fps,
`--connect-on-start`, `--perf-interact scrub`, four 60 s captures into
an isolated `--app-data-dir` (`scratch-perf/app-data`), gated by `cargo
run --release -p cannet-perf-measurement -- check --expected-rx-fps 1608
--expected-tx-fps 1608` (one `--frontend-report` per run) against the
committed `docs/performance-measurements/baseline.json`. **No baseline
was promoted and no gate limit was touched.** Reports are review
artifacts and stay out of the repository.

Four runs, `check` over all four: **passed, 87 metrics gated.** Every
metric read `ok`; nothing regressed and nothing widened.

| run | rx fps | tx fps | `rx_gap` p95 ratio worst | `rx_gap` short-frac worst | `lag_ms` max | `tree_mb` peak |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1607.2 | 1611.5 | 1.155 | 0.0008 | 3.1 | 724.5 |
| 2 | 1606.0 | 1608.8 | 1.167 | 0.0018 | 1.4 | **982.2** |
| 3 | 1602.4 | 1604.8 | 1.165 | 0.0007 | 21.7 | 732.6 |
| 4 | 1604.2 | 1607.1 | 1.168 | 0.0012 | 4.3 | 729.7 |

`ids_measured` is 173 on every run (no sidecar throttling — the
throttled fingerprint is 156). The rx-gap pair, the metric brief flagged
as twice having spiked unreproducibly, is the tightest and most uniform
of any phase so far: p95 ratio 1.155–1.168 against a 2.898 limit,
short-frac 0.0007–0.0018 against 0.166, with no run near either. The
three memory-drift metrics gate on the median across the four reports
and are all `ok` (`jsheap` 5.1 vs 24.1, `renderer` 38.4 vs 85.3, `tree`
70.3 vs 139.2), as are the tracebuffer / grpc / hardware-peak host
modes.

**One elevated reading, reported not chased:** run 2's `tree_mb_peak` is
982.2 MB against a 1492 limit, where the other three sit at 724.5–732.6
and prior phases reported 705–768. It passes, and it is nowhere near the
8233 MB sighting the brief names as unexplained; the other three runs of
this same build are inside the usual band, and this phase adds no
allocation to any path a capture exercises (the rewrite runs once per
user gesture, in the frontend, over the element registry). Recorded here
with the full distribution rather than discarded, per ADR 0031's
unreproducible-outlier rule.

### Phase 6 — the RBS variant (2026-08-20)

Branch `task-89-phase-6-rbs-variant`, from `task-89-phase-5-remap-pick`
(`a04b2589`). Five commits (`8ce9f186` the host model, `68cbc0d4` the
shared value cell, `99d67629` the grid, `17bf49da` the launcher + a bug
fix, `d0d93c15` README) plus this log. Workspace Rust tests
1494 → 1498 (+4), zero failures; frontend 2367 → 2418 (+51, 183 files,
was 178), zero failures; `cargo clippy --workspace --all-targets`
clean, `cargo fmt --all` applied, `pnpm build` (tsc + vite) clean. This
is task 89's last phase — both prototypes are retired (deleted,
`plans/prototypes/`), superseded by the shipped panels.

**The grid is the same one, not a second implementation.** "Same
component, opposite scoping rule" reads two ways once measured against
the code: `ViewSignalsPanel` and the new `RbsSignalsPanel` are two
panel components — their row shapes, columns, and editable value cell
differ enough (RBS rows carry a live signal editor and no
database/source picker) that one component branching on a mode would
read as a worse version of both, the same reasoning that already keeps
`ByIdView`/`SignalView`/`TraceView`/the DBC tree/the RBS tree/the
transmit list as separate components. What is genuinely one thing,
reused rather than copied, is the *gridview* ADR 0044 names —
`GridviewHeader`, `GridviewRow`, `useGridview`, `arrayRowSpace` — plus
the identical toolbar shape (status chips + a bus fly-out, nothing-
selected-is-no-filter, a toggleable wash, a footer shortcut to the
problem statuses). The opposite scoping rule is expressed as a
property of *which panel a row set is fetched into*, not a prop on a
shared component: `ViewSignalsPanel` is a singleton fetching every
open view's rows; `RbsSignalsPanel` is opened per element
(`showRbsSignalsPanel`, one instance per `elementId`, same "no second
copy" rule a singleton uses, just keyed by element) and fetches only
that element's rows. Recorded here for the record the grooming's own
phrasing invites a re-check: this is the reading measured against the
codebase's own established pattern for "one shared base, several thin
views," not the alternative (force one React component to cover both
domains).

**The shared clamp, and where it actually lives.** `rbsValueClamp.ts`
exports `clampToSignalRange` / `isOutOfSignalRange` /
`signalPhysicalRange`, called from exactly one place —
`RbsValueCell.commit` — so neither caller can clamp differently by
forgetting to call it: `RbsPanel.tsx`'s own tree and
`RbsSignalsPanel.tsx`'s value column both render `<RbsValueCell>`,
extracted this phase out of what was inline in `RbsPanel.tsx`'s
`SignalRow`. `signalPhysicalRange` also answers the DBC crate's own
documented edge case — `[0|0]` conventionally means "no declared
bound," so when `min == max` the range is derived from the signal's
raw bit width and factor/offset instead of leaving the value
unconstrained, which would otherwise make Out of Range unreachable for
every signal that never got an explicit `SignalMinimum`/`SignalMaximum`.

**Out of Range is decided in the frontend, and that forces this grid's
sort off the host.** The ruling is explicit that truncation on
transmit is correct and the check belongs in the frontend
(`rbsValueClamp.ts`); the host's `RbsSignalStatus` therefore has five
variants, not six. `rbsSignalsFilter.ts::rbsSignalDisplayStatus` is the
one place a host `Override` row is upgraded to `out-of-range` when its
decoded value sits outside `signalPhysicalRange`, and every renderer,
filter and sort in `RbsSignalsPanel.tsx` reads through this function,
never the bare host status. Because the full severity order depends on
that frontend fact, `rbsSignalsColumns.ts::sortRbsSignalRows` sorts
client-side instead of passing `sortKey`/`sortDir` to a host command
the way `list_view_signals` does — a deliberate divergence from the
task's own "RESOLVED" note on that point, which was scoped to the
views grid's model (phase 1) rather than binding on a status this
grid computes after the fetch. The row set stays bounded exactly the
way the views grid's is (one config's fields, not a capture's worth),
so `CLAUDE.md`'s paging rule has nothing to say against it.

**The taxonomy, and how each status is decided** — `rbs/signals.rs`,
one command (`rbs_signal_rows`) building rows from the same
`for_each_scoped_message` / `reconstruct_payload` the RBS runtime and
its own tree already share, so this grid cannot disagree with what
actually transmits:

| Status | Decided by |
| --- | --- |
| Muted | the message won't play: bus disabled, its DBC-transmitter ECU disabled, or message-muted — checked first, since nothing else matters once true |
| Not Encoded | an override names a signal absent from the message's descriptor, or a message no scoped DBC defines (or an unresolved bus) — `reconstruct_payload`'s `UnknownSignal` case, plus the message-level equivalent |
| Unknown Value | a real signal whose override text didn't resolve — `reconstruct_payload`'s `InvalidHex` / `UnknownEnumLabel`, both real, both distinguished as `OverrideProblem` variants but merged into one status per the taxonomy's own name |
| Override | the file sets it and it applied |
| Default | no override: the DBC's `GenSigStartValue`, or (when none) the file's fill bit — the detail column names which |

`OverrideWarning` (`rbs/runtime.rs`) replaces the plain `Vec<String>`
`reconstruct_payload` used to return, carrying a `signal: String` and
an `OverrideProblem` discriminant alongside the same human-readable
`message()` the system log already showed — so the taxonomy is
classified from structured data the encoder itself produced, never by
re-parsing warning text, and the RBS system-log wording is byte-for-
byte unchanged (`rebuild_element_rows` calls `.message()` where it
used the raw string before).

**Not Encoded splits cleanly from Unknown Value, and the split is the
same one the encoder already draws.** "Unknown signal" means there is
no signal to hang a decode on at all — the RBS analogue of the views
panel's "no database defines it," so it reads Not Encoded. "Invalid
hex" / "no enum label" mean the signal is real and every *other* field
of the message keeps encoding correctly; only this one override's text
didn't resolve, so the default goes out instead — Unknown Value. The
prototype's own two examples (`GearTarget: "0xZZ"`, `DriveMode:
"Sport"`) are both this second case; `DoorAjar` in the prototype (an
override naming a signal nothing defines) is the first. Both are
regression-tested (`a_bad_enum_label_reads_unknown_value_not_not_encoded`,
and `statuses_reflect_the_encoders_own_report`'s `ghost`/`phantom`/
`whatever` rows for the three Not Encoded shapes: unknown signal on a
resolved message, a message no DBC defines, and an unresolved bus).

**`ecu_name` had to be added to the row, and here is why.** An edit
routes through `rbs_set_signal(elementId, target, signal, value)`,
where `target.ecu` is a plain string key `entry_mut`
(`rbs/commands.rs`) files a *fresh* override under verbatim — get it
wrong and a new override lands under the wrong ECU, which then warns
as a transmitter mismatch. The row therefore carries the DBC's own
transmitter grouping (`ecu_name` from `for_each_scoped_message`), the
same key `RbsPanel.tsx`'s tree already uses for every edit it makes,
so the grid's edits and the tree's edits are indistinguishable to the
file. Not encoded rows carry the file's own ECU key as a matter of
completeness (there's no edit to route, since the value cell disables
itself) rather than leaving the field with no defensible value.

**`bus_id` is the resolved project id, not the file's bus key.**
`RbsSignalRow.busKey` is the file's logical-bus name (shown in the
grid, matches the RBS tree's own bus column); `RbsSignalRow.busId` is
the resolved project bus id or `null`, which is what the value-table
fetch (`useValueTables`) needs for an enum signal's `VAL_` labels —
the same distinction `RbsBusView` already draws for the tree. An
earlier draft conflated the two (passing the file's bus *name* as if
it were the project bus *id*), which would have silently broken enum
lookups for every RBS grid row; caught before it reached a commit.

**Bug found and fixed in passing, in code this phase touched anyway**
(observation → hypothesis → experiment → data → conclusion):

- *Observation.* Extracting `parseSignalText` verbatim out of
  `RbsPanel.tsx` into the shared `rbsValueCell.tsx` was meant to be a
  pure move, no behaviour change — but writing
  `rbsValueCell.dom.test.tsx`'s hex-entry test against the moved
  function first (before touching its body) failed:
  `parseSignalText("0xA", [])` returned `10`, not `"0xA"`.
- *Hypothesis.* `Number("0xA")` is a valid JS numeric literal (`10`),
  and the function checked `Number.isFinite(Number(t))` *before* the
  `/^0x[0-9a-fA-F]+$/` regex — so any hex override whose digits are
  all valid decimal-parseable hex (which is every one) never reaches
  the hex branch at all.
- *Experiment.* Ran the pre-existing (pre-move) `parseSignalText`
  against `"0xA"` and `"0x1F"` directly, before any edit.
  Reordered the checks (hex prefix before `Number()`) and re-ran the
  RBS panel's own DOM tests to confirm nothing that exercises numeric
  or enum entry regressed.
- *Data.* Pre-fix: `parseSignalText("0xA", [])` → `10`;
  `parseSignalText("0x1F", [])` → `31`. Post-fix: `"0xA"` and `"0x1F"`
  verbatim. `RbsPanel.dom.test.tsx` (22 tests) and
  `rbsValueCell.dom.test.tsx` (11 tests) both green after.
- *Conclusion.* Confirmed: a hex override typed into the RBS panel's
  own tree — before this phase touched anything — was silently sent
  as `RbsValue::Number(10)` (a *physical* value) instead of
  `RbsValue::Text("0xA")` (*raw bits*), which differ whenever the
  signal's factor/offset aren't `(1, 0)`. Fixed at the one shared call
  site both panels now use; regression-guarded at the pure-function
  level and end to end through the input
  (`rbsValueCell.dom.test.tsx`'s "the hex-override bug, end to end
  through the input").

**Second bug found in passing: `removeElement` leaked a panel.**
`App.tsx` located "the" panel for a removed element with `.find` and
removed just that one. Harmless while every element had exactly one
panel; this phase's launcher makes an RBS element's signals grid a
*second* panel over the same `elementId`, so `.find` would leave it
open, pointing at a project element that no longer exists. Extracted
the lookup into a pure `panelsForElementId` (`dockLayout.ts`) and
switched `removeElement` to iterate every match; regression-guarded
directly on the pure function rather than through a full `App` mount
(no existing test drives element removal through the real UI, and
building that harness from scratch was judged the wrong size of fix
for a one-line defect with an easy pure-function repro).

**The focused-panel-kind collision, named and closed before it
shipped.** Both of an RBS element's panels carry the same `elementId`
in their dockview params, and `panelCommands.ts`'s registry is keyed
by `elementId` alone (one entry per id, last-registered wins) — so a
naive reuse of the "rbs" focus kind would have let `panel.find` /
`panel.rename`, fired while the signals grid is focused, silently
reach into the *other*, unfocused panel's registration. Closed two
ways: `panelKindForFocus` checks the panel id's `rbs-signals-` prefix
before it ever looks at `elementKind`, reporting a distinct
`"rbs-signals"` kind (added to `FOCUSED_PANEL_KINDS`, deliberately left
out of `RENAMEABLE_PANEL_KINDS` / `FINDABLE_PANEL_KINDS`, so those
commands are simply unavailable while this panel is focused); and
`RbsSignalsPanel` never calls `usePanelCommands` at all, so it never
touches the shared registry map in the first place. Both are load-
bearing on their own; kept both rather than picking one, since either
alone leaves the other panel's behaviour to infer.

**The panel title, and the one place "element" must not appear.**
`elementPanelTitle(panelId, elementLabel)` is the single function that
decides an element-backed panel's tab text: verbatim for every
existing panel, `"‹config name› — Signals"` for one whose id carries
the `rbs-signals-` prefix. It replaces the bare `elementLabel(...)`
call inside `App`'s existing title-sync effect (the one that already
walks every panel and heals a stale title after a rename) — without
this, that effect would have overwritten the grid's own title back to
the bare config name on the next rename, since it does not otherwise
know the signals panel is not the element's primary one.

**What a pick here does not reach, named rather than silently
scoped.** The grid's row set, like the RBS tree's own, is drawn from
`for_each_scoped_message` over the *currently assigned* DBCs; an
unresolved bus contributes rows only for the overrides its file
entries actually list (there is no DBC to enumerate "every signal"
from), matching the ADR 0028 "renders inert, never a load failure"
rule and the phase 1 precedent of not fabricating rows the model
cannot back with a fact.

**Not touched:** `TraceStore::frame_index_at_ns` (task 91); the
per-message decode paths task 92 names are the *view*-signals side of
this task, not the RBS side — this phase's rows come from
`reconstruct_payload`/`for_each_scoped_message`, which task 92 does
not name and this phase did not change the resolution rule of.

**Prototypes retired.** Both `plans/prototypes/view-signals-panel.html`
and `plans/prototypes/rbs-signals-panel.html` are deleted (committed
alongside the host model, `8ce9f186`) — their entire purpose was
pre-implementation guidance for phases 1–6, and both are now
superseded by the shipped panels. The task file's own "Prototypes"
list above (out of this phase's remit — everything above the status
log is the owner's) still names their paths; git history keeps the
files for anyone who wants to see what they looked like.

#### ADR-0031 perf gate

`pnpm --dir apps/gui tauri build --no-bundle`
(`target/release/cannet-gui.exe`, frontend embedded), `cargo build
--release -p cannet-perf-measurement`; `examples/ev-zonal` at ~1608 fps,
`--connect-on-start`, `--perf-interact scrub`, four 60 s captures into
an isolated `--app-data-dir` (`scratch-perf-p6/app-data` — a fresh
directory of my own, since the delegation contract reserves the
existing untracked `scratch-perf/` for the owner), gated by `cargo run
--release -p cannet-perf-measurement -- check --expected-rx-fps 1608
--expected-tx-fps 1608` (one `--frontend-report` per run) against the
committed `docs/performance-measurements/baseline.json`. **No baseline
was promoted and no gate limit was touched.** Reports are review
artifacts and stay out of the repository (`scratch-perf-p6/` is
untracked, left alone the same way `scratch-perf/` is).

Four runs, `check` over all four: **passed, 87 metrics gated.** Every
metric read `ok`; nothing regressed and nothing widened.

| run | rx fps | tx fps | `rx_gap` p95 ratio worst | `rx_gap` short-frac worst | `lag_ms` max | `tree_mb` peak |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1603.6 | 1608.4 | 1.159 | 0.003 | 3.4 | 717.6 |
| 2 | 1607.4 | 1610.1 | 1.147 | 0.002 | 2.8 | 718.8 |
| 3 | 1606.8 | 1610.0 | 1.181 | 0.003 | 3.7 | 703.1 |
| 4 | 1607.8 | 1609.9 | 1.206 | 0.003 | 11.7 | 723.5 |

Every value sits comfortably inside its limit (`rx_gap_p95_ratio_worst`
2.898, `rx_gap_short_frac_worst` 0.166) and inside the bands prior
phases reported — no repeat of either of the two unreproduced
outliers ADR 0031's own rule flags (the 0.194/0.236 `rx_gap` spikes, or
the 8233 MB `tree_mb_peak` sighting); `tree_mb_peak` (703.1–723.5 MB)
sits inside the 705–768 MB range prior phases reported, `lag_ms_max`
(2.8–11.7) inside the 1.1–29.4 band task 89's own brief names as
known-jittery. The three memory-drift metrics gate on the median across
the four reports (`jsheap_mb_drift_per_min` 0.357 vs a 24.094 limit,
`renderer_mb_drift_per_min` 40.568 vs 85.336, `tree_mb_drift_per_min`
72.377 vs 139.240), all `ok`. Host modes (tracebuffer/grpc/
hardware-peak) gated on their own baselines and were all `ok` too,
unaffected by a frontend-only change.

## Inherited ruling — RBS problems may be reported together (2026-08-21)

Task 103's status-bar prototype introduced an **RBS mapping chip**: the
RBS counterpart of the Signal mapping chip, badged with the count of
notes and warnings across the project's RBS configurations. It cannot
open one `.cannet_rbs` file, because a project may have several.

That collides with phase 6's rule that the RBS signals grid is scoped
to a **single** element, since two RBS configs are meant to carry
different values and never combine. The owner's accepted resolution
narrows that rule rather than overturning it:

> **Combining is fine for reporting, and forbidden for editing.**

So a view may list every config's problems together, naming which
config each belongs to; acting on one enters that config's own grid,
where values are still edited one file at a time. Phase 6's reasoning
survives intact — configs are not combined because their *values* are
independent, not because their *faults* are.
