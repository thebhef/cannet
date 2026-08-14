# ADR 0051 — Extension architecture: out-of-process, GUI-host-supervised, one evolving proto

Status: accepted (2026-08-13)

## Context

Users want to install third-party code that extends cannet and keeps
working across upgrades absent breaking changes — a fault-decoder that
watches specific CAN messages and emits events, and a CANopen client
that runs a request/response handshake against the bus and emits what
it learns. ADR 0035 already named the shape of the output (the
extension/utility timeline-event kind, sanctioned to emit through
the existing event store) but nothing generates one today. The RBS
external-value-source work explicitly deferred a generic inbound
control API and extension framework as out of its scope. This ADR is
the deferred design.

cannet already has a working precedent for exactly this shape of
problem: the python-can sidecar (ADR 0008, ADR 0036) is third-party-
adjacent code, supervised as a child process, speaking a versioned
gRPC contract (`cannet.proto`) the host dials into. Extensions reuse
that precedent rather than inventing a new one, with the differences
that make an Extension not just another sidecar: it is user-installed
rather than vendor-hardware-specific, it observes the *capture model*
(already-ingested, already-filtered) rather than a raw hardware
interface, and it may contribute UI.

## Decision

1. **Out-of-process, GUI-host-supervised.** An Extension is a child
   process spawned and supervised by the GUI's Tauri host — the same
   supervision shape as a local sidecar (spawn, listen on an ephemeral
   port, announce it via a stdout banner, host dials in as the gRPC
   client; stdin-EOF is the graceful-stop signal, process-tree kill is
   the backstop). No native-dylib / FFI option: there is no stable
   Rust ABI, so an in-process load would break on every host rebuild,
   defeating the "persists across versions" requirement outright.

2. **GUI-side only, never server-side.** cannet-server doesn't decode
   or log; it exposes hardware. Extensions are consistent with that —
   supervised by the GUI host only. An Extension stops running when
   the GUI isn't running; this is accepted, not a gap (Extensions are
   not meant to be always-on background daemons in v1).

3. **Extensions talk only to the GUI host — never a bus source
   directly.** An Extension's one channel is its connection to the
   host. It does not dial a sidecar or cannet-server itself. This
   sidesteps whether a hardware interface subscribe is exclusive
   (CONTEXT.md: virtual-bus `Subscribe` is an exclusive per-session
   claim), and keeps supervision, RPC, and data-filtering as one
   relay point instead of two.

4. **Host-side filtered frame subscription.** An Extension subscribes
   with a filter (bus + arbitration-id list/range — the existing
   Filter-predicate concept). The host only forwards matching frames.
   With N installed Extensions, unfiltered firehosing would make every
   Extension pay full bus-rate IPC + decode cost regardless of what it
   needs; filtering at the source keeps cost proportional to what each
   Extension actually watches.

5. **New sibling gRPC service, `ExtensionHost`, in `cannet.proto`.**
   Not a reuse of `CannetServer.Session`: that RPC's `Subscribe`
   addresses a hardware `interface_id` with no filter concept, and its
   `Envelope` has no Event or Signal variants. `ExtensionHost` shares
   `cannet.proto`'s `Frame` message and gains its own subscribe shape
   (filter predicate) plus new `Event` and `Signal` messages — the
   proto grows to carry the two capabilities Extensions need beyond
   frames, once for all future consumers, not just this one.

6. **Compatibility gate: one monotonic Extension API version, carried
   by `cannet.proto` itself.** Additive wire changes (new optional
   fields/RPCs) never bump it; breaking changes do. An Extension's
   manifest declares the version it targets. The host checks this at
   launch and refuses with a clear error on mismatch — no negotiated-
   capability handshake (LSP-style), no silent reliance on protobuf's
   raw forward/backward compatibility to paper over semantic breaks.

7. **Transmit requires manifest-declared, install-time consent.** An
   Extension's manifest states whether it transmits. The host enforces
   this at the RPC layer — a `SendFrame` from an Extension whose
   manifest didn't declare transmit is rejected, the same posture the
   wire protocol already takes toward read-only sources
   (`CODE_TX_REJECTED`). Third-party code that can actuate physical
   hardware doesn't get transmit by default just because it's enabled.

8. **Contributed views are sandboxed webviews with an opaque relay.**
   An Extension may bundle static HTML/JS/CSS; the host loads it into
   a dockview-hosted webview panel via a scoped local-asset scheme. The
   webview's only channel is `postMessage`, relayed by the host to/from
   the Extension's backend process over the same extension host
   connection — the host relays bytes, it does not interpret them. This
   is VS Code's Webview API shape. The Extension owns the view's
   rendering and its performance; the host's paged/thin-views
   discipline (CLAUDE.md) applies to the *data* an Extension can
   request (still filtered/subscribed through the typed RPCs above),
   not to what the view does with it once received.

9. **Per-user extensions directory, no registry.** Extensions live
   under a machine-global directory in the GUI host's app-data root
   (ADR 0032's pattern), one subdirectory per installed Extension. No
   marketplace, no auto-update — consistent with the project's current
   no-registry posture for vendor SDKs and DBCs.

10. **Package format: single-file archive (`.cannet-extension`, a
    zip), extracted on install.** Contains the manifest, the
    entrypoint executable, and the optional webview asset bundle.
    Mirrors VS Code's `.vsix`: one file to download, share, or attach
    to an email — a bare directory doesn't read as "an extension" to
    someone browsing downloads. An unpacked directory in the extensions
    root is still valid to the host (no re-pack step needed for local
    Extension development).

11. **In-repo reference Extension, in Python, exercising the full
    surface.** Mirrors the python-can sidecar's `uv`-managed dev flow
    (ADR 0008/0036) rather than living in-workspace as a Rust crate.
    A Rust reference would be a weaker proof of "any language can
    write an Extension" — it's the wrong flex for third-party authors
    who aren't workspace maintainers to copy from. It exercises: frame
    subscribe + send (with transmit consent declared), event emit,
    signal read, and a contributed webview view.

## Why

- **Reuse over invention.** Every piece of new machinery here
  (supervision, versioned wire contract, filtered subscription,
  webview sandboxing) either directly reuses an existing cannet
  pattern or is the smallest addition that pattern doesn't already
  cover. The alternative at each fork was more bespoke plumbing for a
  problem the codebase had already half-solved.
- **One evolving proto, not a parallel one.** Tracking
  `cannet.proto`'s own version (rather than a separate Extension
  schema/version) means Extension compatibility is exactly as
  predictable as the wire protocol GUI↔server compatibility already
  is, and Event/Signal become available to every future proto
  consumer, not just Extensions.
- **Transmit consent matches the codebase's existing safety posture.**
  ADR 0041 treats unauthorized bus transmit as the top threat for a
  network client; third-party local code with transmit is the same
  risk in a different guise, so it gets the same "reject at the
  source" treatment rather than trusting the caller.

## Rejected alternatives

- **Native dylib / FFI.** No stable Rust ABI; breaks the "persists
  across versions absent breaking changes" requirement by
  construction.
- **WASM runtime, embedded scripting.** Considered for the process
  model; rejected in favor of out-of-process for crash isolation, true
  language independence, and direct reuse of the sidecar supervision
  code.
- **Server-side Extensions.** cannet-server doesn't own decoding or
  logging; running Extensions there would need a second supervision +
  RPC surface the server doesn't otherwise need.
- **Direct bus-client Extensions** (dialing the sidecar/server
  themselves for frames). Collides with the virtual-bus server's
  exclusive-subscribe semantics and doubles the connection-management
  surface for no benefit once host-side filtering exists.
- **Reusing `CannetServer.Session` as-is for Extensions.** Would force
  filtered-by-arb-id subscription and Event/Signal delivery into a
  message shape built for hardware interfaces, muddying what
  `CannetServer` means for a real server vs. the GUI acting as an
  extension host.
- **LSP-style negotiated capabilities.** Handles graceful degradation
  better than a single version number, but is real protocol machinery
  this project doesn't need yet — a hard version gate with a clear
  error is enough for "reject incompatible, don't crash."
- **Declarative host-rendered widget schema for views.** Keeps
  rendering and performance in cannet's hands, but contradicts the
  explicit goal of letting Extensions own arbitrary visual output, and
  limits every Extension to whatever widget vocabulary the host
  ships.

## Consequences

- `cannet.proto` grows: a new `ExtensionHost` service, `Event` and
  `Signal` message types, and an explicit Extension API version
  constant.
- **Terminology**: "extension" is the canonical term this ADR
  establishes; "plugin" is retired (the prior "plugin/utility"
  wording in ADR 0035 and the RBS task's non-goals was renamed when
  this ADR landed).
- The GUI host gains: an extensions directory scan at startup, a
  supervisor per Extension (reusing/generalizing the sidecar
  supervision code), a manifest reader/validator (version gate,
  transmit-consent gate), and webview-hosting + postMessage-relay
  plumbing for contributed views.
- A reference Python Extension and its packaging tooling
  (`uv`-managed, mirroring `cannet-python-can`) land in the repo,
  exercising the full surface end to end.
- No registry, no auto-update, no server-side Extensions, no in-process
  WASM/scripting runtime — all explicitly out of scope for this
  design, not just unaddressed.
