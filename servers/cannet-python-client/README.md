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

The library reads the cannet GUI's **server trust store** — the record
of which servers this machine has accepted, and what to present to
them. It never writes it: accepting a server means comparing a
certificate fingerprint against the one the server printed, and only a
person can do that. Accept the server once in the GUI's Servers panel
and every client on the machine inherits the decision.

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
and may grow fields.

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
- anything else raises `ServerNotTrusted`. The GUI answers first
  contact with a dialog; a library has nobody to ask.

Pinning is by certificate: the library fetches the server's
certificate, checks its SHA-256 against the accepted fingerprint, and
hands that exact certificate to gRPC as the channel's sole trust root.

## Session semantics

The same rules `crates/cannet-client` keeps, so a server sees the same
client whichever language is talking to it:

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

## Running it

Always through `uv`, never `pip`:

```sh
uv run --project servers/cannet-python-client python examples/rest_bus_sim.py
```

## Tests

Hardware-free throughout. The unit tests need nothing; the integration
tests run against `cannet-server`'s debug modes on loopback and skip
when the binary is not built.

```sh
cargo build -p cannet-server           # for the integration tests
cd servers/cannet-python-client
uv run --extra dev pytest
uv run --extra dev ruff check .
uv run --extra dev ruff format --check .
uv run --extra dev mypy
```

## Relationship to the sidecar

`cannet-python-can` (the sibling directory) is a **server**: it exposes
local CAN hardware over the wire. This package is a **client**: it
opens a bus on a server. It depends on the sidecar for the checked-in
`_proto` gencode and the `can.Message` ↔ wire `Frame` mappers, so there
is exactly one encoding of the wire in the repository.
