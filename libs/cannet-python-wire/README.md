# cannet-python-wire

The cannet wire encoding, in Python. It is a library, not a program:
nothing here talks to hardware, opens a socket, or serves an RPC.

Two packages in this repository speak the wire —
[`servers/cannet-python-can`](../../servers/cannet-python-can/), the
sidecar that exposes local CAN hardware, and
[`clients/cannet-python-client`](../../clients/cannet-python-client/),
the python-can interface plugin that opens a bus on a server. What they
have to agree on lives here, so there is exactly one encoding of the
wire in the repository and nothing that can drift.

## What's in it

| Module | What it holds |
| --- | --- |
| `cannet_python_wire._proto` | The checked-in gRPC/protobuf gencode (`cannet_pb2`, `cannet_pb2_grpc`) |
| `cannet_python_wire.frame` | `Frame` and `FrameKind` — the in-process shape of a CAN frame |
| `cannet_python_wire.proto` | `frame_to_proto` / `proto_to_frame` |
| `cannet_python_wire.python_can` | `message_to_frame` / `frame_to_message` |

The four mappers and the two types are re-exported from the package
root, so consumers write `from cannet_python_wire import Frame,
frame_to_proto`.

## Regenerating the gencode

The stubs are committed so end users need no `protoc` install. After
editing [`crates/cannet-wire/proto/cannet.proto`](../../crates/cannet-wire/proto/cannet.proto),
from the repository root:

```sh
uv --directory libs/cannet-python-wire run --extra dev \
    bash scripts/regen_proto.sh
```

## Checks

```sh
cd libs/cannet-python-wire
uv run --extra dev pytest
uv run --extra dev ruff check .
uv run --extra dev ruff format --check .
uv run --extra dev mypy
```
