#!/usr/bin/env bash
# Regenerate protobuf + grpc Python stubs for cannet-python-can.
#
# The stubs (cannet_python_can/_proto/*_pb2{,_grpc}.py) are checked
# into the tree so end users do not need a `protoc` install; this
# script is for contributors who edit the `.proto`. CI re-runs it and
# fails on a diff, so a proto edit that skips this step does not land.
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

# Both packages: `cannet.v1` (the protocol major) and the unversioned
# `cannet` that carries ServerInfo (ADR 0059).
python -m grpc_tools.protoc \
    --proto_path="$PROTO_DIR" \
    --python_out="$OUT_DIR" \
    --grpc_python_out="$OUT_DIR" \
    "$PROTO_DIR/cannet.proto" \
    "$PROTO_DIR/cannet_info.proto"

# grpc_tools writes `import <name>_pb2 as <alias>` at the top of each
# *_grpc.py file. With the stubs living under
# `cannet_python_can._proto/`, those bare imports would fail at
# runtime. Rewrite them to package-relative imports.
#
# `newline=""` on the write is load-bearing: protoc emits LF, which is
# what the committed stubs carry, and Python's default translation
# would rewrite every line of these files on a Windows regeneration —
# a whole-file diff against a CI check that looks for none.
for PY_GRPC in "$OUT_DIR"/*_pb2_grpc.py; do
    [[ -f "$PY_GRPC" ]] || continue
    python - "$PY_GRPC" <<'PYEND'
import pathlib
import re
import sys

p = pathlib.Path(sys.argv[1])
src = p.read_text(newline="")
src = re.sub(
    r"^import (\w+_pb2) as (\w+)$",
    r"from . import \1 as \2",
    src,
    flags=re.M,
)
p.write_text(src, newline="")
PYEND
done

echo "regenerated stubs under $OUT_DIR"
