# Task 92 — One Resolution Rule, Not Eleven Copies

> **Status 2026-08-23 — code-complete, awaiting acceptance.** All three
> phases landed 2026-08-21 on the chain (nothing has merged). The five
> exit criteria are walked in phase 3's entry, all met; Shape D stays open
> by owner ruling (owner-review-queue 2.1). Findings still owed a verdict:
> owner-review-queue 1.2, 1.3, 3.1, 3.2.

Opened by owner instruction 2026-08-20 ("sweep, with findings as
cleanup task"), immediately after
[ADR 0054](../../docs/adr/0054-a-decoded-value-has-one-definition.md)
was written. The ADR states that a decoded CAN signal value has exactly
one definition, and that anything derived from it depends on that
definition and nothing else. This task makes the code say so.

## What the sweep found

Every site that answers "which database supplies this?" spells the rule
out for itself. There are **thirteen `filter::dbc_applies` call sites**,
and among them at least **two distinguishable semantics** — which means
two of them must be wrong, because ADR 0054 says there is one rule.

### Shape A — "the first eligible database that *has* the thing"

```rust
dbs.iter()
   .filter(|d| filter::dbc_applies(&d.buses, bus_id))
   .find_map(|d| d.db.SOMETHING(..))
```

| site | what it looks for | verdict (phase 1) |
|---|---|---|
| `dbc_commands.rs:609` (`list_value_tables`) | a `VAL_` table for the signal | **defective — fixed** |
| `app_state.rs:523` | the DBC default for calculated fields | already correct |
| `verification.rs:142` | the same calculated-field default | already correct |
| `transmit_commands.rs:79` | the same again | already correct |
| `app_state.rs:478` (mux extractor) | a decodable mux selector | correct per signal; one per-*frame* exposure |

**Why this is suspect, not merely duplicated.** It skips *past* the
database that actually decodes the signal to a later one that happens
to carry the attribute being looked for. So enum labels, or a
counter/CRC default, can come from a database that is not decoding the
value they are attached to — which ADR 0054 part 3 forbids. Under the
ADR the answer should be *the winner's* `VAL_` table, and if the winner
has none, then there are no labels; borrowing from a different file is
the defect, not the fallback.

**Measured 2026-08-21 (phase 1): one of the five is a defect.** The
constructed case — winner defines the signal but carries no `VAL_` / no
calc fields, a later eligible database on the same bus carries both —
was built per site and run. Only `list_value_tables` borrowed: it
answered `["Zero", "One"]` for a signal whose winning definition
declares no labels. The three calculated-field sites turn on
`Database::dbc_calculated_fields` returning `Some` — an *empty* config
— for any message the database defines, so `find` / `find_map` already
stops at the first assigned database that **defines the message**; they
look like Shape A and are not. The mux extractor resolves per signal
and is likewise correct for this case. Data per site is in the status
log; what is left over is under Blockers / side effects. Task 86 fixed
the *bus scoping* half of this family — "enum labels no longer come
from a database that can't decode the signal" — and this was the
remaining per-signal half.

### Shape B — resolving per *message* where the rule is per *signal*

`trace_query.rs:655` decodes a trace row via
`find_map(|(db, _)| db.decode_raw(id, ..))` — the first eligible
database that decodes the **message**. But resolution is first-wins
**per signal**, pinned by `first_dbc_wins_per_signal_not_per_message`
(`signal_cache.rs`), which is how the signal cache resolves.

So on a collision the trace row's decoded columns and the plotted
series can be sourced from **different databases for the same signal**.
Same value, two answers, no warning. This is the sharpest finding in
the sweep and should be verified first.

**Measured and fixed 2026-08-21 (phase 2).** Two databases on one bus
both defining `256/"A"`, a.dbc at unit scale and b.dbc at ×10, with the
project pinning `A` to b.dbc: the row read **3** and the plot read
**30.0** — one value, two answers. Reversing the load order and the
pick reversed the divergence (row **30**, plot **3.0**), so it was the
resolution rule and not the order. Both now read the picked database's
definition. The same walk backed the signals view's latest value
(`decode_snapshot_frame`) and it moved with it. Details in the status
log.

### Shape C — the canonical one

`signal_cache.rs:1009` builds the eligible list and then resolves
per signal, honouring picks. This is the behaviour ADR 0054 describes,
and it is the one the others should reduce to.

### Shape D — resolving per *frame* where the rule is per *signal*

Found by [task 88 phase 8](0088-bus-assignment-governs-decode.md) on
2026-08-21, while making the encoding fingerprint identify the winning
definition. It is the sharpest of the four because it is **measured,
not inferred from code shape**, and because it is what makes Shape B's
fix incomplete on its own.

`signal_sampler::sample_shared` takes the first eligible database that
yields the signal **for that payload**. A database can withhold it — a
multiplexor arm that does not match, a payload too short — and the next
one answers. So the database that decodes a signal can differ *frame to
frame within one series*.

**The measurement** (phase 8, pinned as
`a_value_the_winner_withholds_is_outside_the_fingerprint`): `a.dbc`
defines `S` only in mux arm 0, `b.dbc` defines it plainly, both assigned
to the same bus with `a.dbc` first. A frame in arm 1 decodes to 7.0 via
`b.dbc`. Editing `b.dbc` moves that sample to 18.0 — and the series'
fingerprint sits at `476b04dbda88b07e` either way.

**Two things are wrong at once, and only one is the fingerprint's
fault.**

1. *Under-invalidation.* An edit to `b.dbc` moves samples the
   fingerprint cannot see, so the pyramid is not rebuilt. Narrow —
   two assigned databases, one signal, one bus, the second reached only
   through an arm the first withholds — but real.
2. *The value has two definitions.* Which is what ADR 0054 says cannot
   happen. Under the ADR, if the winner withholds a value for this
   payload then there is no value, the same way there are no enum
   labels when the winner carries no `VAL_` table (Shape A). The
   fall-through is the defect; the fingerprint is merely honest about
   only knowing the winner.

**Why it belongs here rather than in task 88.** Closing it means
removing the decode fall-through, which *changes decoded values* — a
series that shows samples today would show gaps. Phase 8 correctly
implemented its ruling as written, named the exposure in ADR 0047's
amendment, and pinned it so a future change has to move the test
deliberately. Taking the decision is this task's job, because it is the
same decision as Shape A's and Shape B's: **one rule, applied per
signal, at every site.**

**This is an owner decision, not an implementer's.** Removing the
fall-through is the reading ADR 0054 requires and it makes a currently
populated series go empty in the mux case. Surface it before
implementing; do not let a phase agent choose.

### Already accounted for elsewhere

`signal_fingerprint.rs`'s two sites were
[task 88 phase 8](0088-bus-assignment-governs-decode.md)'s work — the
fingerprint hashing the candidate's whole bus list and every eligible
candidate rather than the winner — and **landed 2026-08-21**
(`d739e419`). `dbc_encoding` now walks in load order, honours a pick by
its index over the eligible sequence, and `break`s at the winner. Not
duplicated here; but the phase's own measurement of what that walk
cannot see is Shape D above, which *is* this task's.

## Why this is load-bearing, not tidying (2026-08-20)

Task 89 phase 4 shipped the ambiguity pick and hit exactly this
boundary from the other side. The pick reaches the per-**signal**
decoder, the fingerprints and the panel's model. It does **not** reach
the per-**message** paths — the trace rows (`decode_against`), the
signals view's latest value (`decode_snapshot_frame`), or the
descriptor catalog's dedup (`scoped_descriptors`) — because honouring
it there means splitting one message's decode across two databases.

The consequence lands directly on the owner's motivating case. Grooming
recorded it as: *a client-facing DBC alongside a private one carrying
extra enum values*. Picking the private database gets the user the
right decode, **but not the extra enum labels**, because labels come
from the catalog, which resolves per message and never sees the pick.
So the feature answers the question it was built for only halfway until
this task lands.

Phase 4 surfaces rather than hides it — such a row reads **Scale** in
the panel — but "visible" is not "working".

## Scope

- **Verify each Shape A site** with a constructed case before changing
  it. A site that turns out already correct gets a test pinning it and
  nothing else.
- **Shape B is settled (owner ruling 2026-08-20): per signal, with a
  per-message fast path when nothing is picked.** A message keeps
  today's single `decode_raw` call unless some signal in it carries a
  pick; only then does that message resolve per signal. This satisfies
  [ADR 0054](../../docs/adr/0054-a-decoded-value-has-one-definition.md)
  — a value has one definition, and the trace row now agrees with the
  cache and the plot — while leaving the serve path's hot case exactly
  as it is, because the ambiguous case is uncommon by design (grooming's
  expected shape is a client-facing DBC alongside a private one, not two
  databases genuinely defining the same message).

  Consequences to implement deliberately, not discover:
  - **A message row may show signals from two databases.** That is the
    correct outcome under ADR 0054 and must not be treated as a bug when
    a test surfaces it.
  - **The branch must be cheap to evaluate.** "Does this message have a
    pick" is asked per frame on the serve path, so it needs to be a
    lookup, not a scan of the pick map. An empty pick map — every
    project that has never met an ambiguity — must short-circuit to
    today's path with no measurable cost.
  - **Test that a collision produces one answer everywhere**: trace row,
    plot, value tables, calculated fields.
  - Measure the fast path against the pre-change build; a project with
    no picks must not regress.
- **Shape D needs an owner ruling before any code.** Removing the
  per-frame fall-through is what ADR 0054 requires and it makes a
  currently populated series go empty where the winner withholds the
  value in a mux arm. Put the question to the owner with the phase 8
  measurement in hand (7.0 → 18.0 under an unchanged fingerprint), and
  do not let the implementing phase choose. If the ruling is to close
  it, `a_value_the_winner_withholds_is_outside_the_fingerprint` is the
  test that has to be turned around, deliberately.
- **Reduce the copies to one shared resolver.** `first_dbc_on_bus`
  (`app_state.rs:369`) is the nearest existing thing and already honours
  assignment-filtered load order; `signal_snapshot::definition_index`
  (task 89 phase 1) is the other candidate, already shared by the
  collision detector and the panel model. Pick one, express the
  per-signal-versus-per-message distinction explicitly in its API rather
  than leaving each caller to imply it, and move the sites onto it.
- **Cite ADR 0054** from the shared resolver, so the next reader has
  something durable to check against — the absence of exactly that is
  what let eleven copies drift.

## Shape D ruled: accept the fall-through, make the pick reach everywhere (owner, 2026-08-21)

**The ruling, in the owner's words:** *"User can cure anything that
doesn't match using the signal view. A special case on mux arm is pretty
esoteric and I'm ok with it being wrong given you can just fix it."*

So the per-frame fall-through **stays**. Neither
`signal_sampler::sample_shared` nor `app_state::refresh_mux_extractor`
is changed to withhold a value the winning definition does not cover,
and the two tests pinning the exposure —
`a_value_the_winner_withholds_is_outside_the_fingerprint` and
`a_selector_the_winner_withholds_is_read_from_the_next_database` — stand
as the record of an accepted trade, not as bugs awaiting a fix.

The reasoning is the affordance, not the rarity: a user who sees a value
resolved against the wrong file picks the right one in the signal view,
and the pick is honoured. Closing the fall-through instead would empty
series that show samples today, to spare a case the user can already
fix in one gesture.

**One correction to the premise, verified before recording this.** The
cure is real at the sampler and only there:

- `sample_shared` honours picks exactly as the ruling assumes. Its own
  rustdoc states the contract — *"A pinned name takes its value from
  that database or from none: falling through to the next database
  would put back exactly the silent substitution the pick was made to
  stop"* — and the walk skips every database but the picked one.
- `refresh_mux_extractor` **does not consult picks at all.** It
  snapshots every database with a multiplexor and resolves by load
  order, so a user seeing the wrong mux arm cannot currently pick their
  way out of it.
- Phases 1 and 2 found the same gap at `list_value_tables_inner` and at
  the three calculated-field sites: all resolve without reference to
  the pick map.

The ruling still lands where it was aimed — the owner named the mux-arm
case specifically as the esoteric one they accept wrong. But *"you can
just fix it"* is not true at three of the four sites today, and the
ruling's whole justification is that it is. **So the consequence for
phase 3 is to make the premise true rather than to close Shape D:**
route every site that answers "which database supplies this" through a
resolver that honours picks. Nothing a user sees changes unless they
make a pick — no series goes empty, no value moves — and the cure the
owner is relying on becomes universal instead of covering one site in
four.

## Phase 2's asymmetry: close it (overseer, 2026-08-21)

Phase 2 recorded a real consequence of reading "that message resolves
per signal" literally: a picked message's row also reports signals the
message's first defining database does not define, so **whether a row
reports such a signal depends on whether the message carries a pick**.
The phase asked phase 3 to decide.

**Decided: close it, by making the fast path exact.** The literal
reading was right — the rejected alternative did invent a third rule,
neither per message nor per signal — but the asymmetry it leaves is not
something to keep. A signal that only a later database defines has, by
ADR 0054, exactly one definition; whether some *other* signal in the
same message carries a pick has nothing to do with it. A fast path that
changes which signals appear is not an optimisation, it is a second
resolution rule wearing an optimisation's clothes, which is the exact
thing this task exists to end.

**How, without paying for it per frame.** Which signals a message can
yield is a property of the loaded set, not of the picks or the payload,
so it is answerable once per `DecodeModel` — the same shape as phase
2's `message_has_pick`: *does any eligible database define a signal
this message's winner does not?* Overwhelmingly the answer is no, and
that message keeps today's single `decode_raw` call. Where the answer
is yes, the message resolves per signal exactly as a picked one does.
The branch stays a lookup with an emptiness short-circuit, and the
no-collision project — every project that has never loaded two
databases defining one message — pays nothing.

Measure it the way phase 2 measured its branch: in-process, against the
real pre-change build, min and median ns/frame. If the precomputation
turns out not to be cheap, say so with the numbers and keep the
asymmetry rather than paying for exactness on the serve path — but
measure before conceding it.


## Phases (overseer, 2026-08-21)

Investigation before change, then the settled ruling, then the
consolidation — so no site moves onto a shared resolver before anyone
knows what that site is supposed to do.

1. **Verify the five Shape A sites.** Build the constructed case per
   site (the winner defines the signal but carries no `VAL_` / no calc
   fields; a later eligible database carries both) and let the data
   decide. A site that is already correct gets a test pinning it and
   nothing else. No fixes in this phase beyond what a confirmed case
   demands — the point is to know which of the five are defects before
   designing anything.
2. **Shape B: per signal, with a per-message fast path.** The owner's
   ruling of 2026-08-20, implemented as written, including the three
   consequences the scope names — a row may legitimately show signals
   from two databases, the "does this message carry a pick" test must
   be a lookup rather than a scan, and an empty pick map must
   short-circuit to today's path at no measurable cost.
3. **One shared resolver.** Reduce the copies, move every verified site
   onto it, express the per-signal-versus-per-message distinction in
   its API rather than leaving each caller to imply it, and cite
   ADR 0054 from its rustdoc. It carries three things the earlier
   phases deliberately left it:
   - **The pick reaches every site.** `list_value_tables_inner`, the
     three calculated-field sites and `refresh_mux_extractor` all
     resolve without consulting the pick map. This is what makes the
     owner's Shape D ruling true rather than nearly true — see the
     ruling above.
   - **Phase 2's asymmetry closes**, by making the per-message fast
     path exact rather than by keeping a second resolution rule.
   - Phase 2's `decode_snapshot_frame` removal is the pattern: the
     copies go away by moving onto shared resolution, not by adding a
     wrapper over them.

**Shape D is not closed in any of these phases** — ruled 2026-08-21,
the fall-through stays. What phase 3 owes it is the pick reaching
every site, not a fix.

## Exit criteria (draft — firm at grooming)

- One shared resolver; every `dbc_applies` site that answers "which
  database supplies this" goes through it, or is documented as
  deliberately different with the reason stated.
- A collision resolves to the same database in the trace row, the plot,
  the value tables and the calculated fields; tested.
- No derived attribute comes from a database other than the one
  decoding the value; a case per Shape A site.
- Shape D is either closed — a value the winning definition withholds
  is no value, and `a_value_the_winner_withholds_is_outside_the_fingerprint`
  is turned around to say so — or left open with the owner's ruling
  recorded and the test still pinning the accepted exposure.
- The shared resolver's rustdoc cites ADR 0054.

## Blockers / side effects

Recorded by phase 1, 2026-08-21.

- **The mux extractor falls through per frame, the way the sampler
  does.** `app_state::refresh_mux_extractor`'s closure asks each
  eligible database in turn for `decode_mux_selector` and takes the
  first that answers *for that payload*. Where the winner defines the
  multiplexor but cannot read it out of this frame — selector in byte
  7, three-byte payload — the next database answers, and the mux index
  holds a selector the winning definition never produced. Measured:
  `a.dbc` (first on the bus) puts `Mux` at bit 56, `b.dbc` at bit 0; a
  `[1, 7, 0]` frame yields selector `1`, from b.dbc. Pinned as
  `a_selector_the_winner_withholds_is_read_from_the_next_database`
  (`tests.rs`), **not** fixed: it is the same decision as Shape D's —
  closing it changes what the per-signal latest-value view shows — and
  Shape D is an owner ruling. Whoever rules on Shape D should rule on
  this in the same breath; they are one question asked at two sites.
- **Calculated-field resolution is per message, not per signal.** The
  three calc sites resolve the whole designation — counter signal and
  CRC signal both — against the first database that defines the
  *message*. ADR 0054 resolves per **signal**, so a message whose
  counter signal is defined by one database and whose CRC signal is
  defined by another has no expressed answer today. No case was built
  for it (the phase's constructed case is the per-signal `VAL_` one)
  and it is exotic; named here so phase 3's shared resolver decides it
  deliberately rather than inheriting per-message resolution by
  accident.
- **`list_value_tables` does not consult the per-signal database pick.**
  The fix makes it read the first *defining* database in
  assignment-filtered load order, which is the pre-pick half of
  ADR 0054 part 2. A project that has recorded an explicit pick for the
  signal still gets labels from load order. That is exactly the gap the
  task's own "Why this is load-bearing" section describes from the
  other side, and closing it belongs to phase 3's shared resolver,
  where picks are already honoured.
Recorded by phase 2, 2026-08-21.

- **How "resolves per signal" was read on the slow path.** The ruling
  says a picked message "resolves per signal". Taken literally, that is
  the same resolution the catalog and the caches use — every signal any
  eligible database yields, from the first that *defines* it, or from
  the one a pick names. So a picked message's row also reports signals
  the message's first defining database does not define, which the
  fast path has never reported. The alternative reading — substitute
  only the picked signals into the first database's decode — was
  rejected because it invents a third resolution rule, one that is
  neither per message nor per signal, for the single case where the
  code has just been told to be exact. The consequence is named
  because it is a real asymmetry: **whether a row reports such a signal
  now depends on whether the message carries a pick.** It is additive
  (no value that appeared before changes, and the ones that appear are
  the ones the plot has always shown), and it is pinned by
  `a_signal_only_a_later_database_defines_reaches_the_row_once_the_message_is_picked`.
  Phase 3 should decide whether the shared resolver keeps the
  asymmetry or closes it by making the fast path exact.
- **A pick still does not reach the value tables or the calculated
  fields.** Phase 1 recorded the `list_value_tables` half; the three
  calculated-field sites are the same. Measured: with `A` pinned to
  b.dbc, the row and the plot both read b.dbc's ×10 value while
  `list_value_tables_inner` answers a.dbc's (empty) table and
  `resolve_effective_calc` answers a.dbc's (absent) designation — so
  b.dbc's `VAL_` labels and its `CannetCounter` / `CannetCrc` are
  invisible to a project that chose it. Pinned as
  `a_pick_does_not_yet_reach_the_value_tables_or_the_calculated_fields`
  rather than fixed: both resolve per *message*, and moving them onto
  the resolution the decode uses is phase 3's shared resolver. This is
  the remaining half of the motivating case in "Why this is
  load-bearing" — the private DBC now decodes the value **and** labels
  it in the trace row (the label rides on the decoded signal), but the
  plot's symbolic axis and the enum dropdowns still read the
  client-facing file's table.
- **Four more serve paths now build a `DecodeModel` per serve.** The
  trace page, the filtered page, the by-id snapshot and the filter
  index's refresh each build one where they previously passed the
  loaded-set guard straight through. Measured at **77–143 ns per
  serve** (one `DbcScope` vec plus an `Arc` clone of an empty pick
  map), against a serve that decodes hundreds to hundreds of thousands
  of frames. Named rather than optimised: phase 3's shared resolver is
  where a cheaper carrier would belong if one is ever wanted.
- **`RbsElementState` is re-exported `#[cfg(test)]` from `rbs`.** It is
  the value type of `RbsRuntime::elements`, a public field, and was not
  nameable outside `rbs` — so a test standing host state up by hand
  could not build one. Test-only, to keep a warning-free non-test
  build; if a production caller ever needs it the `cfg` comes off.

Recorded by phase 3, 2026-08-21.

- **A sixth Shape A site the sweep never listed, and the one place
  phase 3 changed an answer with no pick in sight.**
  `VerificationState::rebuild_configs`'s *default* loop enumerated
  `Database::calculated_field_messages()` — which filters to the
  messages that **declare** calculated fields — and took the first
  entry per `(bus, id)`. So a database behind the winner could
  designate a counter on a message it does not supply. It applies no
  `dbc_applies` filter (it iterates `loaded.buses` directly), which is
  why the thirteen-site sweep did not see it. Measured before
  changing it: with `a.dbc` supplying `256` and designating nothing and
  `b.dbc` behind it designating both, `verifier.wants` said **true**
  while `resolve_effective_calc` said **none**; reversed, both said
  yes. So the ingest verifier and the transmit path disagreed about the
  same message. Fixed and pinned as
  `a_designation_the_defining_database_never_declared_is_not_borrowed`.
  Named prominently because it is the single deviation from "nothing a
  user sees changes unless they have made a pick": a project relying on
  a designation borrowed from a non-supplying database loses that
  verification, which is exactly what phase 1's `list_value_tables`
  fix did to borrowed enum labels.
- **Calculated-field resolution stays per message — decided, not
  inherited.** Phase 1 asked phase 3 to take this deliberately. Taken:
  `DecodeModel::message_source` is per message and its rustdoc says
  why. A `CannetCounter` designation names a signal and resolves to a
  bit placement *on the message entry that declared it*
  (`Database::resolve_calculated_fields`), so counter-from-one-file
  plus CRC-from-another is not a statement any database made. The pick
  still reaches it: a pick on **any** signal of the message selects
  that database for the message-level facts, and where two picks on one
  message name two databases the earlier in load order wins, so the
  answer is a function of the project rather than of map iteration
  order.
- **`message_spans_databases` is a gate, not the exact question.** The
  overseer's ruling asks "does any eligible database define a signal
  this message's winner does not"; the index answers the cheaper
  superset "does more than one loaded database define this id", over
  message ids rather than signals, and ignores buses. Where it
  over-answers, the message resolves per signal and lands on the same
  values — a slower decode of one message, never a different answer.
  Computing the exact question would mean walking every signal of every
  database instead of every message.
- **The split-message index is a third thing
  `invalidate_derived_caches` must drop.** It costs 63.6 µs to build
  for two 500-message databases and 140.2 µs for five, so it is cached
  against the DBC set beside `DescriptorSnapshot` rather than built per
  serve. That gives it `DescriptorSnapshot`'s failure mode too: a
  future path that mutates the loaded set without going through
  `invalidate_derived_caches` would serve a stale index — which for
  this one means a message that has just become ambiguous keeping the
  fast path until something else invalidates.
- **`signal_snapshot::DefinitionIndex::resolved` still expresses the
  pick rule a second time.** Deliberately not folded in: it resolves
  over an already-built definer list (`Vec<&str>` of paths) for the
  panel that *reports* the ambiguity, and its consumers — the collision
  detector and the panel model — need the whole candidate list, which
  `signal_source` deliberately does not return. Its rustdoc names
  `DecodeModel::picked_index` as the rule it mirrors. Named so a reader
  knows it is a mirror rather than a fourth rule; folding it in would
  mean giving the resolver a "return the chain, not the winner" mode,
  which is the API shape this task exists to avoid.
- **The mux extractor resolves the pick against each candidate's own
  multiplexor signal name.** Where two databases name their multiplexor
  differently, a pick on one does not exclude the other and the
  per-frame fall-through decides between them. Consistent with the
  accepted Shape D trade, and more esoteric than the case the owner
  already ruled on; no case was built for it.
- **`decode_frame` and `encode_frame` can now disagree in one narrow
  case.** The panel's decode resolves per signal
  (`decode_resolved`, ADR 0054), its encode per message
  (`message_source`), because `Database::encode_frame` writes a whole
  payload from one database's message entry. With two databases
  defining one message on one bus and a pick on one of its signals,
  the panel would report the *other* signals from the first defining
  database while encoding them through the picked one. Before this
  phase both were per message and agreed; the divergence is the price
  of putting the decode on the rule ADR 0054 states. No case was built
  for it — it needs a collision *and* a pick *and* an edit to a signal
  the two databases place differently — and closing it would mean
  splitting one encode across two databases.

## Status log

### 2026-08-21 — Phase 1: verifying the Shape A sites (branch `task-92-phase-1-shape-a`)

Branched from `plans-task-88-complete` at `13285974`. Baseline
`cargo test -p cannet-gui`: **811 passed, 6 ignored**; clippy clean.

Method per site: build the case the scope names — the winner defines
the signal but carries no `VAL_` / no calculated-field default, a later
eligible database on the same bus carries both — observe what the site
returns, and only then judge. Every case ran first as a throw-away
printing test with a **reversed-load-order control**, so that a
"correct" reading is a discrimination rather than an absence. The
scratch tests were reverted before anything was written for keeps.

**Site 1 — `dbc_commands::list_value_tables_inner`. Defective.**

- *Observation.* `a.dbc` and `b.dbc` both assigned to bus `p`, both
  defining `256/"A"`, only `b.dbc` carrying
  `VAL_ 256 A 0 "Zero" 1 "One"`. `list_value_tables_inner(.., "A", ..,
  Some("p"))` returned `["Zero", "One"]`.
- *Expected under ADR 0054 part 3.* `[]` — `a.dbc` supplies the
  definition every value of `A` decodes from, and it declares no
  labels.
- *Cause, from the code the experiment ran.* The predicate is
  `value_table_for_signal(..).is_some()`, which is false both for "does
  not define the signal" and for "defines it with no table", so the
  scan reads past the winner.
- *Fix.* Stop at the first eligible database that **defines the
  signal** (`Database::defines_signal`, new — a hash lookup plus the
  message's signal list) and answer with its table, or with nothing.
  `enum_labels_come_from_the_database_that_defines_the_signal` went red
  first, then green; it pins the reversed order too, and the case where
  a database ahead of the winner does not define the signal at all (not
  a candidate, so the winner is unchanged).
  `defines_signal_answers_for_the_signal_not_for_its_value_table`
  (`cannet-dbc`) pins the distinction at the source. README updated.
  Commit `00e5a6a7`.

**Sites 2, 3, 4 — the calculated-field trio. Already correct.**

- *Hypothesis going in.* The same borrow as site 1: a later database's
  `CannetCounter` / `CannetCrc` designation applied to a message the
  winner decodes.
- *Experiment.* `a.dbc` defines `291 Status` with `AliveCtr` at bit 48
  and no cannet attributes; `b.dbc`, behind it on the same bus, defines
  `291` with `AliveCtr` at bit **40** and both attributes. Three frames
  counting 0, 1, 2 in byte 6's low nibble (bit 48).
- *Data.* `resolve_effective_calc` with no override: `Ok(None)` — b's
  designations not borrowed. With a counter override: payload
  `[00,00,00,00,00,00,01,00]`, i.e. bit 48, a.dbc's placement.
  `VerificationState::rebuild_configs` with the RBS override: **no
  violations**. `app_state::rebuild_verification` end to end: **no
  violations** — so neither b.dbc's counter placement nor its CRC
  reached the config.
- *Controls (load order reversed).* `Ok(Some)` with payload carrying
  `01` in byte 5's low nibble and `46` in byte 7 — b's counter at bit
  40 and its CRC; `[(1,"counter"),(2,"counter")]`;
  `[(0,"crc"),(1,"counter"),(2,"counter")]`. The three clean readings
  are therefore discriminations.
- *Conclusion — hypothesis refuted, with the mechanism.*
  `Database::dbc_calculated_fields` returns `Some` for **any** message
  the database defines — an empty config when it designates nothing —
  and `None` only when the message is absent. So `find` / `find_map`
  over that predicate already means "the first assigned database that
  defines the message". The shape reads like Shape A and is not one.
- *Change.* Tests only:
  `a_transmit_rows_calculated_fields_come_from_the_defining_database`
  (`tests.rs`),
  `an_rbs_override_resolves_against_the_database_that_defines_the_message`
  and `a_dbc_calculated_field_default_comes_from_the_defining_database`
  (`verification.rs`), each carrying its reversed-order control. No
  production behaviour touched. Commit `9d8cf8ea`.

**Site 5 — `app_state::refresh_mux_extractor`. Correct per signal; one
per-frame exposure.**

- *Case A (both define the multiplexor).* `a.dbc` reads the selector
  from byte 1, `b.dbc` from byte 0, a.dbc first. Frame `[1,7,0,9,..]`
  → selector **7**, a.dbc's. Reversed → **1**. The winner wins.
- *Case B (the winner's message is not multiplexed).* `a.dbc` defines
  `512` with one plain signal and no multiplexor anywhere; `b.dbc` is
  the mux database. Selector **1**, from b.dbc. Judged **correct**, not
  a skip: resolution is per signal, `scoped_descriptors` dedups per
  signal, and `Mux` / `ModeA` / `ModeB` have exactly one definition on
  this bus — b.dbc's. A database that does not define a signal is not
  a candidate for it. The `has_multiplexor()` pre-filter can only drop
  databases that define no multiplexor at all, which can never win a
  multiplexor signal.
- *Case C (the winner withholds it for this payload).* `a.dbc` puts
  `Mux` at bit 56, `b.dbc` at bit 0, a.dbc first; a three-byte frame
  `[1,7,0]` → selector **1**, from b.dbc, for a `Mux` that a.dbc
  defines. This is the per-frame fall-through rather than the
  per-signal question, and it is Shape D's shape. Pinned as
  `a_selector_the_winner_withholds_is_read_from_the_next_database` and
  recorded under Blockers / side effects; **not** fixed, because
  closing it changes what a view shows and Shape D is an owner ruling.
- *Change.* Tests only:
  `the_mux_selector_comes_from_the_database_that_defines_the_multiplexor`,
  `a_multiplexor_only_one_database_defines_is_still_that_databases_to_supply`,
  and the exposure pin. Commit `9d8cf8ea`.

**Gates.** `cargo test -p cannet-gui`: 811 → **818 passed, 6 ignored**
(1 site-1 test, 5 pins, 1 exposure pin). `cargo test -p cannet-dbc`
(lib): 109 → **110**. `cargo clippy -p cannet-gui --all-targets` and
`cargo fmt --all -- --check` clean. `cargo test --workspace` clean.
Frontend untouched. Perf harness not run — the overseer owns it.

### 2026-08-21 — Phase 2: the trace row resolves per signal (branch `task-92-phase-2-shape-b`)

Branched from `task-92-phase-1-shape-a` at `ab1178ad`. Baseline
`cargo test -p cannet-gui`: **818 passed, 6 ignored**; `cargo test -p
cannet-dbc --lib`: **110**; clippy and fmt clean.

**Observation, before anything was changed.** A throw-away printing
test, with a reversed-load-order control, put both databases on bus
`bus0`: `a.dbc` defines `256/"Msg"` with `A` at unit scale; `b.dbc`
defines the same message with `A` ×10, a `VAL_` table for it, and an
extra signal `Y`. One frame, `A` raw 3 and `Y` raw 100. Each line is
row / plot, for the same signal in the same instant:

| load order | pick for `A` | trace row `A` | plotted `A` |
|---|---|---|---|
| a, b | none | 3 | 3.0 |
| b, a | none | 30 | 30.0 |
| a, b | **b.dbc** | **3** | **30.0** |
| a, b | a.dbc | 3 | 3.0 |
| b, a | **a.dbc** | **30** | **3.0** |

Rows 3 and 5 are the defect: **one value, two answers**, and they are
mirror images, so the reading is a discrimination and not an artefact
of load order. Rows 1, 2 and 4 are the controls that say a pick
agreeing with load order costs nothing. The row's `Y` was absent in
every case; the plot's was 100.0 throughout.

**Conclusion.** `decode_against` and `decode_snapshot_frame` resolved
per message — the first eligible database that recognised the id
supplied every column — while the caches, the plot and the encoding
fingerprints resolve per signal and honour the pick. ADR 0054 says a
decoded value has exactly one definition, so the row was wrong, not
merely different.

**What landed.**

- `841f2c9b` — `DecodeModel::message_has_pick(id, extended)`, the
  per-frame branch. A `(message id, extended)` set derived once when
  the model is built, from the pick map's keys via the new
  `signal_snapshot::identity_message` (the inverse of the middle of
  `signal_identity`, round-trip tested including a bus id containing
  `|` and `:`). No bus in the key: a bus-qualified test would have to
  format an identity string per frame, and over-answering `true` for a
  frame on a bus no pick names is free, because the per-signal
  resolution it selects reads *that* bus's picks and lands back on the
  load-order default. An empty map answers `false` off an emptiness
  check, hashing nothing.
- `6993735b` — `decode_resolved` replaces the per-message walk in
  `dbc_commands`, and `trace_query`'s `decode_snapshot_frame` folds
  into it. A message no signal of which carries a pick keeps the single
  `decode_raw` call; a message that does gets one decode per eligible
  database, with each signal taken from the database a pick names or
  the first that *defines* it. Signals come out in the base message's
  own declaration order, so the row's columns do not reshuffle. A
  signal the picked database withholds for this payload has **no**
  value rather than one borrowed from behind it. README updated where
  it describes what the signal-mapping panel's choice reaches.

**Falsification control.** With `message_has_pick` forced to `false`,
**five** of the six new tests go red — the four behaviour pins and the
lookup's own test — and the two that pin pre-existing behaviour
(the un-picked collision, and the value-table / calc-field gap) stay
green. So the suite discriminates the change rather than describing it.

**Fast-path measurement** (release, in-process, no picks anywhere:
one database, ten messages of eight signals, 200 000 frames, timing
`collect_trace_records` — the real serve path, whose signature is the
same on both builds). Three runs per build, nine timings each; `min`
is the stable statistic, medians overlap:

| build | min ns/frame | median ns/frame |
|---|---|---|
| pre-change (`ab1178ad`) | 3062.9 / 3088.6 / 3038.5 | 3711.9 / 3663.5 / 3608.1 |
| after (`6993735b`) | 2997.8 / 3018.5 / 3021.7 | 3683.3 / 3687.4 / 3652.0 |

The fast path is **0.5–2.9 % faster on min and level on median** — no
regression. The two costs it adds, measured directly: the per-frame
branch is **0.81–0.98 ns** (≈0.03 % of a 3 µs frame) and building the
`DecodeModel` is **77–143 ns per serve**. An earlier within-build A/B
against a hand-copied replica of the old loop read +2–5 %; the replica
was a fresh local function the optimiser inlined differently, so that
control was discarded for the real pre-change build. The render-tier
perf harness was **not** run — the overseer owns it.

**Gates.** `cargo test -p cannet-gui`: 818 → **826 passed, 6 ignored**
(1 identity parser, 1 lookup, 6 behaviour/pin tests). `cargo test -p
cannet-dbc --lib`: **110**, unchanged. `cargo clippy -p cannet-gui
--all-targets`, `cargo fmt --all -- --check` and `cargo test
--workspace` clean. Frontend untouched.

**Left where they were, deliberately.** Shape D and the mux
extractor's per-frame fall-through are an owner ruling and out of every
phase of this task;
`a_value_the_winner_withholds_is_outside_the_fingerprint` and
`a_selector_the_winner_withholds_is_read_from_the_next_database` still
stand. Phase 1's four pinned sites were not touched. What phase 2 found
and did not close is under Blockers / side effects.

### 2026-08-21 — Phase 3: one shared resolver (branch `task-92-phase-3-shared-resolver`)

Branched from `task-92-phase-2-shape-b` at `b11744da`. Baseline
`cargo test -p cannet-gui`: **826 passed, 6 ignored**; `cargo test -p
cannet-dbc --lib`: **110**; clippy and fmt clean.

**Observations, before anything was changed.** Throw-away printing
tests, each with a reversed-load-order control, run against the
collision fixture (`a.dbc` and `b.dbc` both on `bus0` defining
`256/Msg`, a.dbc at unit scale designating nothing, b.dbc ×10 with a
`VAL_` table, `CannetCounter`, `CannetCrc` and an extra signal `Y`) and
against the mux fixture (`a.dbc` reading 512's selector from byte 1,
`b.dbc` from byte 0). The scratch tests were reverted before anything
was written for keeps.

| site | a-first | b-first | with a pick |
|---|---|---|---|
| `verifier.wants` (the ingest verifier's default config) | **true** | true | — |
| `resolve_effective_calc` | none | some | none under either pick |
| mux selector | 7 | 1 | **7 / 1, unmoved by any pick** |
| `decode_frame_inner` | `A`=3, three signals | `A`=30, four signals | **unmoved by any pick** |
| `describe_message_inner` | 3 signals, no designation | 4 signals, designated | **unmoved by any pick** |

Row 1 is a **new finding**: the verifier answered `true` where
`resolve_effective_calc` answered `none` for the same message, and the
reversed control had both answering yes — so the clean reading is a
discrimination, and the two sites genuinely disagreed. Rows 3–5 are the
gap the owner's Shape D ruling depends on not existing.

**What landed.**

- `fb6cba0a` — **the shared resolver.** `DecodeModel::signal_source`
  (ADR 0054 per signal: eligible for the bus, then load order over the
  databases that *define the signal*, unless a pick names one) and
  `DecodeModel::message_source` (deliberately per message, with the
  reason in its rustdoc), plus `DecodeModel::eligible`, the scan both
  start from. `Database::defines_message` and
  `Database::multiplexor_signal_name` in `cannet-dbc`.
  `list_value_tables_inner` moved onto `signal_source`;
  `resolve_effective_calc`, `rebuild_verification`'s DBC default and
  **both halves** of `VerificationState::rebuild_configs` onto
  `message_source`.
  `a_pick_does_not_yet_reach_the_value_tables_or_the_calculated_fields`
  turned around into
  `a_pick_reaches_the_value_tables_and_the_calculated_fields`.
- `2835986d` — **the mux extractor honours picks.** It is the one
  resolution site that cannot hold a `DecodeModel` (a model borrows the
  loaded set; this runs per appended frame), so it snapshots the picks
  beside the databases and applies the rule through the new free
  function `signal_fingerprint::picked_path`, which `DecodeModel`'s own
  `pick_path` now reads too. A candidate whose multiplexor signal is
  pinned to a different database is not a candidate for it. The
  fall-through behind the winner stays, per the ruling.
- `866df603` — **phase 2's asymmetry closed.**
  `DecodeModel::message_spans_databases`, an index of the ids more than
  one loaded database defines, built with the model and empty below two
  databases. `decode_resolved` takes the resolved path when *either*
  that or `message_has_pick` answers true, so whether a row reports a
  signal only a later database defines no longer depends on whether
  some other signal was pinned.
  `a_signal_only_a_later_database_defines_reaches_the_row_once_the_message_is_picked`
  turned around and renamed.
- `13e766fd` — **the index is cached against the DBC set.** Measured
  after landing it: building it per model cost 0 ns at one database but
  **63.6 µs** at two 500-message databases and **140.2 µs** at five, and
  a model is built per serve. Cached beside `DescriptorSnapshot` and
  dropped by `invalidate_derived_caches` (ADR 0033); building a model is
  back to **100 ns** — the timer's floor — at one, two and five
  databases alike. The free `app_state::decode_model` went with it, so
  `AppState::decode_model` is the only production way to build one and a
  serve cannot accidentally build an uncached model.
- `34687873` — **the transmit panel's queries.**
  `AppState::first_dbc_on_bus` was the last copy of the rule: a generic
  "first assigned database whose closure answers", whose four closures
  all answered exactly when the database defines the message.
  `describe_message`, `encode_frame` and the periodic-backing lookup
  moved onto `message_source`; `decode_frame` onto `decode_resolved`,
  which now takes the frame's parts so a panel-side payload and a
  captured one go through one function. The helper was deleted.
- `255fdf9d` — **the eligibility scan, spelled once.** The encoding
  fingerprint's walk, `picked_index`'s position, the trace decode's
  candidate list and the signal cache's per-frame eligible list all read
  `DecodeModel::eligible`. Thirteen `filter::dbc_applies` call sites are
  down to **four**: `eligible` itself, and three documented as
  deliberately not resolution — the rest-of-bus simulation and the
  signal-mapping panel's `describe_on_bus`, both of which want *every*
  candidate, and the mux extractor, which cannot hold a model.

**Falsification control.** Each knob turned off in turn, suite re-run:
forcing `message_spans_databases` to `false` reddens **2** tests (the
lookup's own and the turned-around row test); making the resolver ignore
picks reddens **4** (`signal_source`'s and `message_source`'s unit
tests, the value-table / calc-field test and the transmit-panel test);
disabling the mux extractor's pick check reddens **1**. No other test
moves, so the suite discriminates the change rather than describing it.

**Fast-path measurement** (release, in-process, against the real
pre-change build `2835986d`, restored file by file out of git rather
than replicated by hand — the trap phase 2 documented).
`collect_trace_records` over 200 000 frames, three runs per invocation,
four invocations per build; `min` is the stable statistic.

| project | build | min ns/frame (best of four) | per-invocation minima |
|---|---|---|---|
| one DBC, 10 messages | pre | 2023.4 | 2023.4 – 2151.4 |
| one DBC, 10 messages | after | 2031.6 | 2031.6 – 2063.6 |
| two DBCs, 500 messages each, disjoint ids | pre | 2011.2 | 2011.2 – 2075.1 |
| two DBCs, 500 messages each, disjoint ids | after | 2057.4 | 2057.4 – 2104.2 |

+0.4 % and +2.3 % on the best-of-four minima, both inside the
run-to-run spread of either build. The new per-frame lookup measures
**0.55 ns**, against 0.54 ns for `message_has_pick` beside it, so it
cannot account for a 46 ns/frame difference — that is machine noise.
Model construction is 100 ns at one, two and five databases. The
render-tier perf harness was **not** run — the overseer owns it.

**Gates.** `cargo test -p cannet-gui`: 826 → **832 passed, 6 ignored**.
`cargo test -p cannet-dbc --lib`: 110 → **112**. `cargo clippy -p
cannet-gui --all-targets`, `cargo fmt --all -- --check` and `cargo test
--workspace` clean. Frontend untouched. README updated where it
describes what the signal-mapping panel's choice reaches.

**Left where they were, deliberately.** Shape D stays open per the
2026-08-21 ruling:
`a_value_the_winner_withholds_is_outside_the_fingerprint` and
`a_selector_the_winner_withholds_is_read_from_the_next_database` are
both still green, and neither `sample_shared` nor the mux extractor
withholds a value its winner does not cover. What phase 3 found and
decided rather than inherited is under Blockers / side effects.

**Exit criteria.**

| criterion | verdict | what earns it |
|---|---|---|
| One shared resolver; every `dbc_applies` site that answers "which database supplies this" goes through it, or is documented as deliberately different | **met** | `DecodeModel::signal_source` / `message_source` / `eligible`; 13 sites → 4, three of them carrying their reason in rustdoc |
| A collision resolves to the same database in the trace row, the plot, the value tables and the calculated fields; tested | **met** | `a_collision_resolves_to_one_database_in_the_row_the_plot_the_tables_and_the_calc_fields` (no pick), `a_pick_reaches_the_value_tables_and_the_calculated_fields` and `a_trace_rows_picked_signal_comes_from_the_database_the_pick_names` (picked, both load orders) |
| No derived attribute comes from a database other than the one decoding the value; a case per Shape A site | **met** | phase 1's five pins, plus `a_designation_the_defining_database_never_declared_is_not_borrowed` for the sixth site phase 3 found |
| Shape D closed, **or** left open with the ruling recorded and the test still pinning the exposure | **met, second branch** | the ruling is recorded above; both exposure pins are green |
| The shared resolver's rustdoc cites ADR 0054 | **met** | `signal_source` and `message_source` both cite it by name, and `message_source` cites it for the part it deliberately reads differently |
