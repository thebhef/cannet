# ADR 0004 — Wire protocol is gRPC over HTTP/2; the wire is the universal driver contract

Status: accepted (2026-05-24)

## Decision

All non-in-process driver communication uses **gRPC over HTTP/2**.
The Rust implementation is [`tonic`](https://docs.rs/tonic)
(MIT) with [`prost`](https://docs.rs/prost) (Apache-2.0) for
protobuf encoding; `tonic-build` (MIT) runs codegen on both server
and client. The schema lives in `crates/cannet-wire` as `.proto`
files — one source of truth for every speaker of the protocol.

The same service definition is implemented by every driver context:

- **In-process drivers** (the BLF replay source, future Rust-native
  drivers) speak it through a loopback channel.
- **Local sidecar processes** (the `cannet-python-can` sidecar of
  ADR 0008 once it lands) speak it over loopback TCP.
- **Remote test rigs and Rust-native servers** speak it over the
  network with optional TLS via tonic's `tls` feature
  (rustls — Apache-2.0/MIT/ISC).

Plaintext loopback is the dev default; TLS is opt-in.

### Service surface

The service is two RPCs:

- **`ListInterfaces`** — unary, on-demand discovery of the CAN
  interfaces a server exposes.
- **`Session`** — a single **bidirectional** stream of `Envelope`
  messages. Frames travel symmetrically in either direction using
  the same wire shape; rx and tx are the same operation in opposite
  directions.

The service shape is deliberately small — the per-bus configuration
and bus-state surface lives inside `Envelope` variants and
`Interface` metadata, not as additional RPCs, so adding parameters
or state fields is an additive schema change rather than a new
endpoint.

### Envelope variants

The `Session` stream carries a tagged-union `Envelope`:

- **`Subscribe`** / **`Unsubscribe`** — control: the receiver
  declares interest in a set of `(bus, id)` keys.
- **`FrameBatch`** — the only frame-carrying variant. The wire
  crate's batching adapters group frames on the way out and unbatch
  on the way in, so application code consumes `Stream<CanFrame>`
  and never sees a batch directly.
- **`Error`** — terminal: a session-ending wire-level fault. After
  an `Error` the stream is closed and the session is over.
- **`Log`** — continuous, non-terminal: a structured status entry
  (`ts`, `source`, `level`, `message`, optional payload) that the
  receiver bridges into its local system log. **Distinct from
  `Error`** — log entries occur many times over a session; errors
  end it.

The host-side semantics of how `Log` envelopes are consumed
(bounded ring, session scope, flood protection, tee to `tracing`)
belong to the host system log of ADR 0014, not to the wire.

### What the wire deliberately is not

- **Not a scheduler.** Cyclic / scheduled transmission is a
  client-side feature of the transmit panel. The wire carries the
  frames that are sent; it does not know they were sent on a
  cadence.
- **Not an aggregator.** Per-id rate, dropped-frame counters, and
  decoded-signal series are derived by the consumer from the
  `FrameBatch` stream, not delivered as their own variants.

## Why

**gRPC, not a hand-rolled RPC over raw TCP.** Generic RPC plumbing
— request/response correlation, server-streaming lifecycle,
cancellation, half-close, flow control / backpressure — is
failure-mode-rich code that is easy to ship subtly broken and hard
to catch in review. Tonic gives all of it from a vetted runtime.

**Protobuf, not bincode/postcard.** Schema evolution is enforced by
tooling: field tags, `reserved`, unknown-field preservation. Ad-hoc
binary encodings make most struct or enum changes wire-breaking
unless we hand-roll a versioned envelope layer — and the schema
covers a non-trivial surface area (transmit, bus configuration, bus
state, hardware metadata) where wire-breaking changes compound.

**One service shape for every driver context.** Picking the same
contract for in-process, sidecar, and remote means new drivers slot
in without touching the protocol. A `python-can` sidecar implements
the same `.proto` as a Rust-native driver; a remote rig implements
the same `.proto` again. Cross-language support is free: gRPC has
runtimes for every mainstream language.

**Symmetric bidi stream, not separate up/down channels.** One
stream carries both directions. Two streams would double the
connection bookkeeping (lifecycle, cancellation correlation,
half-close edge cases) for no semantic gain.

**Hot-path overhead is acceptable.** For the payload sizes the wire
carries (256-frame batches ≈ 10–15 KB) gRPC's overhead vs raw TCP
framing is sub-percent.

## Consequences

- **`cannet-wire` is the only place the protocol changes.** Edits
  to `.proto` files there propagate through `tonic-build` on every
  consumer. Field additions are non-breaking; removals require
  `reserved`.
- **`async-stream`** (v0.3, MIT) is pulled in as a wire-crate
  implementation helper so stream adapters (`unbatch_frames`, the
  server's looping replay source) can be expressed as ordinary
  async control flow rather than hand-rolled `Stream` impls with
  manual `Pin` plumbing.
- **Cross-language clients land for free.** ADR 0008's
  `cannet-python-can` sidecar uses `grpcio` (Python, Apache-2.0)
  to speak the same `.proto`; the wire crate exports nothing
  Python-specific.
- **Future driver kinds add no protocol work.** A new Rust-native
  driver, a second-vendor sidecar, or a remote rig each implements
  the same service surface. The wire stays one contract; transport
  details vary at the channel layer (loopback / TCP / TLS).
- **TLS stays optional.** Loopback drivers run plaintext; remote
  rigs opt in via the `tls` feature. The wire crate does not
  hard-require rustls.

## Rejected alternatives

- **Raw TCP with length-prefixed framing + `prost`** — lowest
  framing overhead, but moves the generic RPC layer
  (request/response correlation, server-streaming semantics,
  cancellation, sink multiplexing, half-close, backpressure) into
  hand-written code. Cross-language clients would each need our
  envelope reimplemented rather than picking up an off-the-shelf
  gRPC runtime.
- **Raw TCP + `bincode` / `postcard`** — same RPC-layer problem as
  above, plus weak schema-evolution semantics: most struct/enum
  changes are wire-breaking unless we hand-roll versioned envelopes.
  Discipline by convention is not the same as discipline enforced
  by tooling.
- **ZMQ** — MPL-2.0 (libzmq) + MIT (`zmq` Rust binding). The sync
  C binding doesn't compose with the tokio runtime cannet already
  uses, the pure-Rust `zeromq` reimplementation is sparsely
  maintained, and ZMQ's pattern set (PUB/SUB + ROUTER/DEALER)
  pushes toward a two-socket design where one bidirectional stream
  covers the need. Doesn't solve the schema/encoding problem
  either — that would still be ours to pick on top.
- **WebSockets via `tokio-tungstenite`** (MIT) — the HTTP-upgrade
  handshake and per-frame masking exist to serve browser clients
  cannet doesn't have; the GUI client is the Tauri host (Rust).
  Same schema/encoding question as raw TCP, no offsetting benefit.
