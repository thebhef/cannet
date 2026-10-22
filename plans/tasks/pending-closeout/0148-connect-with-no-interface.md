# Task 148 — Connect With a Bus Set to No Interface

Opened by owner instruction 2026-09-19 from user feedback (ungroomed
item 16). **Executes now, on the current stack.** Grooming in
progress.

## Why

From the feedback: "Bring back the ability to connect with missing
interfaces, when 'no interface' is explicitly selected." Going online
used to work when some project buses had no interface behind them; it
now refuses. A bus the user has deliberately left unbound should not
stop the rest of the project from connecting.

## Scope

To groom. At minimum: a project whose buses include one explicitly
set to no interface connects, and that bus shows as unbound while the
others are live.

## Findings (2026-09-19 survey)

- **"No interface" is not a value; it is the absence of a binding
  row.** Picking "— no interface —" in the bus combo
  (`ConnectionManagement.tsx`, `ProjectPanel.tsx`) deletes the bus's
  `InterfaceBinding`; nothing records that the user chose it. The
  model cannot tell "deliberately unbound" from "binding lost"
  (`project.rs`: `BindingKind` has no `None`; ADR 0023 says "at most
  one binding").
- **The refusal is task 117's owner ruling** (2026-08-25, commit
  `52881d0b`, "Refuse to connect without a bound bus"): a loud,
  per-bus failure over a disabled Connect control. The commit names
  the partial connect of a multi-bus project as the bug it fixed.
  The ruling lives only in that deleted task file and the commit
  message; no ADR records it.
- Two frontend guards in `App.tsx` `handleConnect`: A, any bus with
  no binding → `No interface bound for <bus> — bind one in the
  project panel.`; B, a bound interface the server does not list →
  `Bound interface not attached: …`. Both abort the whole connect.
- **The host already does partial connects**: `session.rs`
  partitions bindings the server does not expose into a per-bus
  `error: not exposed by <addr>` and connects the rest (tested). The
  "unbound" muted display for a bus with no binding exists and is
  tested (`connectionStates.ts`). Unbound buses are already excluded
  from the chip's `connected / bound` count.
- `plans/backlog.md` carries the owner's own task-117-review note
  (2026-08-28): disable Connect with a tooltip while any bus lacks a
  binding, plus "a way to *disable* a bus, so a deliberately unbound
  bus stops blocking Connect". Same need, different remedy; must be
  reconciled here.
- Tests encoding today's refusal: `unboundBus.test.ts`,
  `App.unboundBusRefusal.dom.test.tsx`, `StatusBar.dom.test.tsx`
  ("does not offer a press when the project binds no interface").

## Rulings

- **"No interface" is a persisted fact** (owner, 2026-09-20): picking
  "— no interface —" writes a binding row of a new kind,
  `NoInterface`, keyed by the bus like every other binding, and it
  is saved with the project. Anything inferred from the *absence* of
  a row is an assumption there is no basis for, so an unbound bus
  (no row at all) is still refused exactly as task 117 ruled — an
  old project file keeps behaving as it does until someone picks
  "— no interface —" once.

Settled by the overseer from that ruling, open to reversal:

- **Only the explicit case connects.** Guard B (a bound interface
  the server does not list) is unchanged; "bound but absent" is not
  "no interface".
- **A project whose buses are all `NoInterface` has nothing to
  connect.** The chip stays without an action, its detail saying so
  ("every bus is set to no interface"), as it does today for a
  project with no bindings.
- **While online, a `NoInterface` bus reads "unbound"** in the
  muted tone the code already has; it is excluded from the chip's
  `connected / bound` count and named in the chip's tooltip so
  "2 / 2" with a third bus is not a mystery.
- **Transmit or RBS aimed at a `NoInterface` bus** behaves as it does
  for any bus with no wire: frames are marked `undelivered`. No
  up-front refusal.
- **The backlog's disable-Connect-with-tooltip item** stays in the
  backlog; its "a way to disable a bus" half is what this task
  delivers, and the entry is trimmed to the tooltip half.
- **ADR 0023 gains the kind** and, since the 117 ruling lives only
  in a deleted task file and a commit message, records the connect
  rule alongside it: a bus with no binding row refuses the connect;
  a bus bound to `NoInterface` connects as unbound.
- `NoInterface` is additive: a v7 file never contains it, so the
  current loader opens such a file unchanged (ADR 0011). No
  `PROJECT_SCHEMA_VERSION` bump — it stays 7.

## Phases

One phase, one branch: the `BindingKind::NoInterface` variant in
`project.rs` and `types.ts`, the combo pick writing the row instead
of deleting it, `unboundBusError` refusing only row-less buses, the
chip tooltip naming no-interface buses, the ADR 0023 amendment, the
backlog entry trimmed, and the tests below.

## Exit criteria

- Picking "— no interface —" on a bus writes a `NoInterface` binding
  that round-trips through save and load; the combo shows it as the
  selected option on reopen.
- A two-bus project with one bound bus and one `NoInterface` bus
  connects; the bound bus goes live, the other reads "unbound"; the
  chip reads `1 / 1` with the no-interface bus named in its tooltip
  (`App.unboundBusRefusal.dom.test.tsx` gains the case).
- A two-bus project with one bound bus and one bus with **no row**
  is still refused with the 117 message (existing tests stand).
- A project whose buses are all `NoInterface` offers no connect
  action, with a detail that says why.
- A v7 project file without any `NoInterface` binding still parses
  unchanged under the current schema version (additive, ADR 0011 —
  no bump); `unboundBus.test.ts` covers the three states (bound,
  no-interface, no row).
- ADR 0023 records the kind and the connect rule; `backlog.md`'s
  task-117-review entry is trimmed to the tooltip half.

## Status log

- 2026-09-19 — task opened from ungroomed feedback item 16; grooming
  started.
- 2026-09-20 — ruled: "no interface" is a persisted binding kind;
  absence of a row is still refused per task 117. One phase cut;
  exit criteria drafted. Grooming complete.
- 2026-09-20 — phase landed on `task148-no-interface-binding`
  (parent `task147-collapse-under-filter`). `BindingKind::NoInterface`
  / `"no-interface"` added in `project.rs` / `types.ts` (empty
  `server`/`interface`), additive under ADR 0011 with no schema
  bump. The combo's
  "— no interface —" pick now writes the row (`ConnectionManagement.tsx`
  `handlePick` / `ProjectPanel.tsx` `setBusInterface`) instead of
  calling `onRemoveBinding`, and shows selected on reopen (no binding
  and a `no-interface` binding share the same closed-combo value,
  distinguished only by the connect refusal). `unboundBusError`
  needed no code change — it already refuses only row-less buses, so
  it just gained a covering test. `App.tsx`'s `connectionSummary`
  splits bindings into `bound` (real interface) and `noInterface`
  (excluded from the chip's `connected / bound` count, named in its
  tooltip as `"<name>: unbound"`); `summarizeConnection` gained the
  `noInterface` parameter and the all-no-interface wording ("every
  bus is set to no interface"). `session.rs` needed no change: a
  `no-interface` binding's empty `server` is filtered out of
  `handleConnect`'s per-server payload by the existing
  `resolveServer(...).length > 0` check, so it never reaches
  `connect_remote_server` and `resolve_bus_route` already returns
  `None` for it — the existing no-route → `undelivered` path (tested
  in `tests.rs`) covers it with no new host code. ADR 0023 gained a
  "`NoInterface`: connected to nothing, on purpose" section recording
  both the kind and the connect rule (absent row refuses; explicit
  `NoInterface` connects as unbound), citing itself rather than task
  117. `plans/backlog.md`'s task-117-review entry trimmed to its
  tooltip half.
- 2026-09-20 — investigation note (scientific method, since it
  briefly looked like my own change): a new App-level dom test
  intermittently failed to find the project panel's "Open…" button
  when run after another test in the same file, only when its
  `openProjectResult` was a *valid* project object set before mount.
  Hypothesis: some module-global cache outlives the React tree
  between tests. Experiment: dumped `localStorage` and DOM node
  counts at the failure point — both clean, ruling out storage and a
  double-mounted root. Re-examined `App.tsx`'s boot effect and found
  `hostSettings().reopen_last_project && hostState().last_project`;
  `hostState.ts`'s `cache` is a bare module-level `let`, set by
  `setLastProject` on every real Open and never reset between tests
  in one file. Confirmed: adding `await hydrateState()` (which
  re-reads the mocked, unhandled `get_state` → `null` → empty cache)
  to the test file's `beforeEach` made the failure disappear. Fixed
  in the test file only, matching the reset pattern several sibling
  `App.*.dom.test.tsx` files already carry — not an app bug, and nothing
  else in this diff touches `hostState.ts`.
- 2026-09-20 — review round: all three Blockers items resolved before
  acceptance, none left open.
  - The `#[ignore]` on
    `project::tests::parses_the_checked_in_ev_zonal_example_project`
    is removed; it passes.
  - `projectGraph.ts`'s `deriveGraph` skipped only `local-virtual-bus`
    when deciding whether a binding gets its own gateway node; a
    `no-interface` binding (empty `server`/`interface`, same as every
    other one) fell through and every such binding in a project
    collapsed onto one shared `gatewayNodeId` (`"gateway:::"`) with a
    near-blank label. Test first (`projectGraph.test.ts`, two new
    cases — one binding, and two on different buses staying separate
    bus-only nodes), confirmed failing, then `no-interface` is skipped
    the same way `local-virtual-bus` is.
  - `busHealth.ts`'s `busHealthRows` read a `no-interface` bus as
    "Not connected" — right for a bus with no binding row at all
    (`b3` in the existing fixture, unchanged), wrong for a bus that
    carries an explicit `no-interface` row. Test first
    (`busHealth.test.ts`), confirmed failing, then `stateText` reads
    "Unbound" when the binding's kind is `no-interface`; the adapter
    cell stays blank (`""`), as ruled.
  - `plans/owner-review-queue.md` §1's ev-zonal entry deleted; this
    file's own Blockers section (all three items) removed.
- 2026-09-21 — owner ruling: the schema bump was unnecessary. A v7
  file never contains a `NoInterface` binding, so the current loader
  opens it unchanged — ADR 0011 classes that as additive, not a
  bump. `PROJECT_SCHEMA_VERSION` reverted 8 → 7 in `project.rs` and
  `types.ts`; the seven example projects and every "v8" mention in
  this file and its rustdoc reverted to match. The `NoInterface`
  kind itself is unchanged.
