#!/usr/bin/env bash
# Fetch the `uv` binary for the current OS / arch into `tools/uv/`.
#
# Phase 8 bundles `uv` (Astral's Python project / package manager,
# https://docs.astral.sh/uv/) alongside the GUI so end users do not
# need a pre-installed Python on their machine — `uv` materialises
# the cannet-python-can sidecar's venv on first launch and runs it.
#
# The GUI looks for `tools/uv/uv[.exe]` next to its executable
# (see `apps/gui/src-tauri/src/sidecar.rs::bundled_uv_path`). This
# script is the build-time fetcher; the Phase-16 packaging tail
# bakes the resulting binary into the Tauri bundle.
#
# Usage:
#   bash scripts/fetch-uv.sh                # detect OS + arch
#   UV_VERSION=0.4.20 bash scripts/fetch-uv.sh
#   UV_DEST=apps/gui/src-tauri/target/release/tools/uv bash scripts/fetch-uv.sh
#
# Network access is required. The script is idempotent — it skips
# the download when the target binary already exists.

set -euo pipefail

UV_VERSION="${UV_VERSION:-0.4.20}"

case "$(uname -s)" in
    Linux)  os=linux  ;;
    Darwin) os=macos  ;;
    MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
    x86_64|amd64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

case "$os" in
    linux)
        triple="${arch}-unknown-linux-gnu"
        archive="uv-${triple}.tar.gz"
        binary="uv"
        ;;
    macos)
        triple="${arch}-apple-darwin"
        archive="uv-${triple}.tar.gz"
        binary="uv"
        ;;
    windows)
        triple="${arch}-pc-windows-msvc"
        archive="uv-${triple}.zip"
        binary="uv.exe"
        ;;
esac

UV_DEST="${UV_DEST:-tools/uv}"
mkdir -p "$UV_DEST"

if [[ -x "$UV_DEST/$binary" ]]; then
    echo "uv already present at $UV_DEST/$binary; skipping download"
    exit 0
fi

url="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${archive}"
echo "fetching $url"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if command -v curl >/dev/null 2>&1; then
    curl -fSL "$url" -o "$tmp/$archive"
elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp/$archive" "$url"
else
    echo "neither curl nor wget available" >&2
    exit 1
fi

if [[ "$archive" == *.zip ]]; then
    if ! command -v unzip >/dev/null 2>&1; then
        echo "unzip required for Windows archive" >&2; exit 1
    fi
    unzip -q "$tmp/$archive" -d "$tmp"
else
    tar -xzf "$tmp/$archive" -C "$tmp"
fi

# Releases unpack into uv-<triple>/uv (or .exe on Windows).
src="$tmp/uv-${triple}/$binary"
if [[ ! -f "$src" ]]; then
    # Some releases drop the binary at the top level instead.
    src="$tmp/$binary"
fi
if [[ ! -f "$src" ]]; then
    echo "could not locate uv binary inside $archive" >&2
    exit 1
fi
install -m 0755 "$src" "$UV_DEST/$binary"
echo "installed $UV_DEST/$binary"
