# 0121 — The Trace Tells the Truth About the Wire

> **Opened 2026-08-26** from the owner's walk of
> [`owner-review-queue.md`](../owner-review-queue.md) § 3B —
> findings **3.37, 3.39, 3.42, 3.43, 3.53**. Two of them (3.42, 3.43) are
> the owner's own observations from the 2026-08-23 hardware session; two
> more came from investigating that report; 3.53 predates it.

**The trace shows frames the bus never carried, and hides the evidence
that it didn't.** Three findings are one defect seen from three sides,
and they are § 1. The other two are separable and are §§ 2 and 3.

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

## 2. "Error-active" does not read as healthy · 3.42

> *"to a reader it looks like a fault is in progress, which is the
> opposite of what it means"* — owner, 2026-08-23

`Error-active` is the correct ISO 11898-1 name for a node in normal
operation. The other three states (`Error-warning`, `Error-passive`,
`Bus-off`) read correctly as degrees of trouble, so the healthy state is
the only one whose label misleads.

**Recommend** the panel shows `Normal` and keeps the ISO name in the
tooltip. **Not yet ruled.** Independent of § 1 and much smaller — it can
land first.

## 3. Nothing counts dropped frames · 3.53

The status-bar inventory considered a dropped/overrun counter and did not
adopt it, because no such counter exists anywhere in cannet — it is new
work on the ingest path, not a new label. It is, though, the one number
that says whether the trace on screen is the whole of what the bus sent,
and **every other number in the bar is read as if it were**.

**Recommend** opening the counter. **Not yet ruled.**

## Exit criteria

1. **A transmit row that never reached the wire is distinguishable from
   one that did**, in a running build, pinned by a test.
2. **A `TX_REJECTED` reaches the user**, coalesced, and is pinned.
3. **Error frames coalesce in the trace view while the saved capture
   still holds every one of them** — pinned both ways, because the
   ruling is precisely that these two differ.
4. **Each of 3.37, 3.39, 3.42 and 3.53 reaches a terminal state** and its
   queue row is struck with the date.
5. **Full CI green** — seven jobs, each named with its command.
