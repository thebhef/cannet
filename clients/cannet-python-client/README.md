# cannet-python-client

A [python-can](https://python-can.readthedocs.io/) interface plugin
that opens a CAN bus on a cannet server.

It registers under python-can's `can.interface` entry-point group as
`cannet`, so an application that already speaks python-can gains a
remote bus by naming one — no cannet-specific import, and no
credential pasted into application code:

```python
import can

with can.Bus(
    interface="cannet", server="bench", channel="pcan:PCAN_USBBUS1", bitrate=500_000
) as bus:
    for message in bus:
        print(message)
```

`server` names a server the machine already trusts; `channel` is the
interface id that server publishes. Everything `BusABC` promises works:
`recv`, iteration, `Listener`/`Notifier`, `send`, `shutdown`, `state`,
`channel_info`.

## Naming a server

The library reads the machine's **server trust store** — the record of
which servers this machine has accepted, and what to present to them.
The library itself never writes it: accepting a server means comparing
a certificate fingerprint against the one the server printed, and only
a person can do that. Accept a server once — in the cannet GUI's
Servers panel, or with the `cannet-client` command below — and every
client on the machine inherits the decision.

### Where the file is

`servers.json`, in the GUI's per-user config directory — the
platform-standard config directory plus the application identifier
`dev.cannet.app`:

| OS      | Path                                                       |
| ------- | ---------------------------------------------------------- |
| Windows | `%APPDATA%\dev.cannet.app\servers.json`                    |
| macOS   | `~/Library/Application Support/dev.cannet.app/servers.json` |
| Linux   | `$XDG_CONFIG_HOME/dev.cannet.app/servers.json` (`~/.config` when unset) |

`cannet_python_client.servers_file()` returns it on the running
machine.

### What it holds

One object with a single `servers` key, mapping a normalised
`host:port` to what the machine holds for that server. Every field of
an entry is optional:

```json
{
  "servers": {
    "bench.local:50051": {
      "fingerprint": "SHA256:4EMRWrqj5MtP7Lxx4DjdNGUhBPIUijAl4UZekXCJwAc",
      "token": "KMGqFEndqRji-y-f4Ej48LJZBu7Bjg2IfmRVMv-jHZE"
    },
    "old-rig:50051": { "insecure": true },
    "127.0.0.1:50052": { "manual": true }
  }
}
```

| Field         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `fingerprint` | The accepted certificate, in the `SHA256:` + unpadded-base64 form the server prints. |
| `token`       | The bearer token to present on every RPC. **Stored in the clear** — never log it. |
| `insecure`    | The operator explicitly chose to reach this routable address unprotected. |
| `manual`      | The address was typed into the Servers panel by hand; no connection decision. |

The key is the address with any `scheme://` removed and lower-cased. A
server that moves is a different entry: a pin vouches for an identity
*at an address*. Unknown keys are ignored — the GUI owns this document
and may grow fields, and a `cannet-client` write keeps every key it
finds, on the entry it is editing and on every other.

### How a name becomes a connection

`server=` takes a `host:port`, or a bare name when the store holds
exactly one entry for it. The plan is the GUI's own (ADR 0041):

- a **loopback** address is plaintext whatever is stored, and a bare
  loopback name takes the wire's default port 50051;
- a **pinned** server is always dialled pinned, with its token as an
  `authorization: Bearer` credential on every RPC — there is no
  configuration in which a pin degrades to plaintext;
- only a server with nothing pinned may use a stored `insecure`
  choice, and a plaintext target carries no token, because a
  credential never rides an unencrypted channel;
- anything else raises `ServerNotTrusted`. First contact is answered by
  a person — the GUI's dialog, or `cannet-client connect` below; a
  library has nobody to ask.

Pinning is by certificate: the library fetches the server's
certificate, checks its SHA-256 against the accepted fingerprint, and
hands that exact certificate to gRPC as the channel's sole trust root.

## Session semantics

The same rules `crates/cannet-client` keeps, so a server sees the same
client whichever language is talking to it:

- **`ServerInfo` is asked first, on every connection.** The wire's
  compatibility rule is the protobuf package major
  ([ADR 0059](../../docs/adr/0059-wire-protocol-package-major.md)), so
  before the session stream is opened — and before any credential goes
  out — the client asks which packages the server serves and refuses,
  terminally, when `cannet_python_wire.PROTOCOL_PACKAGE` is not among
  them. `IncompatibleProtocol` carries the sentence every cannet client
  shows, naming both sides:

  ```
  serves cannet.v2; this client speaks cannet.v1
  ```

  A server that does not implement `ServerInfo` at all is refused the
  same way: it predates the rule, so nothing it answers can be read as
  an agreement about the wire. `can.Bus(...)` surfaces both as a
  `can.CanInitializationError`; `cannet_python_client.server_info()`
  asks the question directly.
- **`ConfigureBus` precedes the `Subscribe` it configures**, so a
  controller opens at the requested rate the first time round. Pass
  `bitrate=` / `fd=` / `data_bitrate=` to send one.
- **A bare `virtual:` id is a factory** (ADR 0021): subscribing
  allocates a fresh participant, and the bus waits for the server to
  name it. `bus.allocated_id` is that name, and it is what transmits
  are addressed to.
- **Per-frame errors do not end the session.** `TX_REJECTED`,
  `NOT_SUBSCRIBED` and `NO_ACKNOWLEDGER` each describe one transmit;
  they are tallied on `bus.rejections` and the stream goes on. Every
  other code ends the session and is raised as a
  `can.CanOperationError` from the next read.
- **An ordinary subscribe is not acknowledged by the wire**, so it is
  ready as soon as it is sent and a fatal error surfaces on the first
  read rather than stalling the constructor. A *factory* subscribe is
  acknowledged, so its errors do come out of the constructor.

`bus.state` answers with one of python-can's three `BusState` members;
a peer that has reported no controller state reads as `ACTIVE`, since
the enum has no "unknown". `bus.controller_state` is where that
difference survives — it is `None` until the peer says something.

## Clock correction

Every frame's `timestamp` is stamped on the *server's* clock. A session
measures how far that clock is from this machine's with the same SNTP
probe (RFC 4330 § 5) `crates/cannet-client` runs — a burst of exchanges
over the `Session` stream at start-up and every 30 s after, the
least-delayed of which sets the correction — and slews delivered
timestamps towards it at a bounded rate, so a trace never sees the
correction jump. A peer that never answers a probe (built before the
envelopes existed) degrades to raw, uncorrected timestamps rather than
holding the session up. `cannet_python_client.clock` is the algorithm;
`Session.clock` is the per-session reading of it, for anything that
wants to show the offset rather than just have it applied.

## Detecting servers

`can.detect_available_configs(interfaces="cannet")` dials every server
the trust store names, with a short timeout, and returns one config per
interface it offers:

```python
import can

# [{"interface": "cannet", "channel": "blf:0", "server": "bench:50051"}, ...]
can.detect_available_configs(interfaces="cannet")
```

A server that is off, unreachable, or refuses the handshake — including
one nothing is trusted for yet — contributes nothing rather than
failing the scan; `can.Bus(**config)` opens the bus it named.

## `cannet-client` — accepting a server without the GUI

The package ships a console script that does what the GUI's Servers
panel does, for a machine that has no GUI on it. It writes the same
`servers.json`, so a server accepted here is a server every client on
the machine can open a bus on.

```sh
cannet-client list                 # what is out there, and what is accepted
cannet-client connect bench        # reach one, accepting it if it is new
cannet-client forget bench:50051   # drop its pin, token and choices
```

**`list`** browses `_cannet._tcp` for a few seconds (`--timeout`) and
lays the result over the trust store, one row per server:

```text
NAME     ADDRESS             TRUST        PROTOCOL                     PRESENCE
bench    192.168.1.10:50051  trusted      cannet.v1                    advertising
-        old-rig:50051       unprotected  -                            not answering
rig-2    192.168.1.11:50051  new          cannet.v2 (not spoken here)  advertising
```

A server that has been accepted is a row whether or not it is
answering — forgetting one must not require waiting for it to come
back. The browse only ever *listens*: this package never advertises a
service of its own.

**PROTOCOL** is what the server says it speaks, from its `proto=` TXT
key ([ADR 0059](../../docs/adr/0059-wire-protocol-package-major.md)):
the wire's version is its protobuf package, and a server serving a
major this client does not is called out here because it otherwise
looks reachable and refuses every connect. `-` means the server
advertised nothing — an older build, one started `--no-mdns`, an
address added by hand — which is "did not say", not "serves nothing":
those are dialled normally and the `ServerInfo` call every connection
makes decides.

**`connect`** takes a `host:port`, or a name — of a server already
accepted, or one currently advertising. It runs the same four paths the
GUI runs (ADR 0041):

| What is stored | What happens |
| -------------- | ------------ |
| loopback address | plaintext, no questions |
| a pinned fingerprint | TLS verified against it, the stored token on every RPC |
| nothing | the observed `SHA256:…` is printed for you to compare against the server's startup banner; accepting it asks for the banner's token, and stores both |
| an endpoint not speaking TLS | it asks, in as many words, whether to connect without protection — never a silent fallback |

A certificate that is not the pinned one is refused outright: no retry,
no fallback, and nothing stored. Whatever it stores, it then proves
with one authenticated `ListInterfaces` and prints the `can.Bus(...)`
call that opens a bus on what it found.

**`forget`** removes the entry — pin, token and any unprotected choice
together — so the next `connect` starts over at trust on first use.

The same three things are importable, and are where the decisions
actually live (ADR 0003): `cannet_python_client.servers` for the merge
and for what a name means, `cannet_python_client.connect` for the
connection flow, and `cannet_python_client.trust` for the store. The
command line parses arguments, asks the questions and prints the
answers; it decides nothing.

## Running it

Always through `uv`, never `pip`:

```sh
uv run --project clients/cannet-python-client python examples/rest_bus_sim.py
uv run --project clients/cannet-python-client cannet-client list
```

## Tests

Hardware-free throughout, and off the network by default: the browse
and the certificate probe are injected, so nothing in the suite sends a
multicast query or dials a routable address. The unit tests need
nothing else; the integration tests run against `cannet-server`'s debug
modes on loopback and skip when the binary is not built.

```sh
cargo build -p cannet-server           # for the integration tests
cd clients/cannet-python-client
uv run --extra dev pytest
uv run --extra dev ruff check .
uv run --extra dev ruff format --check .
uv run --extra dev mypy
```

## Relationship to the sidecar

`cannet-python-can` (under `servers/`) is a **server**: it exposes
local CAN hardware over the wire. This package is a **client**: it
opens a bus on a server. Nothing here depends on it. What the two do
share is [`cannet-python-wire`](../../libs/cannet-python-wire/) — the
checked-in `_proto` gencode and the `can.Message` ↔ wire `Frame`
mappers — so there is exactly one encoding of the wire in the
repository.
