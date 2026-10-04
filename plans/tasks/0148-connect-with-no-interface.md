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
- `PROJECT_SCHEMA_VERSION` bumps (ADR 0011: exact match, no
  migration).

## Phases

One phase, one branch: the `BindingKind::NoInterface` variant in
`project.rs` and `types.ts`, the schema bump, the combo pick writing
the row instead of deleting it, `unboundBusError` refusing only
row-less buses, the chip tooltip naming no-interface buses, the ADR
0023 amendment, the backlog entry trimmed, and the tests below.

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
- A project file at the previous schema version is refused per ADR
  0011; `unboundBus.test.ts` covers the three states (bound,
  no-interface, no row).
- ADR 0023 records the kind and the connect rule; `backlog.md`'s
  task-117-review entry is trimmed to the tooltip half.

## Status log

- 2026-09-19 — task opened from ungroomed feedback item 16; grooming
  started.
- 2026-09-20 — ruled: "no interface" is a persisted binding kind;
  absence of a row is still refused per task 117. One phase cut;
  exit criteria drafted. Grooming complete.
