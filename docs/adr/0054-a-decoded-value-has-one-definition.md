# ADR 0054 — A decoded CAN signal value has exactly one definition

Status: accepted (2026-08-20)

## Context

Every decoded value in the app comes from one signal definition, in one
message, from one ECU, in one database, on one bus. That is not a
design preference; it is what a decoded CAN value *is*. A frame arrives
on a bus, one message definition describes it, one signal definition
inside that message describes the bits, and the value follows.

That fact was never written down as a decision. It lived in three
places, none of them citable by code:

- **A test name** — `first_dbc_wins_per_signal_not_per_message`
  (`signal_cache.rs`) pins the resolution rule and nothing else states
  it.
- **Task documents** — the assignment-filtered load order and the
  per-signal override were settled in `plans/tasks/`, which churns, and
  which source is forbidden to reference.
- **[ADR 0038](0038-canonical-signal-path.md)** states the identity
  tuple `(bus, message id, extended, signal name)` but scopes itself to
  presentation and matching: it decides what a signal is *called*, not
  where its value comes from.

The cost of leaving it unstated was paid in drift. Subsystems
re-derived the rule independently and got it wrong in ways that only
show up as silent wrong answers:
`signal_fingerprint::dbc_encoding` hashed each candidate database's
entire bus-assignment list — after the eligibility filter had already
narrowed to the one bus that matters — and hashed every eligible
candidate rather than the one that wins, so two states that decode
identically produced different fingerprints and parked caches whose
values could not have moved.

## Decision

**A decoded CAN signal value is produced by exactly one signal
definition, and everything derived from that value depends on that one
definition and nothing else.**

Three parts:

1. **Identity.** A decoded series is identified by
   `(bus, message id, extended, signal name)`, as
   [ADR 0038](0038-canonical-signal-path.md) already states. The
   identity does **not** name a database: a signal is one series
   whoever supplies its definition, and adding a database field would
   mean two decodes of one signal.

2. **Resolution.** Which database supplies the definition is decided,
   in order:
   - the databases **assigned to that bus** — an unassigned database
     decodes nothing
     ([ADR 0023](0023-logical-bus-vs-interface.md) for what a bus is);
   - among those, **project load order**, first definition wins, per
     signal rather than per message;
   - unless the project records an **explicit per-signal choice**, which
     overrides load order for that signal alone. Absent means "resolve
     by order", so a project that never made a choice behaves exactly as
     if the mechanism did not exist.

3. **Derivation.** Anything keyed on *how a value decodes* — encoding
   fingerprints, cache identity and revival, value tables, unit and
   scale — depends on the winning definition's decode specification and
   on nothing else. Not on which other databases exist, not on what
   else the winning database is assigned to, not on candidates that
   never win.

## Consequences

- **Two states that decode identically must produce the same
  fingerprint.** That is the test for whether a derived key is correct:
  if a change cannot move a sample, it must not change the key. A
  different database supplying an identical definition is the same
  encoding, and a parked cache revives against it — which is what makes
  "the view is restored by the signal, its samples by the fingerprint"
  true.
- **A database's other bus assignments are irrelevant** to a series on
  the bus it does apply to, and must not appear in anything derived
  from that series.
- **Candidates that do not win are irrelevant.** Loading a database
  that defines a signal it never supplies changes nothing about that
  signal's values.
- **Ambiguity is a reportable condition, not a silent one.** Two
  assigned databases defining the same signal on one bus is legal and
  resolvable, but the resolution is invisible in the value, so it is
  surfaced rather than left to load order alone
  (the Database panel warns; the signal mapping panel is where a choice
  is made).
- **Views name signals, not databases.** A plot series reads
  `bus.ecu.signal`; no view that reports signals or messages
  disambiguates by database, because the value has one definition and
  the user should not have to think about which file it came from
  except in the one place the choice is made.
- [ADR 0047](0047-persisted-signal-pyramids.md) is bound by part 3: its
  encoding fingerprint identifies the winning definition. Where it
  hashed more than that, the fingerprint was wrong, not merely
  wasteful.

## Alternatives considered

**Leave it implicit.** It already was, and the drift documented above is
the result: a core identity function acquired two spurious inputs
because nothing said what it was supposed to identify, and reviewers had
no durable statement to check it against.

**Put the database in the signal identity.** Rejected: it would make one
signal into several series, decoded and cached separately, which is the
opposite of what the model needs and defeats the purpose of resolving
the ambiguity at all.

**State it in the task documents only.** Rejected by the working
agreement: `plans/` records what is *planned* and churns as it lands,
while ADRs record what *is*. Source may cite an ADR and must not cite a
task, so a rule that lives only in `plans/` is one no comment can
point at.
