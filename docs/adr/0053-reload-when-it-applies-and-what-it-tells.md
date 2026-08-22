# ADR 0053 — A reload: when it applies, and what it must tell

Status: accepted (2026-08-19)

## Context

Three kinds of file back a working session, and they are not the same
kind of thing:

- **Externally-owned inputs.** A DBC is authored somewhere else — a
  database tool, a colleague's export, a generator script. The app
  reads it and never writes it. The user's expectation is that the app
  tracks the file.
- **App-owned documents.** The project (`.cannet_prj`) and an RBS
  (`.cannet_rbs`) are written *by this app*: an explicit Save, plus
  autosave paths. The in-memory copy can be ahead of the file, and the
  file can be ahead of the in-memory copy.

Only the first kind is watched today
(`apps/gui/src-tauri/src/dbc_watcher.rs`): a loaded DBC's parent
directory is watched, any event that touches a loaded path re-reads and
re-parses, a broken parse leaves the working copy intact, and a deletion
does not unload. That machinery is sound. What was never written down is
the pair of rules around it.

**The first missing rule is *when* a change on disk may be applied.**
A DBC may swap in place because nothing of the user's is at risk. A
project may not: reloading it re-roots the session
([ADR 0042](0042-project-directory-and-scopes.md)) and drops the
connection, and the session can hold unsaved changes that a blind
reload would discard — while autosave-on-exit would discard the
external edit instead. An RBS element that is *transmitting* is putting
frames on a real bus; swapping its definitions underneath it is not a
refresh, it is an uncommanded change of what the tool is sending.

**The second missing rule is what a reload must *tell*.** The host
already invalidates correctly — every DBC-set change ends at
`invalidate_derived_caches`, and the pyramids are judged per signal
against their encoding fingerprint
([ADR 0047](0047-persisted-signal-pyramids.md)) rather than dropped.
But a rebuild is lazy by design
([ADR 0049](0049-bounded-serves-and-partial-answers.md)): nothing
decodes until a view asks. So an invalidation that nobody is told about
is invisible, and four separate consumers were caught by it:

- **Value tables** (`useValueTables`) keyed their fetch on the signal
  set alone. A panel that mounted before its project's DBCs were
  installed cached "no table" for the session and recovered only on
  remount — the enum lane that stayed numeric until the view was closed
  and reopened.
- **The RBS view** rebuilt its rows on a DBC change (the host's
  `rbs::refresh_all_elements` runs on every DBC path and emits
  `rbs-changed`) but rendered its enum labels out of the value-table
  fetch above, so an edited `VAL_` label never reached it.
- **The plot** re-asked the host on a frontend-initiated DBC change,
  because those bump the trace model's re-anchor epoch, and did not on
  the *watcher* path, because nothing translated the host's
  `dbc-changed` event into an epoch bump.
- **The filtered chronological view** keyed its window on
  `${winStart}:${filter}` with no model epoch at all, though its
  predicate is decoded against the DBC set.

Underneath all four is one asymmetry: `add_dbc` did not emit
`dbc-changed` — only the watcher reload and the capture-embedded install
did — while the frontend refreshed its catalog on a DBC-*set* change
*and* on `dbc-changed`. Neither half was complete, so which consumers
learned of a change depended on which path the change came in on. Every
fix so far has been one consumer subscribing to one of the two halves,
which is exactly how it drifted.

One ADR covers both halves because the gap is what happens between
them: a rule about when a file is applied is worth nothing if applying
it does not reach the views.

## Decision

### 1. An externally-owned input swaps in place; an app-owned document applies only when it is safe, and otherwise notifies

- **DBC — swap.** Re-read, re-parse, replace the in-memory database,
  keep the entry's bus scoping and priority position. The
  `dbc_auto_reload` setting is the opt-out, and the existing failure
  semantics stand: a broken parse logs and leaves the working copy
  intact; a deleted file logs and stays loaded.
- **Project and RBS — apply only when nothing of the user's is at
  risk, otherwise notify.** "Notify" means a visible, dismissible
  statement that the file changed on disk, carrying the explicit action
  (Reload / Apply anyway) as the only way it is applied.
  - A project applies silently only when the in-memory project is
    clean. **Mid-capture is never safe**, clean or not: the reload runs
    the existing open-project path, which re-roots the session
    (ADR 0042) and drops the connection.
  - An RBS applies silently only when the element is **clean and
    stopped**. Unsaved edits, or the element actively transmitting,
    both mean notify.
- **A reload is the existing open path, not a merge.** There is no
  element-level reconciliation engine; a project reload is
  `open_project`, an RBS reload is the `.cannet_rbs` load path.

### 2. Every change to the loaded DBC set announces itself, from the host, as one event

`dbc-changed` is emitted by **every** host path that changes what the
DBC set decodes — add, reload in place, re-scope, remove, clear, the
filesystem watcher's reload, and the capture-embedded install. There
are no exceptions and no "the caller already knows" cases: a host path
that changes the set and stays quiet is a defect, and it is the only
rule that has to hold for every consumer below to be correct.

The event is emitted **after** the host has invalidated
(`invalidate_derived_caches`) and rebuilt what it rebuilds eagerly
(RBS rows, calculated-field resolutions, verification). A consumer that
reacts to the event must never be able to read a cache the change has
not reached yet.

### 3. The event is the carrier. The re-anchor epoch is a consumer of it, not a second channel

The frontend's trace-model re-anchor epoch stays what it is — the
identity of the decoded model that every windowed view folds into its
fetch descriptor ([ADR 0025](0025-frontend-windowed-source-contract.md))
— and a DBC change becomes one of its inputs rather than a parallel
route to some views. The host event is authoritative because it is the
only one of the two that covers changes the frontend did not initiate.

The frontend subscribes to `dbc-changed` in exactly **one** place
(`dbcChanged.ts`), which owns the single listener and publishes a
monotonic *DBC generation*. Each shared frontend model reads that
generation once: the trace model epoch, the signal catalog, the
value-table fetch, the Database view's content snapshot. **No panel
subscribes.** A view gets told because the shared model it reads was
told.

### 4. A view that renders DBC-derived state folds the carrier into the identity of what it fetches

Stated over kinds of derived state, not over today's panels — anything
in this list is covered whatever renders it tomorrow:

| Derived state | What must re-ask |
| --- | --- |
| Decoded frame rows | the chronological window's descriptor |
| Filtered / predicate views | the filtered window's descriptor (the predicate is decoded) |
| Decoded samples (pyramids) | the plot's decimated-source descriptor |
| The descriptor universe | the signal catalog |
| Enum labels (`VAL_` / channel conversions) | the value-table fetch |
| RBS rows and bindings | the host's element rebuild, which already runs on every DBC path |
| A database's own content view | the Database view's snapshot |

"Fold it into the identity" is the operative phrase: a memo whose key
asks "could this request return different bytes?" is wrong if the DBC
set is not one of its inputs. A live capture hides that — its window
moves and re-keys the memo incidentally — and a stopped capture, or a
plot parked in history, does not, which is why the symptom always read
as *intermittent*.

### 5. Notification is coalesced, in one place, and the coalescing is stated

Fan-out from the single subscription is **trailing-debounced by 250 ms**,
and a frontend batch may **suppress** it explicitly and take the single
fan-out when the batch ends.

Both are deliberate, and both are here because the announcement in §2 is
per-change while the work it triggers is per-set:

- One editor save produces a *burst* of filesystem events (atomic
  rename, truncate-then-rewrite, multi-step temp+rename), each of which
  is separately re-read and re-parsed by design. Without coalescing that
  is one full refresh per event.
- Opening a project is `clear_dbcs` + N × `add_dbc` + M ×
  `set_dbc_buses`, all separate host calls and so N+M+1 announcements
  for one set change. Un-coalesced that is the refresh storm already
  recorded in `App.tsx` — observed once as a blank app when it raced
  live streaming at boot — and re-creating it while fixing a
  notification gap would be a poor trade. The batch guard makes a
  project open exactly one fan-out, deterministically, rather than
  relying on N host calls fitting inside a debounce window.

Coalescing is safe because the fan-out is **idempotent and
state-free**: consumers re-ask the host, which is authoritative; no
consumer accumulates across notifications. A frontend-initiated change
additionally re-anchors at its own call site, synchronously, so the
debounce is never in the user's way for their own gesture.

## Why

- **The host is the only place that sees every change.** A capture
  import installs an embedded database; the watcher swaps one under an
  idle app. A contract carried by frontend call sites cannot cover
  those, and every attempt to patch one consumer at a time left the
  others on whichever half they happened to subscribe to.
- **One carrier, one subscription, many readers** is the same rule the
  GUI already follows for data: views are thin over shared model state.
  Four panels each listening for `dbc-changed` is four chances to
  forget; one generation that every shared model reads is one.
- **Invalidation and notification are different obligations.** The host
  had the first right for a year and the second wrong the whole time,
  and the symptom was indistinguishable from a caching bug — which is
  what sent two investigations after the cache before the view was
  found not to be re-asking.
- **Externally-owned versus app-owned is the honest axis for the
  apply/notify split.** Not "how expensive is the reload" or "is the
  file big": the question is whether the app has state in that file
  that a swap would destroy. A DBC never does. A project or an RBS
  routinely does.
- **Mid-capture is a hard no, not a heuristic.** A project reload
  re-roots the session and drops the connection, so "apply silently
  because the project is clean" would still end a running capture the
  user is watching. The rule is stated as a precondition rather than
  weighed against dirtiness.
- **Coalescing belongs at the subscription, not at the emit.** The host
  cannot know that six calls are one user gesture; the frontend that
  issued them can. Debouncing at the emitter would also delay the one
  case that must not be delayed — the host's own knowledge that its
  caches are already gone.

## Amendment (2026-08-20) — the deliberate counterpart to §1

§1 protects a transmitting element from a *file changing underneath it*:
an RBS that is running does not swap in place, it notifies. It says
nothing about the user reaching the same place on purpose.

Unassigning a database from a bus is that gesture. Once no database
assigned to a bus defines a message any more, a periodic still firing
for it is putting frames on a real bus from definitions the project no
longer applies — §1's uncommanded send, reached deliberately instead of
by an external edit. So:

- **The periodic stops**, through the same path the user's own Stop
  takes (`transmit_commands::stop_periodic_transmit_inner`). It is not a
  half-state only this path can produce: the row keeps its
  configuration, and the running flag every view reads is the one a Stop
  leaves.
- **The assignment change always proceeds.** Refusing while something
  runs was rejected: it would make assignment conditional on the user
  first hunting down what is transmitting, which is the opposite of what
  the Database panel's checkbox is for.
- **One system-log entry records it, however many stopped.** No modal
  and no per-element notice — the gesture was deliberate, so the user
  does not need to be interrupted with its consequence, only to be able
  to find it.

"Built from a database that left" is measured against what the bus can
still decode, not against file identity: a row another assigned database
still defines keeps firing, and a row no database on the bus ever
described — a CAN id typed by hand — is none of the change's business.
Removing a database from the project removes it from its assigned buses,
so it reaches this rule by the same route.

## Consequences

- A `VAL_` label edited on disk reaches the RBS panel, the plot's enum
  axis and readout, the colormap picker and the transmit table without
  a manual reload, because all of them read the one value-table fetch
  and it now re-asks.
- A DBC change on any path — including a plain project open, which
  emitted nothing before — re-anchors every trace window, the filtered
  window and every plot, so a stopped capture no longer renders the
  pre-change decode indefinitely.
- A project open costs exactly one fan-out, unchanged from before this
  ADR despite the host now announcing every step of it.
- One editor save costs one fan-out, where the host still performs one
  re-read and re-parse per filesystem event (unchanged, and cheap
  beside the refresh it used to trigger).
- A consumer added later inherits the contract by reading a shared
  model; if it needs a new kind of derived state, §4's table grows a
  row rather than the app growing a subscription.
- The project and RBS watches inherit both halves: they register with
  the same watch set, and whatever they apply announces itself the same
  way.
- The frontend's fan-out is delayed by up to 250 ms after a host-side
  change. Nothing user-initiated waits on it, and no host state is
  gated by it.
