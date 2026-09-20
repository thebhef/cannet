# ADR 0059 — The wire protocol's version is its protobuf package, and `ServerInfo` states it

Status: accepted (2026-09-20)

## Context

Nothing on the wire said which protocol revision either side spoke.
That was survivable while the GUI was the only client and shipped in
the same bundle as the server it talked to. It stopped being
survivable once a python client module and its CLI existed and
third-party clients became the point: a client needs to know which
protocol it is speaking and detect a mismatch instead of guessing, and
a third-party author needs a written rule for what an upgrade is
allowed to change so they can plan a migration.

What was there before this ADR:

- **The package name `cannet.v1`** in
  `crates/cannet-wire/proto/cannet.proto`, baked into every gRPC
  method path and never read as a version by anything.
- **The mDNS TXT `ver=` key**, which carries the *build* string
  (vergen `git describe`). It is displayed in the Servers panel and
  the CLI, never compared, and absent for a hand-added server or one
  started `--no-mdns`.
- **gRPC metadata** carrying `authorization` and nothing else.

And what a mismatch looked like: an unknown RPC returned
`UNIMPLEMENTED`; the GUI's `connect_flow.rs` had no arm for it and
fell through to `Outcome::Retry`, so an incompatible server presented
as a flapping one and was dialled forever. An unknown `Envelope`
variant was silently dropped on both sides. A semantic change to an
existing field was undetectable by anything.

[ADR 0051](0051-extension-architecture.md) §6 had already committed to
*a* shape — one monotonic version carried by `cannet.proto`, additive
changes never bumping it, an exact match with a clear refusal, no
negotiated capabilities — while assuming GUI↔server compatibility
"already is" that predictable. It was not, until this.

## Decision

**1. The protobuf package name is the major version.** `cannet.v1` is
the major, and it is already in every gRPC method path
(`/cannet.v1.CannetServer/Session`), so both peers state the major
they speak on every request. There is no version field on the wire,
no version metadata entry, and nothing is negotiated.

**2. Inside a major, only additive changes are allowed.** New
messages, fields, RPCs, `oneof` variants and enum values. A tag number
is immutable; a retired tag becomes `reserved`. A field's type and its
*meaning* never change — re-purposing an existing field is breaking
even though the bytes still parse, and that is precisely the case
protobuf's own compatibility rules do not catch.

**3. A breaking change is a new package.** `cannet.v2`, with its own
service, **served beside `cannet.v1`** for a deprecation window, so a
client that has not migrated keeps working rather than being cut off
on the day the server upgrades. Every change in `cannet.proto`'s
history to date was additive, so `cannet.v1` stands.

**4. A server states the packages it serves through `ServerInfo`, in
its own unversioned package.** `crates/cannet-wire/proto/cannet_info.proto`
declares `package cannet;` — not `cannet.v1` — carrying one unary RPC
that answers with the packages served, the build version, and the
instance name. It is deliberately outside every major so that a server
which has *dropped* `cannet.v1` can still answer a `cannet.v1`
client's question. It is frozen: additions only, forever.

**5. `ServerInfo` is unauthenticated.** [ADR 0041](0041-remote-connection-security.md)'s
bearer token gates every other RPC; this one answers without it, so a
client that cannot speak to the server at all is told *that* rather
than that its token is wrong. Nothing it discloses is new — the mDNS
advertisement already puts the instance name, the build version and
(now) the package list on the local network. On `cannet-server` this
means the token gate moved from a server-wide `Server::layer` onto the
services themselves (`auth::gated`); the tests in
`crates/cannet-server/tests/auth.rs` are what now hold the line that
everything else is gated.

**6. The client states nothing extra, and asks first.** Its choice of
package is already in every method path it calls. Every entry point in
`cannet-client` goes through one `ConnectConfig::client()`, which
calls `ServerInfo` on the channel it just dialled and refuses when
`cannet_wire::PROTOCOL_PACKAGE` is not in the answer. Bridges, being
clients, need nothing more.

**7. A mismatch is terminal.** `ConnectionError::IncompatibleProtocol`
and `ConnectionError::Unimplemented` both classify to
`connect_flow::Outcome::Fatal` — no retry, no question to put to the
user, because a running server does not grow a package because a
client asked again. The sentence names both sides:

> serves cannet.v2; this client speaks cannet.v1

The Servers panel, the python client and the CLI all show that same
sentence. An `UNIMPLEMENTED` on *any* RPC is read the same way; it is
what a peer built before `ServerInfo` existed looks like.

**8. mDNS gains `proto=`**, the comma-separated list of packages
served; `ver=` stays the build string. Advisory only — it is absent
for a hand-added server and for one started `--no-mdns` — so it exists
to let the Servers panel grey out a row *before* anything dials it,
and `ServerInfo` on the connection is the gate.

**9. CI enforces the additive half mechanically.** `buf breaking`
diffs the proto against the last release tag, and a second job
regenerates the checked-in python gencode and fails on any diff.

**10. The rule is written where an implementer reads it**: the header
of `cannet.proto`, above `syntax` so protoc does not fold it into
every language's generated docstrings, plus this ADR.

**11. The clock probe's timeout idiom stays.** Inside one major, a
peer can still be older than an additive change and simply not have
it. That is detected by feature probe — send `ClockProbe`, read no
answer within the window as "this peer does not have it" — never by a
version.

### Amendment to ADR 0051 §6

ADR 0051 §6's "one monotonic Extension API version, carried by
`cannet.proto` itself" **is this package major.** An Extension's
manifest declares the package it targets (`cannet.v1`), the host
refuses a manifest naming a package it does not serve, and additive
proto changes never invalidate a manifest — which is what §6 wanted
from a monotonic number, obtained from the name that was already on
every method path. There is no second number to keep in step.

## Why

- **The package major is protobuf's own convention**, so a third-party
  author already knows the rule and their toolchain already enforces
  half of it. A hand-rolled version integer would have to be explained,
  and nothing but our own code would check it.
- **A deprecation window beats an exact match.** ADR 0011's
  `PROJECT_SCHEMA_VERSION` is an exact-match gate with a clear refusal,
  and that is right for a file this app both writes and reads. It is
  wrong for a wire two independently-updated machines meet on: it forces
  every client to upgrade the day a breaking change ships. Two packages
  served side by side cost one more service registration and buy the
  migration window. (Rejected, explicitly.)
- **`ServerInfo` outside every major is the only placement that
  works.** Inside `cannet.v1`, a v2-only server could not answer it,
  and the one case the RPC exists for is the one it would fail.
- **Terminal, not retried**, because the failure is a fact about the
  two builds, not about the network. The retry loop it used to fall
  into made an incompatible server indistinguishable from an unreliable
  one, which is the diagnosis nobody could make from the logs.
- **Advisory `proto=` plus an authoritative `ServerInfo`** keeps the
  advertisement useful without making it load-bearing. A TXT record is
  not a security or correctness boundary: it is not present for every
  server and it is not verified.

## Rejected alternatives

- **A version integer with exact match**, the ADR 0011 pattern applied
  to the wire. Non-idiomatic for protobuf, and it forces a fleet-wide
  simultaneous upgrade. Named here because it was the shape ADR 0051 §6
  assumed.
- **A min/current version range, negotiated.** Negotiation machinery
  the package approach makes unnecessary: with two packages served in
  parallel, "which do we both speak" is answered by a list membership
  test, not a handshake.
- **Reading `ver=` as the protocol version.** It is the build string,
  it is absent for half the servers in the list, and a build number
  says nothing about wire compatibility once server and GUI can be
  updated apart.
- **A version entry in gRPC metadata.** It would have to be attached
  by every client on every call and read by every server, and it would
  duplicate what the method path already says.

## Consequences

- **Every cannet server answers `ServerInfo`**, including the `debug
  replay` and `debug vbus` modes, the in-process
  `serve_virtual_bus_ephemeral` helper, and the python sidecar. A
  server that does not is one no client in this workspace can reach,
  which is what makes the rule self-enforcing for test fixtures too.
- **One extra unary RPC per connection.** It rides the channel that
  was going to be dialled anyway and carries no credential.
- **`cannet-server`'s token gate is per service, not server-wide.**
  Adding a service no longer gates it by construction;
  `crates/cannet-server/tests/auth.rs` is the guard, and it covers both
  halves — every gated RPC refusing, and `ServerInfo` answering.
- **A proto edit now has two CI gates**: `buf breaking` against the
  last release tag, and a gencode-drift check that re-runs the sidecar's
  `scripts/regen_proto.sh` and fails on a diff.
- **Task 69's Extension API version is this package major.** ADR 0051
  §6 no longer implies a separate number.
