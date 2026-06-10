# ADR 0016 — Interface discovery: `ListInterfaces` (pull) + `WatchInterfaces` (push)

Status: accepted (2026-05-25)

## Decision

Every server implementation of the cannet wire ([ADR 0004](0004-grpc-wire-protocol.md))
exposes its CAN interface set through **two** RPCs:

- **`ListInterfaces`** — unary, on-demand. Returns the server's
  current interface list as a one-shot snapshot.
- **`WatchInterfaces`** — server-streaming, long-lived. Pushes a
  fresh interface list whenever the server's view of its hardware
  changes, plus a snapshot on subscribe.

The two are deliberately redundant. A caller that wants one answer
right now pulls; a caller that wants to track changes subscribes.
Neither has to fake the other.

### Where polling lives

**The server polls itself.** Whether and how often to re-enumerate is
a question about driver behaviour — how cheap enumeration is on this
backend, whether the underlying API exposes any hot-plug hint, how
disruptive a stale snapshot is. Only the server can answer. Today
the only hardware-owning server is the `cannet-python-can` sidecar
([ADR 0008](0008-python-can-sidecar.md)); future vendor sidecars and
remote rigs do the same on their own terms.

**The GUI host does not poll.** It picks one of the two RPCs per
remote server it cares about — usually `WatchInterfaces` so the
frontend sees changes for free, occasionally `ListInterfaces` when a
user clicks "Discover" and wants the freshest possible answer right
now.

**The frontend does not poll.** It listens to the host.

### Sidecar log surface — orthogonal

Sidecar warnings and errors travel on the sidecar's stderr stream,
not on this wire. A `WatchInterfaces` push is not a log event and
a log event is not an interface change. Worth saying because the
two are easy to conflate, and remote sidecars in particular need
their warnings to reach the user who launched them — that's a
separate channel concern, not part of interface discovery.

## Why

**Two RPCs because the use cases differ.** Forcing every caller into
one mode is a worse API than letting both shapes coexist. The cost
of carrying both is one extra `rpc` line and a trivial server impl
that shares the same internal cache.

**Polling lives in the server because that's where the knowledge
is.** If the host or frontend polled, the "should we re-enumerate?"
decision — and the change-detection logic that decides whether a
re-poll is worth telling anyone about — would have to live there
too. With two servers it'd be duplicated; with three it'd start
drifting.

**Frontend is a pure subscriber.** A quiet system pays nothing
because nothing crosses the wire. The frontend renders the host's
cache and reacts when it moves.

## Rejected alternatives

- **One RPC, push only.** Every snapshot-only caller — a CLI
  smoke check, ad-hoc tooling, an audit script — would have to
  open a stream and drop it. The cost saving is one `rpc` line;
  the friction is borne forever by every non-streaming caller.
- **One RPC, pull only (current state).** Forces someone to poll.
  Whoever that is becomes wrong: the frontend can't (discovery
  cost scales with open panels, change detection demands holding a
  cache the GUI architecture explicitly says belongs in the model),
  and the host can't (the decision belongs in the server).
- **Reuse the sidecar's stdout banner channel as a change-notify
  signal.** Mixes the data plane with the log plane and doesn't
  generalise to remote `cannet-server` instances that have no
  stdout to the host. Rejected even as an interim measure.
