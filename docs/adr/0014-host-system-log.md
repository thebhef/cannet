# ADR 0014 — Host system log: a bounded, session-scoped message bus with flood protection

Status: accepted (2026-05-24, **framing under review** — see Open
questions)

## Decision

The Tauri host owns a **structured, in-process system log bus** that
every host-side concern (project I/O, DBC load, capture lifecycle,
sidecar bridge, …) emits user-visible status through, and that a
System Messages panel renders.

The bus has four architectural properties:

1. **Bounded.** A fixed-capacity in-memory ring. Old entries fall
   off the back; the bus never grows past a cap and never spills to
   disk.
2. **Session-scoped.** Cleared on every app launch; not persisted
   to the project file, not saved alongside a capture, not surfaced
   as a cross-session history.
3. **Flood-protected.** A rate limiter inside the bus suppresses
   repeated messages keyed by `(source, template)`. After a
   threshold of duplicates within a rolling window, further
   duplicates drop silently until the window rolls; the first drop
   in a burst emits a single suppression note so the user knows the
   rate limiter is in play.
4. **Tee'd to `tracing`** (Apache-2.0/MIT) — every emit goes to the
   in-process ring *and* to the standard `tracing` subscriber, from
   one call site. Dev-side `stderr` keeps working without a second
   emit.

Messages carry `{ ts, source, level, message, optional_payload }`.
Sources are tagged (`project`, `dbc`, `connection`, `blf-import`,
`sidecar:<vendor>`, …). Levels are `info` / `warn` / `error`.

Sidecars contribute log entries via the wire-protocol `Log`
envelope ([ADR 0004](0004-grpc-wire-protocol.md) — distinct from
the wire `Error` envelope, which terminates the session). The host
bridges incoming `Log` envelopes into the local bus with the
appropriate source tag.

## Why

**Why a single bus.** Every host concern wants to surface state to
the user. A single bus gives one render target and one filter
surface; ad-hoc `eprintln!` / `console.error` paths don't.

**Why bounded.** A long-running session can emit unbounded events
(especially under sidecar misbehaviour or signal-decode failures).
Disk-spilling system messages would over-engineer them — they're
not a forensic artefact. Bounded + rate-limited means a flooding
source can't crowd out earlier context.

**Why session-scoped.** System messages are about *this run*.
Cross-session history is `tracing`'s file-sink role — and that
output is still available through the tee.

**Why tee to `tracing`** rather than only route through it. The bus
needs in-process structure (so the panel renders, filters, and
copies). `tracing`'s subscriber is the wrong shape for that —
events go out to formatters, not into a queue you can read back.
Tee'ing means one emit site, both consumers.

**Why bridge from the wire.** Sidecars are out-of-process; they
need a channel for user-visible status that is *not* the
session-terminal `Error` envelope. The wire `Log` envelope's
existence and shape are decided in ADR 0004; what this ADR adds is
the host-side rule that incoming `Log` envelopes feed the same bus
as in-process emitters.

## Consequences

- **Bounded means lossy under flood.** A misbehaving source can
  knock earlier context off the back. The rate limiter is the first
  line of defence; the cap is the backstop.
- **Session-scoped means no postmortem from a previous run.** If a
  user reports a problem from a session that's already exited, the
  bus is gone. `tracing`'s stderr or file output is the only
  persistent record.
- **The wire→bus bridge ships before its live producer.** The host
  side that maps wire `Log` → local bus is in place but has no live
  producer until the first sidecar uses it
  ([ADR 0008](0008-python-can-sidecar.md)).

## Open questions (framing under review)

This ADR was flagged for review when we agreed it. Specific things
to revisit before promoting to a settled `accepted`:

1. **Rate-limit key.** Is `(source, template)` the right axis?
   Per-source-only would be coarser; per-(source, template,
   payload-hash) would be finer. Hasn't been stress-tested under
   real load yet.
2. **Tee-to-`tracing` as architectural commitment vs convenience.**
   Whether the tee is permanent design or "we tee for now because
   the alternative is more code." If the bus could provide all
   consumers `tracing` does today (dev stderr, log files), would we
   drop the tee?
3. **Cross-session persistence.** Bounded + session-scoped means no
   postmortem. For a long-running daemon-style use, is that right?
   Today cannet is GUI-only and per-session; this becomes a real
   question if cannet ever grows a headless mode.
