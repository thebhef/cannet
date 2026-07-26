# Task 40 — bridge_client / cannet-client Session-Machinery Consolidation

`bridge_client.rs` re-implements cannet-client's session machinery —
real duplication (subscribe envelope, allocated-id wait, pumps, twin
error types). Split out from the task-30 quality audit (its item #9),
where the consolidation was flagged but explicitly gated rather than
done.

## Why this is gated, not just backlog

cannet-client's `allocated_id` only works for `factory` subscriptions
declared up front, and it waits indefinitely for the allocation.
bridge_client's `ALLOCATED_GRACE` timeout
([`crates/cannet-server/src/bridge_client.rs`](../../crates/cannet-server/src/bridge_client.rs),
part of the bridge installation covered by
[ADR 0021](../../docs/adr/0021-virtual-bus-server.md) § "Bridge
installation") is a documented constraint — a bridge that waits
indefinitely for an allocation that never arrives is a hang, not a
simplification. The two implementations aren't accidentally divergent;
cannet-client is missing a capability bridge_client depends on.

## Scope

1. Grow cannet-client's `allocated_id` path to support a
   subscribe-timeout / dynamic-allocation capability equivalent to
   `ALLOCATED_GRACE` (bounded wait, not indefinite; works for
   subscriptions not just declared-up-front `factory` ones).
2. Once that capability exists, consolidate bridge_client.rs onto
   cannet-client's session machinery — subscribe envelope, allocated-id
   wait, pumps, error types — under green tests, per CLAUDE.md's
   refactor discipline (existing coverage as a baseline, then unify).
3. Fix bridge_client.rs's stale module doc regardless of when (or
   whether) the rest of this task proceeds — it currently claims a
   difference from cannet-client that no longer accurately describes
   why the two exist separately once framed against this task.

## Exit criteria

- cannet-client supports a bounded allocation wait usable outside the
  up-front `factory` case, with tests.
- bridge_client.rs's session machinery is consolidated onto
  cannet-client's (or, if a real behavioral difference is discovered
  during the work that justifies keeping them separate, that's
  documented here and in bridge_client's module doc instead of forcing
  the merge).
- No regression in bridge_client's existing timeout/grace-period
  behavior — the consolidated implementation still bounds the wait.
