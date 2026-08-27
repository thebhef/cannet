# 0121 — The Tool Tells the Truth About the Wire

> **Opened 2026-08-26** from the owner's walk of
> [`owner-review-queue.md`](../owner-review-queue.md) § 3B —
> findings **3.37, 3.39, 3.42, 3.43, 3.52, 3.53**. Two of them (3.42,
> 3.43) are the owner's own observations from the 2026-08-23 hardware
> session; two more came from investigating that report; 3.52 and 3.53
> predate it. Widened 2026-08-26 at the owner's instruction to carry
> **all** of the hardware-truth work as one task — *"fine if it gets
> split into a few PRs, but I intend to do it all before next release,
> so might as well put it together."*

**The trace shows frames the bus never carried, and hides the evidence
that it didn't — and the bus-health panel names its hardware with less
truth than the hardware offers.** Three findings are one defect seen
from three sides, and they are § 1. The rest are separable and are
§§ 2–4.

## 1. A transmit row is a local echo, not a wire confirmation

> *"Transmit frames still present as though they reached a wire."*
> — owner, 2026-08-23

| # | The piece |
|---|---|
| **3.43** | `build_and_confirm` appends the tx-confirm row **before any wire attempt**, unconditionally. A frame the bus never carried is indistinguishable in the trace from one it did. Task 109 phase 2 fixed only the case where the *interface* is unreachable; this is the general one — an open CAN link, a listen-only bus, FD on a classic bus. |
| **3.37** | The wire **does** tell us. `cannet-client::is_per_frame_error_code` classifies `TX_REJECTED` as non-fatal and logs it with `tracing::warn!` — dev stderr only. Not the System Messages panel, not bus health, not the connection chip. The rejection is received and discarded. |
| **3.39** | During the bench fault the adapter emitted **115,136 error frames in 22 s (~5,200/s)**, each becoming a trace row: `session.rs`'s error branch adds the health-coalescer fold and the `trace_store.append` below it is unconditional. Phase 2 attributed the trace's growth to tx-confirm rows and never saw this larger contributor. |

**Ruled 2026-08-26, and it settles the one real design question:**

> *"error frames stay in saved capture, and coalesced in the frontend."*

So **nothing is dropped at ingest.** `bus_health.rs`'s module doc keeps
its promise — *"the frames themselves are stored like any other frame …
so a saved capture is not a lossy restatement of what was received"* —
and the coalescing is a **view** concern. A capture saved during a fault
still carries all 115,136 frames; the trace panel shows them as one row
that counts.

**Work:**

1. A tx row is **provisional until the wire answers**, and reads as such.
2. `TX_REJECTED` reaches the user — coalesced, since at RBS rate it is a
   flood.
3. Error frames coalesce **in the frontend**, storage untouched.

**Re-observed by the owner 2026-08-26**, while ruling on the queue:
*"we still seem to count TX messages and try to keep sending them into a
dead bus."* Both halves are this task's § 1 — the tx count rises because
`build_and_confirm` appends unconditionally, and nothing stops or
surfaces the retries because the wire-level rejection is discarded. PEAK
hardware is available for the verification runs.

## 2. "Error-active" does not read as healthy · 3.42

> *"to a reader it looks like a fault is in progress, which is the
> opposite of what it means"* — owner, 2026-08-23

`Error-active` is the correct ISO 11898-1 name for a node in normal
operation. The other three states (`Error-warning`, `Error-passive`,
`Bus-off`) read correctly as degrees of trouble, so the healthy state is
the only one whose label misleads.

**Ruled 2026-08-26:** the panel shows **`Connected`**, and the ISO
name survives in the tooltip. Independent of § 1 and much smaller — it
can land first.

## 3. Nothing counts dropped frames · 3.53

The status-bar inventory considered a dropped/overrun counter and did not
adopt it, because no such counter exists anywhere in cannet — it is new
work on the ingest path, not a new label. It is, though, the one number
that says whether the trace on screen is the whole of what the bus sent,
and **every other number in the bar is read as if it were**.

**Ruled 2026-08-26 — open it, here**: *"addressing throwing away that
status (for peak, kvaser, vector) ... could land in 121."* The counter
reads the per-vendor overrun/status reporting the ingest path currently
discards — PCAN's status word, Vector's chip-state events, Kvaser's
whenever its CANLIB leg exists — and counts rx-side loss only; tx
rejection is § 1's separate, already-named signal.

## 4. Adapter identity is a display name and nothing else · 3.52

Raised by [task 101](0101-bus-health.md): the wire's `Interface`
(`crates/cannet-wire/proto/cannet.proto`) carries exactly `id`,
`display_name`, `fd_capable`, so the bus-health adapter cell can never
show driver name/version, firmware version, or serial — the fields the
approved prototype filled with **fabricated** strings.

**Ruled 2026-08-26** — *"we should address, ship that data across from
the sidecar"*, and it lands here with the rest of the hardware-truth
work:

1. **Protocol**: extend `Interface` with optional identity fields —
   driver name, driver version, firmware version, serial number. All
   optional; absent renders as absent. Internal wire, no out-of-tree
   consumers (the 3.12 precedent).
2. **Sidecar producer, per backend**: populate what each python-can
   backend exposes at interface-listing time — PCAN (`CAN_GetValue`
   channel/API version, device id), Vector (`xlGetDriverConfig` driver
   version, serial). Kvaser follows whenever its CANLIB leg lands (the
   known limitation recorded at task 109); until then its fields are
   absent, which the model handles by construction.
3. **Host + panel**: carry the fields through `cannet-client` to the
   bus-health adapter cell. **Absent means absent** — an em-dash, never
   a guessed or fabricated string; that rule is what task 101 already
   applies to bus load and is the reason this section exists at all.

Out of scope: channel counts, transceiver details, anything the
prototype did not show (additive later); any Kvaser-specific work (the
owner follows up independently).

## Exit criteria

1. **A transmit row that never reached the wire is distinguishable from
   one that did**, in a running build, pinned by a test.
2. **A `TX_REJECTED` reaches the user**, coalesced, and is pinned.
3. **Error frames coalesce in the trace view while the saved capture
   still holds every one of them** — pinned both ways, because the
   ruling is precisely that these two differ.
4. **`Interface` carries the identity fields**, optional and documented
   in the proto; the sidecar populates them for PCAN and Vector from
   the backend's own reporting, pinned by sidecar tests against faked
   backend responses. The adapter cell shows real values where present
   and an absent marker where not, pinned each way; a backend exposing
   nothing (virtual bus, Kvaser today) renders exactly as before, as
   the control. No string in the cell is fabricated.
5. **Each of 3.37, 3.39, 3.42 (ruled: `Connected` + tooltip), 3.52
   (ruled: ship the identity data) and 3.53 (ruled: the rx-loss counter
   is built here) reaches a terminal state**, recorded in this file.
6. **Full CI green** — seven jobs, each named with its command.
