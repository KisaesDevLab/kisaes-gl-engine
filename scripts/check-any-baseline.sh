#!/usr/bin/env bash
# Copyright 2026 Kisaes LLC
# Licensed under the PolyForm Internal Use License 1.0.0.
# You may not distribute this software. See LICENSE for terms.
#
# Guard against growth of `any` types — CLAUDE.md rule #14 says "No
# any types" but the codebase has pre-existing debt. Fixing all 362
# occurrences at once is a multi-day refactor with no functional
# improvement, so we freeze the baseline here and fail if the count
# grows. Paying down the debt reduces the baseline; regressions
# would have to explicitly bump it (reviewer catches that in PR).
#
# Counts `: any` (return/param/var annotations) and `as any` (casts)
# in non-test source files across api, web, worker. Tests are exempt
# because they legitimately exercise DB rows returned with opaque
# shapes and fixtures where typing every intermediate has no value.

set -u

# Baselines reflect post-2026-04-28 cleanup: the regex now strips comment
# lines (//-line comments and *-block-comment continuations) so it doesn't
# false-positive on prose that happens to contain ": any X" or "as any X".
# Pre-cleanup api was 361 / web was 3, but ~6 of those were comment matches;
# real type-annotation count is below that. Don't bump these without
# auditing the diff first.
BASELINE_API=359
BASELINE_WEB=1
BASELINE_WORKER=0

# Filter pipeline:
#   1. grep matches `: any` or `as any` with word-boundary on the word.
#   2. drop lines that start with //  (single-line comments)
#   3. drop lines that start with *   (block-comment continuations)
# Surviving false positives (e.g. `as any` inside JSX text content)
# get acknowledged in the baseline above; ts-eslint with full AST
# awareness would be the next iteration if drift gets noisy.
_count_anys() {
    grep -rEh ": any\b|as any\b" "$@" 2>/dev/null \
        | grep -vE '^[[:space:]]*//' \
        | grep -vE '^[[:space:]]*\*' \
        | wc -l | tr -d ' '
}

api_count=$(_count_anys packages/api/src --include='*.ts' --exclude='*.test.ts')
web_count=$(_count_anys packages/web/src --include='*.ts' --include='*.tsx' --exclude='*.test.ts' --exclude='*.test.tsx')
worker_count=$(_count_anys packages/worker/src --include='*.ts')

fail=0

check() {
  name=$1
  actual=$2
  baseline=$3
  upper=$4
  if [ "$actual" -gt "$baseline" ]; then
    echo "FAIL $name: $actual > baseline $baseline (regression of $((actual - baseline)))"
    fail=1
  elif [ "$actual" -lt "$baseline" ]; then
    echo "OK   $name: $actual < baseline $baseline (debt paid; update BASELINE_${upper} in scripts/check-any-baseline.sh to $actual)"
  else
    echo "OK   $name: $actual (at baseline)"
  fi
}

check api    "$api_count"    "$BASELINE_API"    API
check web    "$web_count"    "$BASELINE_WEB"    WEB
check worker "$worker_count" "$BASELINE_WORKER" WORKER

if [ "$fail" -eq 1 ]; then
  echo ""
  echo "Do not add new \`any\` types to non-test code. Either:"
  echo "  1. Type it properly (drizzle row types, zod schemas, etc.)."
  echo "  2. If the type truly is opaque, use \`unknown\` and narrow."
  echo "  3. If you genuinely need \`any\` (rare), pair it with a comment"
  echo "     explaining why and pay down an equivalent existing occurrence"
  echo "     in the same PR so the baseline does not grow."
  exit 1
fi

exit 0
