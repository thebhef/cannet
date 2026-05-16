#!/usr/bin/env bash
# Regenerate protobuf + grpc Python stubs for cannet-python-can.
#
# The stubs (cannet_python_can/_proto/cannet_pb2{,_grpc}.py) are
# checked into the tree so end users do not need a `protoc` install;
# this script is for contributors who edit the `.proto`.
#
# Usage (from the repo root):
#   uv --directory servers/cannet-python-can run --extra dev \
#       bash scripts/regen_proto.sh
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SIDECAR_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd -- "$SIDECAR_DIR/../.." && pwd)

PROTO_DIR="$REPO_ROOT/crates/cannet-wire/proto"
OUT_DIR="$SIDECAR_DIR/cannet_python_can/_proto"

mkdir -p "$OUT_DIR"
touch "$OUT_DIR/__init__.py"

python -m grpc_tools.protoc \
    --proto_path="$PROTO_DIR" \
    --python_out="$OUT_DIR" \
    --grpc_python_out="$OUT_DIR" \
    "$PROTO_DIR/cannet.proto"

# grpc_tools writes `import cannet_pb2 as cannet__pb2` at the top of
# the *_grpc.py file. With the stubs living under
# `cannet_python_can._proto/`, that bare import would fail at runtime.
# Rewrite it to a package-relative import.
PY_GRPC="$OUT_DIR/cannet_pb2_grpc.py"
if [[ -f "$PY_GRPC" ]]; then
    python - "$PY_GRPC" <<'PYEND'
import sys, re, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
src = re.sub(r"^import cannet_pb2 as cannet__pb2$",
             "from . import cannet_pb2 as cannet__pb2",
             src, flags=re.M)
p.write_text(src)
PYEND
fi

echo "regenerated stubs under $OUT_DIR"
