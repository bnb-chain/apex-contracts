#!/bin/sh
# One `bun test` process per file, fail-fast.
#
# A single `bun test test/unit/` run silently drops tests: bun's collector
# does not reliably pick up tests whose registration completes after the
# first file's module evaluation (these files top-level-await
# `network.connect()` before `describe`), so a multi-file run reports only
# ONE file's tests as the whole suite (e.g. "25 tests across 5 files" when
# the files hold 109). Per-file processes sidestep the collector bug; each
# file has always run correctly in isolation.
set -e
for f in test/unit/*.test.ts; do
  bun test "$f"
done
echo "all unit test files passed"
