# Task 81 — Bus-Scoped Decode Identity

Opened by owner ruling 2026-08-15 on Task 76 phase 1's recorded
divergence: "this seems probably wrong; if a signal is on two busses
it's not necessarily expected to be the same thing, could be a
different instance of same ECU, for example."

## The divergence

The pyramid decode path ignores DBC bus scoping — `sampling.rs` hands
every loaded database to the cache regardless of `LoadedDbc::buses`,
while `dbc_commands.rs`, `app_state.rs`, `transmit_commands.rs` and
`verification.rs` all filter through `filter::dbc_applies`. A series
scoped to bus A can therefore be decoded by a DBC scoped only to
bus B — wrong exactly when the same message/signal name on two buses
is a different instance (the owner's ECU example). Fixing it changes
decoded values, which is why Task 76 recorded rather than fixed it.

Same family, second seam: `list_value_tables` takes no `bus_id` on
either branch (DBC- or file-backed), so two buses whose DBCs define
the same `(message_id, signal_name)` share whichever table the first
loaded DBC answers with. If decode identity becomes bus-scoped, the
label lookup scopes with it.

Note: Task 76's per-signal fingerprint already includes each
contributing DBC's bus scoping (recorded as "conservative today,
still correct if the path is fixed"), so pyramids invalidate correctly
when this lands.

## Exit criteria (draft — firm at grooming)

- The pyramid decode consults the same `dbc_applies` scoping as every
  other decode consumer; a signal scoped to bus A is never decoded by
  a DBC scoped only to bus B; tested.
- `list_value_tables` resolves per bus; lanes/labels on two
  differently-scoped buses read their own tables; tested.
- The behavior change is called out in the status log with a
  before/after decode comparison on a two-bus fixture.
