# ADR 0013 — Consumers receive from every bus by default; edges are editable; transmit binds to bus

Status: accepted (2026-05-23)

## Decision

Three coordinated decisions about the project's wiring model,
landed together in Phase 6.5
([plans/phased-implementation.md](../../plans/phased-implementation.md)):

### 1. Consumers receive from every bus by default

Every consumer element — `trace`, `plot`, `filter` — carries a
`sources: string[]` field listing the buses (and upstream filters)
it consumes. The list **defaults to `["*"]`**, where `"*"` is a
wildcard meaning *every bus, current and future*. A brand-new
trace or plot reads from every bus without the user wiring
anything.

### 2. Edges are user-editable from the graph view

The project graph view ([ADR 0012](0012-project-panel-graph-split.md))
owns add and remove of wiring edges. Removing an edge under a `"*"`
wildcard **expands** the wildcard into the explicit list of every
project bus *except this one* — so subsequent edits operate on a
concrete list, not the wildcard. The element registry rejects any
patch that would close a filter → filter cycle.

Gateway↔bus edges (interface bindings) are owned by the project
panel (the inventory surface, ADR 0012), not editable from the
graph.

### 3. Transmit binds to project buses, not raw wire channels

Transmit elements carry `sinks: string[]` — an explicit list of
project `bus_id`s the panel composes frames for. **No wildcard
on `sinks`**, deliberately: a transmit is *intent to write*, and
silently picking up a newly-added bus would be surprising.

The wire protocol carries `bus_id` on `TransmitRequest`; the host
resolves each `bus_id → (server, interface)` via the project's
interface bindings before issuing the wire call.

This sits cleanly on top of [ADR 0011](0011-project-file-format.md):
the project file's ordered bus list is the canonical mapping, BLF
channel index `N` ↔ `project.buses[N]` (channel mapping conveyed
by ordering, no sidecar — see [ADR 0010](0010-no-sidecar-files.md)).

## Why

**Fan-out by default** matches what users want when they create a
new view ("show me data"). Wiring affordances are needed to *prune*
in the uncommon case, not to *create* in the common case.

**Wildcard with first-edit expansion** keeps the source-of-truth
small (one `"*"` token vs N enumerated entries) while making
per-edge UI interactions concrete once the user starts pruning.
The user never has to think about wildcards directly.

**Transmit-by-bus** keeps wire-level channel representation out of
the user-facing transmit semantics. The user thinks in project
buses; the host resolves to wire channels.

The three decisions reinforce each other: adding a bus is now safe
in both directions (consumers wired with `"*"` pick it up;
transmits never pick it up silently), and the asymmetry between
`sources` and `sinks` matches the asymmetry between "read what's
available" and "intent to write."

## Consequences

- **By-id keys must include `bus_id`.** Without it, two servers
  sharing wire channel 0 collapse their per-id snapshots once
  channels are mapped onto distinct project buses.
