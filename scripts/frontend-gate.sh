#!/usr/bin/env bash
#
# The frontend commit gate: the typecheck + bundle (`pnpm build`) and the
# vitest suite (`pnpm test`). They read the same tree and write different
# outputs, so they run concurrently — measured 42 s together against 67 s
# in sequence on this repo.
#
# Each job's output is buffered and printed only if that job failed, so a
# failure reads as one tool's output rather than two interleaved ones.
# Both always run: a type error should not hide a failing test.
set -uo pipefail

build_log=$(mktemp)
test_log=$(mktemp)
trap 'rm -f "$build_log" "$test_log"' EXIT

pnpm --dir apps/gui build >"$build_log" 2>&1 &
build_pid=$!
pnpm --dir apps/gui test >"$test_log" 2>&1 &
test_pid=$!

wait "$build_pid" && build_rc=0 || build_rc=$?
wait "$test_pid" && test_rc=0 || test_rc=$?

if [ "$build_rc" -ne 0 ]; then
    echo "--- pnpm --dir apps/gui build (exit $build_rc) ---"
    cat "$build_log"
fi
if [ "$test_rc" -ne 0 ]; then
    echo "--- pnpm --dir apps/gui test (exit $test_rc) ---"
    cat "$test_log"
fi

[ "$build_rc" -eq 0 ] && [ "$test_rc" -eq 0 ]
