#!/usr/bin/env bash
# Build the `vector_blf` test oracle used by the cannet-blf crate's
# `vector-blf-oracle` feature.
#
# Phase 9.5 Tranche 0 (per ADR 0009): cannet's own BLF implementation
# is cross-checked against Technica's `vector_blf` C++ library, used as
# a black-box test oracle. The library is cloned at a pinned upstream
# commit, cmake-built, and linked into a small C++ harness; both live
# under `target/vector-blf-oracle/` and never enter git. The harness
# does not link into cannet's runtime binary, so vector_blf's
# GPL-3.0-or-later licence stays outside cannet's runtime distribution.
#
# Idempotent: re-running skips work whose output is already present.
# Network access is required only on a fresh clone.
#
# Usage:
#   bash scripts/build-vector-blf-oracle.sh
#
# Pin: vector_blf master @ 3512fc2 ("Merge pull request #9 ... cstdint"),
# the smallest SHA past v2.4.2 that fixes the missing `<cstdint>`
# include that breaks the v2.4.2 build on GCC 13+.

set -euo pipefail

VECTOR_BLF_REPO="https://github.com/Technica-Engineering/vector_blf.git"
VECTOR_BLF_SHA="3512fc2ddca43248c95b773905d9c3ba46bc6570"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
oracle_dir="${repo_root}/target/vector-blf-oracle"
src_dir="${oracle_dir}/src"
build_dir="${oracle_dir}/build"
install_dir="${oracle_dir}/install"
bin_dir="${oracle_dir}/bin"
harness_src="${repo_root}/crates/cannet-blf/tests/oracle/harness.cpp"
harness_bin="${bin_dir}/vector-blf-oracle-harness"

log() { echo "[build-vector-blf-oracle] $*" >&2; }

# 1. Fetch vector_blf at the pinned SHA. The full history is cheap (~5 MB)
# and lets a developer pinpoint why a SHA was picked.
if [ ! -d "${src_dir}/.git" ]; then
    log "cloning ${VECTOR_BLF_REPO} into ${src_dir}"
    git clone "${VECTOR_BLF_REPO}" "${src_dir}"
fi

current_sha="$(git -C "${src_dir}" rev-parse HEAD)"
if [ "${current_sha}" != "${VECTOR_BLF_SHA}" ]; then
    log "checking out pinned SHA ${VECTOR_BLF_SHA}"
    git -C "${src_dir}" fetch --depth 1 origin "${VECTOR_BLF_SHA}" 2>/dev/null || git -C "${src_dir}" fetch origin
    git -C "${src_dir}" checkout -q "${VECTOR_BLF_SHA}"
fi

# 2. cmake configure + build + install (idempotent — cmake skips work
# if the install layout's freshness matches).
if [ ! -f "${install_dir}/lib/libVector_BLF.so" ] && [ ! -f "${install_dir}/lib/libVector_BLF.dylib" ]; then
    log "configuring vector_blf with cmake"
    mkdir -p "${build_dir}"
    cmake \
        -S "${src_dir}" \
        -B "${build_dir}" \
        -DOPTION_RUN_DOXYGEN=OFF \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="${install_dir}"
    log "building vector_blf"
    cmake --build "${build_dir}" -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
    log "installing vector_blf into ${install_dir}"
    cmake --install "${build_dir}"
else
    log "vector_blf already installed; skipping cmake build"
fi

# 3. Compile the harness. Re-link whenever the source is newer than the
# binary (or the binary is missing). The harness is one TU; no cmake
# layer needed.
mkdir -p "${bin_dir}"
if [ ! -x "${harness_bin}" ] || [ "${harness_src}" -nt "${harness_bin}" ]; then
    log "compiling harness ${harness_src}"
    "${CXX:-c++}" \
        -std=c++17 -O2 -Wall \
        -I"${install_dir}/include" \
        "${harness_src}" \
        -L"${install_dir}/lib" -lVector_BLF \
        -Wl,-rpath,"${install_dir}/lib" \
        -o "${harness_bin}"
else
    log "harness already up-to-date; skipping link"
fi

log "oracle ready: ${harness_bin}"
