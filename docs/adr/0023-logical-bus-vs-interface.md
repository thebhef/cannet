# ADR 0023 — Logical bus, interface, and the binding between them

Status: accepted (2026-05-29)

## Decision

cannet keeps two concepts and a join:

1. **Logical bus** — models a CAN bus in the user's system: a stable
   id, a user-facing name, an optional graph colour. Trace panels,
   plot panels, transmit panels, filters, and per-DBC scoping all
   reference this by `bus_id`. Logical buses live in `Project.buses`.

2. **Interface** — what the logical bus is connected to: a physical
   bus or ECU on some adapter, or a virtual one in-process. The
   interface has its own existence and lifecycle independent of
   any binding.

3. **Interface binding** — the join. Each logical bus has at most
   one binding, naming the interface the bus is connected to.

The model is silent on what an interface is internally. Specific
implementations (in-process, remote, hardware-backed,
factory-allocated, …) define their own identity grammar and
lifecycle in their own ADRs.

## Why

**Decoupling the logical bus from the interface is what makes
swapping connections cheap.** A logical bus called "Powertrain"
can be connected today to a Vector channel and tomorrow to an
in-process virtual bus without filters, DBC scoping, or panel
configuration changing. They route by `bus_id`; they don't care
what's on the other end of the binding.

**Two logical buses can share one interface.** When the
interface's implementation fans out to multiple subscribers, the
binding model has no reason to forbid it. Each frame from the
interface is stamped with each matching binding's `bus_id`.

**Interfaces outlive bindings.** An interface can exist before any
logical bus is bound to it (the user configures it first, then
attaches), and survive a binding's removal. Keeping the
interface's definition off the binding is what makes that work.

**Symmetric UI.** The picker on a logical bus is one combo over
every interface the project knows about, whatever kind it is.

## Mechanics

`Project.interface_bindings: Vec<InterfaceBinding>` joins logical
buses to interfaces. Each binding carries:

- `bus_id` — the project bus this binding routes; the per-bus key,
- `kind` — discriminator selecting an interface family,
- the family-specific fields identifying the interface within
  that family.

Specific binding kinds — values, fields, and how the host resolves
each to a live interface — are defined by the ADRs that introduce
those kinds. This ADR fixes only the shape: discriminated
bindings keyed by `bus_id`, with at most one binding per logical
bus.

## Rejected alternatives

- **Inline the interface's definition on the binding.** Couples
  the binding (a routing choice) with the interface (a thing that
  exists in its own right and may have its own lifecycle), and
  makes the same interface awkward to reference from more than one
  binding.
- **Make the logical bus *be* the interface.** Equates
  "Powertrain" with a specific interface instance. Breaks the
  moment the user swaps Powertrain between interfaces, or points
  two logical buses at one interface.
- **Heuristic discriminators on interface ids.** Pattern-matching
  on free-text identifiers makes the file format brittle. An
  explicit `kind` field is cheap and unambiguous.

## See also

- [ADR 0013](0013-default-receive-all-edge-edits-transmit-by-bus.md)
  — established that downstream consumers route by `bus_id`, which
  is the contract this split protects.
