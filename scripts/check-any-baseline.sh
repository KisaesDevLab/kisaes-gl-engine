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

BASELINE_API=362
BASELINE_WEB=4
BASELINE_WORKER=0

api_count=$(grep -rEh ": any\b|as any\b" packages/api/src --include='*.ts' --exclude='*.test.ts' 2>/dev/null | wc -l | tr -d ' ')
web_count=$(grep -rEh ": any\b|as any\b" packages/web/src --include='*.ts' --include='*.tsx' --exclude='*.test.ts' --exclude='*.test.tsx' 2>/dev/null | wc -l | tr -d ' ')
worker_count=$(grep -rEh ": any\b|as any\b" packages/worker/src --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')

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
