#!/usr/bin/env bash
# Regenerate every checked-in python gencode tree from the protos in
# crates/cannet-wire/proto.
#
# The python packages keep their stubs in the tree so an end user needs
# no `protoc`; that only works if the stubs and the `.proto` cannot
# drift apart. CI runs this and then `git diff --exit-code`, so a proto
# edit that skipped the regeneration fails the build (ADR 0059).
#
# Each package owns its own `scripts/regen_proto.sh` — the output
# directory, the import rewriting and the `uv` project are that
# package's business. This driver just runs all of them, and finds them
# by glob so a package added later is covered without editing CI.
#
# Usage (from anywhere):
#   bash scripts/regen-proto-gencode.sh
set -euo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT"

found=0
for script in servers/*/scripts/regen_proto.sh libs/*/scripts/regen_proto.sh; do
    [[ -f "$script" ]] || continue
    found=1
    package_dir=$(dirname -- "$(dirname -- "$script")")
    echo "== regenerating $package_dir"
    uv --directory "$package_dir" run --extra dev bash scripts/regen_proto.sh
done

if [[ $found -eq 0 ]]; then
    echo "no scripts/regen_proto.sh found under servers/ or libs/" >&2
    exit 1
fi
