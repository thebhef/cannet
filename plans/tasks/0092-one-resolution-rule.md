# Task 92 — One Resolution Rule, Not Eleven Copies

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

| site | what it looks for |
|---|---|
| `dbc_commands.rs:609` (`list_value_tables`) | a `VAL_` table for the signal |
| `app_state.rs:523` | the DBC default for calculated fields |
| `verification.rs:142` | the same calculated-field default |
| `transmit_commands.rs:79` | the same again |
| `app_state.rs:478` (mux extractor) | a decodable mux selector |

**Why this is suspect, not merely duplicated.** It skips *past* the
database that actually decodes the signal to a later one that happens
to carry the attribute being looked for. So enum labels, or a
counter/CRC default, can come from a database that is not decoding the
value they are attached to — which ADR 0054 part 3 forbids. Under the
ADR the answer should be *the winner's* `VAL_` table, and if the winner
has none, then there are no labels; borrowing from a different file is
the defect, not the fallback.

**Confidence: the code shape permits it; not yet demonstrated with a
failing test.** Each site needs a case built (winner defines the signal
but carries no `VAL_` / no calc fields, a later eligible database
carries both) before it is called a bug. Task 86 fixed the *bus
scoping* half of this family — "enum labels no longer come from a
database that can't decode the signal" — and this is the remaining
per-signal half.

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

### Shape C — the canonical one

`signal_cache.rs:1009` builds the eligible list and then resolves
per signal, honouring picks. This is the behaviour ADR 0054 describes,
and it is the one the others should reduce to.

### Already accounted for elsewhere

`signal_fingerprint.rs:205` and `:373` are
[task 88 phase 8](0088-bus-assignment-governs-decode.md)'s work — the
fingerprint hashing the candidate's whole bus list and every eligible
candidate rather than the winner. Not duplicated here.

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

## Exit criteria (draft — firm at grooming)

- One shared resolver; every `dbc_applies` site that answers "which
  database supplies this" goes through it, or is documented as
  deliberately different with the reason stated.
- A collision resolves to the same database in the trace row, the plot,
  the value tables and the calculated fields; tested.
- No derived attribute comes from a database other than the one
  decoding the value; a case per Shape A site.
- The shared resolver's rustdoc cites ADR 0054.
