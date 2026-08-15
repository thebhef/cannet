# Task 68 — Server Clock Awareness

Adopted onto the roadmap 2026-08-13 from the owner's triage note
(`TRIAGE-server-clock-awareness.md`, branch `server-clock-note` —
superseded by this file). Grooming pending; the triage analysis
follows verbatim.

## Grooming needed before implementation

- ~~Scope split~~ — resolved 2026-08-13 (owner): **correct and
  report**, correction default-on. Offset applied at the client
  seam (one-ingest-pathway intact, ADR 0046); the applied offset is
  recorded per session (one number — the raw as-sent stamps are
  rewritten at ingest, so the offset is the audit trail).
- ~~Where the offset surfaces / warning threshold~~ — resolved
  2026-08-13 (owner): the server's row in the connection/project
  surface shows the measured offset; one system-log line **at
  session start only** records what was measured and applied
  (warn level when |offset| > **100 ms**, info otherwise).
  **Never log per packet/frame.** No modal, no toast — a health
  indicator, not an error.
- ~~Probe cadence~~ — resolved 2026-08-13 (owner, revised same
  day): **live tracking**. Session-start probe (minimum-delay
  sample over a few exchanges) plus periodic re-probe (~30–60 s);
  the hosts may be running NTP/PTP and live-adjusting
  independently, so a frozen offset goes stale. The applied
  correction is **slewed, never stepped** (bounded rate toward the
  newest good measurement) so the corrected timeline never visibly
  jumps — except a genuinely large error (> ~1 s) steps honestly.
  Per-session record: offset at start + current.
- Logging under live tracking (owner-agreed): startup line once as
  ruled, plus one line per warn-state **transition** (crossed
  above / recovered below 100 ms). Bounded always; never
  per-frame.
- Clarified 2026-08-13: the offset is wall-clock-to-wall-clock
  (server host vs client host at probe time) — no boot/monotonic
  time in the stamping path. Rollover checked: `uint64` epoch-ns
  rolls over ~year 2554; the only care point is doing the probe
  arithmetic in signed wide types (i128/i64), never naive unsigned
  subtraction. Vendor-counter rollover is unwrapped upstream by
  python-can and garbage is caught by the existing plausibility
  gate.
- Clarified 2026-08-13 (owner asked reinvent-vs-reuse): we adopt
  the standard SNTP **algorithm** (RFC 4330's four-timestamp
  offset/delay math + min-delay sampling) over our own
  authenticated `Session` stream; the NTP **wire protocol** (UDP
  123, stratum, discipline/slewing) and PTP are rejected as
  transport — a second port/protocol/firewall surface, and the
  existing NTP crates (`sntpc`, `rsntp`) speak that UDP protocol,
  so there is no library seam for an in-stream exchange. If hosts
  do run NTP/PTP, the measured offset ≈ 0 and correction no-ops.
  The implementation phase records this as a
  `technology-inventory.md` protocol entry.
- The two stale proto comments ride along in whatever change
  touches the wire.

## Exit criteria (groomed 2026-08-13; phases at task start)

- `ClockProbe`/`ClockReply` in the `Session` envelope `oneof`;
  older peers ignore them (additive, no breaking change).
- At session start the client measures the offset (minimum-delay
  sample over a few exchanges, signed wide arithmetic) and applies
  it at the client seam for the session's lifetime; the applied
  offset is recorded per session; ADR 0046's one-ingest-pathway
  rule intact.
- The server row in the connection/project surface shows the
  measured offset; exactly one system-log line at session start
  (warn above 100 ms, info otherwise); nothing logged per frame.
- A skewed-clock test (simulated offset) proves frames land
  correctly placed after correction and the warning fires above
  threshold.
- The two stale proto comments (`Frame.timestamp_ns` "monotonic",
  `LogMessage.timestamp_ns` "receiver maps") are fixed.

## Triage analysis (owner, 2026-08-13)

A cannet server stamps every frame it produces, but knows nothing about
the clock it stamps with. It cannot report its clock, cannot detect that
the clock is wrong, and cannot be asked. This is fine on a single
machine and silently incorrect across machines.

## The current contract

**Every frame that enters the model carries Unix-epoch nanoseconds.**
Not monotonic — wall clock, unmapped, from whichever producer made it.
Producers:

| Site | Stamps |
|---|---|
| `driver_python_can.py:653-657` (`_msg_to_frame`) | Hardware RX frames |
| `server/helpers.py:55-61` (`_now_ns`) | Sidecar self-stamped envelopes (TX fallback, logs) |
| `crates/cannet-core/src/shared_bus.rs:669` (`wall_clock_ns`) | Virtual-bus fan-out |
| `apps/gui/src-tauri/src/transmit_commands.rs:629` | GUI-side TX confirms |
| `apps/gui/src-tauri/src/capture.rs:569-572` | Session-start anchor (`clear_trace_store`) |

The invariant is stated at `shared_bus.rs:660-668` and enforced by
`servers/cannet-python-can/tests/test_wire_timestamp_clock.py` and
`shared_bus.rs:849`. A `time.monotonic_ns()` stamp is the bug those
tests exist to catch.

The only validation is a plausibility gate in `_msg_to_frame`: a
hardware timestamp further than `_TS_PLAUSIBLE_SLACK_S` (86 400 s) from
`time.time()` is treated as driver garbage and replaced with the
wall-clock fallback. That window exists to reject PEAK/PCBUSB stamps
millennia in the future that would overflow the wire's `uint64` ns
field — it is not a sync check, and is three orders of magnitude too
loose to catch a genuinely misconfigured host clock.

## What is missing

1. **The server holds no clock state.** Both wall-clock reads are
   transient — the value goes into a frame and is forgotten. There is no
   reference epoch, no offset, no sync status.

2. **The server's monotonic clock is internal only.** `shared_interface.py`
   uses `time.monotonic_ns()` at :257, :268, :422, :446, :520, :524 for
   send pacing, the RX-stats interval and the batch-flush deadline.
   Correctly separated from the stamping clock, and never exported.

3. **The wire cannot express it.** `service CannetServer` has three RPCs
   (`ListInterfaces`, `WatchInterfaces`, `Session`). `Interface` carries
   `{id, display_name, fd_capable}`. There is no `ServerInfo`, no `Ping`,
   no handshake — nothing that lets a client ask the server what time it
   thinks it is.

4. **The one incidental clock sample is discarded.**
   `LogMessage.timestamp_ns` is a server wall-clock reading that does
   reach the client. `crates/cannet-client/src/lib.rs:793` drops it along
   with the other envelopes that "have no consumer in this crate". The
   GUI bridges logs into the system-log surface as display text, not as a
   clock sample.

## Consequence

The design assumes all producers already share one correct wall clock and
relies on each being independently right. On one machine that holds.

Across machines — several Pis or sidecar hosts feeding one GUI, which the
client/server split otherwise supports — accuracy degrades to whatever
NTP/PTP is doing on those hosts, **with no signal either way**. A host
four seconds off produces frames four seconds out of place in the trace,
past the plausibility gate without complaint, and indistinguishable on the
wire from a healthy one. There is no offset to inspect and no error bound
to surface.

`CanFrame`'s own rustdoc (`crates/cannet-core/src/frame.rs:140-142`)
already concedes the limit — "comparison is only meaningful within one
source" — so this is a known scope boundary, not an oversight. What is
missing is any way to *observe* when it has been crossed.

## Suggested direction

`rpc Session(stream Envelope) returns (stream Envelope)` is already
bidirectional, and ADR 0022 already has clients initiating envelopes on
it. A `ClockProbe` / `ClockReply` pair added to `oneof body` is additive
— no new RPC, no breaking change, unknown variants ignored by default:

- client sends `ClockProbe { t1 }`
- server replies `ClockReply { t1, t2, t3 }` (receive and send stamps)
- client stamps `t4`, computes standard NTP offset/delay

Then:

- Apply the offset at the client seam — in `cannet-wire/src/convert.rs`
  or `cannet-client` — **not** in `run_pump`. A source that arrives
  pre-corrected is still just a source, so ADR 0046's one-ingest-pathway
  rule stays intact.
- With PTP deployed on the hosts the offset collapses to ~0, but the code
  path is still needed because PTP cannot be assumed.
- The offset being a named quantity is the real win: the sidecar can log
  it and the GUI can surface "this server's clock is 4.2 s off" rather
  than silently misplacing frames.

## Also: two stale proto comments

`crates/cannet-wire/proto/cannet.proto` contradicts the enforced
behaviour and should be fixed in whatever change touches this area:

- `:116-117` — "Sender's **monotonic** timestamp in nanoseconds" on
  `Frame.timestamp_ns`. It is Unix-epoch wall clock; a monotonic stamp is
  the bug `test_wire_timestamp_clock.py` guards against.
- `:157-159` — "The receiver maps this to its own clock for display" on
  `LogMessage.timestamp_ns`. No such mapping exists anywhere; the client
  drops the envelope.

## Status log

### Phase 1 — the wire pair and the client-side offset math (2026-08-14)

Branch `task68a-clock-wire` off `task63f-follow-window-fix` (25418ff).
Scope as groomed: the `ClockProbe` / `ClockReply` envelopes, whoever
answers them, and the client-side measurement. Application, slewing,
live re-probing and the GUI surface are later phases — this phase
**measures and exposes only**; frames are delivered uncorrected.

**Who answers — decided: the process that stamps the frames.** The
sidecar answers; the proxy relays. Both in-tree Rust servers (BLF
replay, virtual bus) answer for their own sessions.

The two candidates were clock-equivalent *today* — a supervised sidecar
and the proxy in front of it share a host — but only one is
principle-shaped:

1. The clock worth measuring is the one that produces the timestamps.
   For hardware that is `driver_python_can._msg_to_frame`'s
   `time.time_ns()`, inside the sidecar. Answering at the proxy would
   report a neighbouring process's clock, correct only for as long as
   the deployment keeps them co-hosted.
2. Proxy interception would cover only the proxy path. The GUI's own
   supervised sidecar is reached directly on loopback — the most common
   session in the product — and would have been left unanswered, as
   would the BLF replay and virtual-bus servers, each paying the probe
   deadline and reporting `Unsupported` at every connect.
3. ADR 0040's pure-relay principle needed no documented exception. The
   extra hop's latency lands in δ, which is exactly what minimum-delay
   sampling discards.
4. Both Rust servers' `match body` are exhaustive, so the new variant
   forced an arm at each; answering cost ~6 lines versus ~4 to ignore.

**Local-session behaviour.** A probe against a local vbus / BLF replay
server measures ≈0 (they answer). The GUI's in-process local-bus
bindings never open a `Session` at all — `LocalBusRegistry::attach_
participant` hands out `LocalSink`/`LocalSource` directly — so no probe
exists on that path. Local-bus *bridges* do open a client session and
are answered by whatever is at the far end. Nothing can hang: the probe
window is bounded and never gates readiness.

**Commits**

| commit | what |
|---|---|
| `6205d27` | orchestrator's task-63 close-out doc edits, landed verbatim |
| `941b99f` | proto pair + both Rust servers answer + the two stale proto comments + inventory entry |
| `a63c155` | sidecar answers; regenerated python stubs; sidecar README |
| `bb2d69c` | client probe machinery (`cannet-client::clock`) |

**Tests** (all green; clippy `-D warnings` clean on every touched
crate)

| layer | new | suite total |
|---|---|---|
| `cannet-wire` | 2 (probe/reply round trip, unknown variant decodes as no body) | 21 |
| `cannet-server` | 4 (vbus ×2, BLF replay, proxy relay) | 37 unit + 36 integration |
| `cannet-client` | 12 unit (`clock`) + 2 end-to-end | 25 unit + 18 integration |
| sidecar (pytest) | 4 | 110 |

**Design notes carried forward**

- Envelope tags 12 / 13. Tag 9 was never used in the `oneof` (checked
  through the file's history) but was skipped deliberately enough that
  reusing it buys nothing.
- The probe is 4 exchanges at 20 ms spacing with a 2 s window, running
  on the session's existing `select!` loop. It gates nothing: readiness
  is signalled at the speed of the subscribes, so a slow or silent peer
  costs a status, not a stall.
- `ClockProbeStatus` is `Pending` / `Measured(ClockOffset)` /
  `Unsupported`. `Unsupported` is the honest answer for a peer built
  before the variants existed — it parses the probe, recognises no
  body, and never replies.
- δ is clamped at zero. RFC 4330 notes the computation can come out
  negative when the two clocks tick at different rates across an
  exchange; left signed, such a sample would win minimum-delay
  selection every time, promoting the worst sample to the chosen one.
- The measurement is exposed at `FrameReceiver::clock()` (and
  `RemoteCanFrameSource::clock()`), a cheap-to-clone `SessionClock`.
  `into_parts` keeps its arity; the clock rides with the receive half,
  which is where the correction will be applied.

**Open for the next phase**

- Applying the offset at the client seam, slewed not stepped, with the
  >1 s step exception.
- Periodic re-probe (~30–60 s) and the warn-state transition logging.
- The GUI surface: the server row's measured offset and the single
  session-start system-log line (warn above 100 ms).
