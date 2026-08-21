# Task 94 — Server Defaults and Discovery Reachability

Opened by owner instruction 2026-08-20, from 0.9.0 usage feedback.
Three observations, one theme: **getting a server reachable is harder
than it should be, and discovery lies about it.**

> - manage servers should be accessible from project view; button to
>   launch server panel would help
> - cannet-server shouldn't require bind. Just do the right thing by
>   default
> - cannet server sends mdns broadcast when not bound to routable
>   address

## Item A — mDNS advertises what it does not serve (a defect)

`Advertisement::register` (`crates/cannet-server/src/discovery.rs`)
registers on `bind`'s **port** and then announces addresses on **every
interface** via `enable_addr_auto()`. Its own doc comment states the
gap:

> Addresses are announced on every interface (`enable_addr_auto()`),
> VM and virtual adapters included — the simple default; binding only
> the interfaces `bind` actually serves on is not implemented.

So a server bound to `127.0.0.1:50051` — **the default** — advertises
itself across the LAN at addresses where nothing is listening. A client
browsing discovery finds it, tries to connect, and fails. The GUI's own
browse path already knows this hurts: `server_browse.rs` notes that "a
single instance arrives with loopback, VM-adapter, …" addresses.

**Fix:** advertise only addresses the bind actually serves. A loopback
bind should either not advertise at all or advertise loopback only —
that is a grooming question below, not an implementation detail.

## Item B — the default bind is the one nobody wants

`--bind` is **not** required; it defaults to `127.0.0.1:50051`
(`main.rs`). The complaint is therefore not that the flag is mandatory
but that the default is wrong for the actual use case: a server on a
bench machine serving a GUI on a laptop. The user must pass
`--bind 0.0.0.0:50051`, which then auto-enables TLS and a bearer token
(ADR 0041), so "just run it" turns into a credentials exercise.

"Do the right thing by default" needs a decision about what the right
thing *is*, given ADR 0041 deliberately makes serving the network an
explicit, secured choice. **This is the task's central design
question** — see below. It must not be resolved by quietly weakening
ADR 0041.

## Item C — reaching the server panel from the project view

Pure UX: the servers panel exists (`showServersPanel` in
`dockLayout.ts`) and is reachable from the command palette. The project
view — where a user is already thinking about buses and sources —
offers no way in. Add the affordance.

## Open questions — grooming

- ~~What should a bare `cannet-server` do?~~ **Resolved 2026-08-20
  (owner): default the bind to `0.0.0.0:50051`.** In the owner's words:
  *"The request is basically to default --bind to 0.0.0.0. The defaults
  are the mainstream case; just start the server."*

  **This bends no rule.** ADR 0041 already says a routable bind
  auto-enables TLS and a bearer token, and `guard_bind` already refuses
  an unprotected non-loopback bind. Changing the default therefore
  changes which branch of ADR 0041 the mainstream user lands on — the
  protected one — rather than changing the policy. `--bind 127.0.0.1`
  remains available for the loopback case.

  **The consequence to implement deliberately:** the mainstream user
  now gets TLS and a token *by default*, so "just start the server"
  only holds if the startup output makes the token and certificate
  fingerprint immediately usable — printed plainly, once, in a form
  that can be pasted into the GUI's connect dialog. A default that
  silently generates a credential the user cannot find has moved the
  friction rather than removed it. Startup output is in scope for this
  task.

- ~~Should a loopback bind advertise at all?~~ **Decided by the
  overseer 2026-08-20: yes, but loopback addresses only.** A
  loopback-only server is a real case — a GUI and a server side by side
  on one machine — so suppressing the advertisement entirely would
  break local discovery. The invariant is narrower and covers every
  case: **never advertise an address the bind does not serve.** With
  the default now `0.0.0.0` this is rarely exercised, which is exactly
  why it needs a test rather than an assumption.
- **Does the browse UI need to say why an endpoint is unreachable?**
  Once advertisements are honest this mostly evaporates; worth
  confirming rather than building.

## Exit criteria (draft — firm at grooming)

- A server never advertises an address it does not serve; tested
  against a loopback bind and a routable one.
- A bare `cannet-server` invocation is useful on a LAN without flags,
  and does not weaken ADR 0041's rule that an unprotected endpoint
  cannot be routable.
- The servers panel is reachable from the project view.
- README reflects however the bare invocation now behaves.
