#!/usr/bin/env bash
#
# Run `cargo test` for the workspace crates a commit actually touches.
#
# pre-commit hands us the staged filenames (relative to the repo root,
# which is also our working directory) already filtered to Rust sources
# and manifests. We map each one to the crate that owns it:
#
#   crates/<name>/...            -> package <name>
#   apps/gui/src-tauri/...       -> package cannet-gui
#   Cargo.toml / Cargo.lock /
#   rust-toolchain.toml (root)   -> the whole workspace
#
# Anything else that reached us is a Rust path we don't have a rule for,
# so we run the workspace rather than guess and under-test.
#
# Dependents are deliberately not pulled in; see the comment in
# .pre-commit-config.yaml for the measurements behind that and for what
# the scoped run can miss.
set -euo pipefail

pkgs=""

add() {
    case " $pkgs " in
        *" $1 "*) ;;
        *) pkgs="$pkgs $1" ;;
    esac
}

for f in "$@"; do
    case "$f" in
        Cargo.toml | Cargo.lock | rust-toolchain.toml)
            exec cargo test --workspace
            ;;
        apps/gui/src-tauri/*)
            add cannet-gui
            ;;
        crates/*/*)
            dir=${f#crates/}
            dir=${dir%%/*}
            # The directory name is the package name for every member
            # under crates/; if that ever stops holding, fall back rather
            # than pass cargo a package it doesn't know.
            if [ -f "crates/$dir/Cargo.toml" ]; then
                add "$dir"
            else
                exec cargo test --workspace
            fi
            ;;
        *)
            exec cargo test --workspace
            ;;
    esac
done

# No filenames (pre-commit always passes at least one, but a hook run by
# hand may not) means nothing to test.
[ -n "$pkgs" ] || exit 0

args=""
for p in $pkgs; do
    args="$args -p $p"
done

# shellcheck disable=SC2086 # $args is a deliberately split -p list
exec cargo test $args
