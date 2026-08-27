# Task 94 — Server Defaults and Discovery Reachability

> **Status 2026-08-23 — code-complete, awaiting acceptance.** Landed
> 2026-08-21 on the chain (nothing has merged). The four exit criteria are
> walked in the status log, all met. Both queue items were accepted
> 2026-08-24: 1.8, the `--no-tls` blast radius (*"it's fine.
> `cannet-server --no-tls` is a pretty clear signal from the user about
> what they're trying to do"*), and 1.9, the second firewall prompt
> (*"ok"*). Nothing is owed.

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


## Blockers / side effects

**No ADR 0041 blocker.** The collision the phase brief flagged resolves
in favour of the owner's ruling: the machinery exists, works unattended,
and the policy is untouched. Evidence in the status log below.

Two consequences of the new default are the owner's to weigh, both
recorded rather than acted on:

- **`cannet-server --no-tls` is now one flag from an unprotected
  routable listener.** Before, that flag alone was a no-op — the default
  bind was loopback, which is plaintext anyway — and serving the
  hardware in the clear on the LAN took two flags (`--bind 0.0.0.0`
  plus `--no-tls`). It now takes one. ADR 0041 names `--no-tls` as
  exactly this escape hatch, "the operator saying out loud they want
  neither", so the posture is unchanged in kind; what changed is how
  short the sentence is. Narrowing it — say, requiring an explicit
  `--bind` alongside `--no-tls` — would be a change to the ADR's escape
  hatch, not an implementation detail, so it was left alone.
- **A bare launch now opens a routable TCP listener**, which on Windows
  draws a Defender Firewall prompt for the binary the first time —
  separate from the mDNS one, for a different port. Documented in the
  README; nothing in the code can pre-empt it.

**Third grooming question, answered rather than built.** "Does the
browse UI need to say why an endpoint is unreachable?" — no. The
unreachable-endpoint case the question came from was the advertisement
publishing addresses nothing served, and that is now impossible by
construction. No browse-UI change was made.

## Status log

### 2026-08-21 — (branch `task-94-server-defaults`)

Branched from `task-96-long-names` at `406cb982`. Three code commits,
each green on `cargo test --workspace` (47 test binaries), `cargo clippy
--workspace --all-targets` (clean but for the pre-existing
`redundant_closure` at `crates/cannet-dbc/src/tests.rs:615`), `cargo fmt
--all -- --check`, and — for the one that touches the frontend —
`npx tsc --noEmit`, `npx vitest run` and `npx vite build`.

`cannet-server` tests: **119 → 128** (2 ignored throughout). Frontend:
**2495 / 189 files → 2499 / 190 files**.

| commit | subject |
| --- | --- |
| `a9206d60` | A server advertises only the addresses its bind actually serves |
| `6743f62e` | A bare cannet-server serves every interface and prints what a client needs |
| `5b8be43a` | The project panel's Connection section opens the Servers panel |

#### Item A — what mDNS advertised, measured

*Observation.* `Advertisement::register` passed `bind.port()` to
`service_info` and dropped `bind.ip()` entirely, then called
`enable_addr_auto()`.

*Hypothesis.* The advertisement carries no information about what the
bind serves, so a loopback bind and a wildcard bind publish the same
address set.

*Experiment.* A throw-away probe registered a real advertisement and
browsed for it in-process, printing the resolved address set — once for
`127.0.0.1:50061`, once for `0.0.0.0:50062` as the discriminating
control. If the hypothesis were wrong, the loopback set would be a
strict subset of the wildcard one.

*Data (before).*

```
[loopback bind] bind=127.0.0.1:50061 is_addr_auto=true explicit_addresses={}
[loopback bind] resolved on the wire: {10.10.10.50, 127.0.0.1, 172.26.208.1,
  172.29.96.1, 192.168.127.1, 192.168.226.1, ::1, fe80::9:12b9:dcae:57f1,
  fe80::61b:793e:2609:ced5, fe80::e5b1:39db:51d2:6349, fe80::edce:a8a3:f2fa:fce6}
[wildcard bind] bind=0.0.0.0:50062 is_addr_auto=true explicit_addresses={}
[wildcard bind] resolved on the wire: {the identical eleven}
```

*Conclusion.* Confirmed. Eleven addresses published for a server
answering on one of them, and the two sets identical.

*Data (after).* Same probe, same machine:

```
[loopback bind] bind=127.0.0.1:50061 is_addr_auto=false explicit_addresses={127.0.0.1}
[loopback bind] resolved on the wire: {127.0.0.1}
[wildcard bind] resolved on the wire: {the same eleven}
```

The loopback advertisement still resolves, which is what the overseer's
ruling asked for — a loopback server stays discoverable on its own
machine — and it no longer names an address it does not serve. The
control still publishes everything, because for a wildcard bind that is
the truth. The probe was deleted; `discovery.rs` carries four unit tests
in its place, covering wildcard, loopback, a single routable interface,
and the IPv4-mapped spelling.

#### Item B — the ADR 0041 collision, resolved

The brief asked which of two things the `0.0.0.0` default is. It is the
first: **the machinery exists, runs unattended, and ADR 0041 is not
weakened.** Evidence:

- `ServerIdentity::load_or_generate` mints and persists a self-signed
  certificate on first run and reloads it thereafter (`identity.rs`;
  `a_routable_bind_auto_enables_tls_with_no_flags`).
  `AccessToken::load_or_generate` does the same for the token
  (`without_either_the_persisted_token_is_reloaded`). Neither asks the
  operator anything.
- Nothing about a routable bind is unprotected by accident: `identity()`
  returns `Some` for one, and `run_proxy` derives the token exactly when
  TLS is on. `a_bare_launch_never_serves_the_hardware_unprotected` runs
  the *default* bind through `guard_bind` with the protections the
  default actually produces, so a future change to either side breaks a
  test rather than the posture.
- The generated certificate's SANs (`localhost`, `127.0.0.1`, `::1`) do
  not cover a LAN name — and do not need to. `cannet-client`'s
  `PinVerifier::verify_server_cert` ignores `_server_name` by design:
  pinning replaces path validation. A GUI on a laptop dialling
  `bench:50051` therefore completes the handshake against the pinned
  fingerprint.
- ADR 0041's rule is "an unprotected endpoint may only be loopback".
  Moving the default onto the routable side changes which branch an
  unconfigured launch lands on — the protected one — not the line. The
  ADR states no default bind, so no amendment was needed and none was
  made.

*What a bare `cannet-server` now does.* Binds `0.0.0.0:50051`. Loads or
generates `server-cert.pem` / `server-key.pem` and `access-token` in the
per-user data directory. Advertises `_cannet._tcp` on every interface
(correct, for a wildcard). Logs the fingerprint, the fact that a token
is required, and the listen address; then prints one console-only block:

```
connect a cannet GUI to this server:
  address      bench:50051
  fingerprint  SHA256:4EMRWrqj5MtP7Lxx4DjdNGUhBPIUijAl4UZekXCJwAc
  token        chug-pruning-unclad-hazard-morphine
```

A client needs the address (or the row the browse list already shows),
accepts that fingerprint once in the trust dialog, and pastes that
token. The block replaces the lone `client token …` console line; it
stays console-only, so the logfile still learns only that a token is
required.

That block is real output captured from the built binary, run
`--bind 127.0.0.1:50151 --cert … --key …` — loopback, forcing the same
TLS-and-token branch — because this branch was implemented on the
owner's machine and does not open a listener on their LAN to prove a
point. The wildcard-address rendering is covered by
`the_wildcard_bind_is_advertised_as_this_machines_name` instead.

#### Item C

The launcher exists twice already, both times inside a bus row
(`BusInterfaceCombo`'s "Manage servers…" option and
`BusServerTrustNotice`'s button), both calling the same
`showServersPanel(containerApi)`. The Connection section's button row
now carries it too, unconditionally — that row previously rendered only
when the project had a binding, which is the opposite of when a user
needs to add a server. Asserted through the dock API the launcher drives
(`addPanel` with the servers panel id; `setActive` when one is already
open) rather than through a spy on the launcher.

#### Exit criteria

| criterion | verdict | earned by |
| --- | --- | --- |
| A server never advertises an address it does not serve; tested against a loopback bind and a routable one | met | `a_loopback_bind_advertises_loopback_and_nothing_else`, `a_bind_to_one_routable_interface_advertises_only_that_interface`, `a_wildcard_bind_announces_every_interface_automatically`, `an_ipv4_mapped_bind_is_advertised_as_the_ipv4_address_it_names` — plus the before/after wire measurement above |
| A bare `cannet-server` is useful on a LAN without flags, and does not weaken ADR 0041 | met | `bare_invocation_is_the_proxy_serving_every_interface`, `a_bare_launch_never_serves_the_hardware_unprotected`, `the_loopback_bind_is_still_one_flag_away`, `the_connect_summary_carries_everything_a_client_needs_and_nothing_else`, and the evidence chain above |
| The servers panel is reachable from the project view | met | `ProjectPanel.manageServers.dom.test.tsx` (4 tests) |
| README reflects however the bare invocation now behaves | met | README § Running the production server (bare invocation, sample output including the connect block, the `--bind` default, the Windows firewall note, the advertised-address rule), § Running the bundled server, § Connecting the GUI to a protected server, and the project-panel paragraph for the new launcher |
