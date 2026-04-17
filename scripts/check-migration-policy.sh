#!/usr/bin/env bash
# Copyright 2026 Kisaes LLC
# Licensed under the PolyForm Internal Use License 1.0.0.
# You may not distribute this software. See LICENSE for terms.

# Migration policy guard (CLAUDE.md rule #13).
#
# Flags non-additive patterns in *new* migration files:
#   - DROP TABLE
#   - DROP COLUMN
#   - DROP CONSTRAINT (other than recreate-as-in-same-file)
#   - ALTER COLUMN ... DROP NOT NULL
#   - ALTER COLUMN ... SET NOT NULL   (can fail on existing NULL rows)
#   - RENAME TO / RENAME COLUMN
#
# These aren't always wrong — intentional schema redesigns (e.g. the
# Plaid cross-company migration) need them. When they do, the commit
# must acknowledge the exception by prefixing the migration filename
# with `allow-non-additive_` or adding the marker `-- migration-policy:
# non-additive-exception` on the first 10 lines. Otherwise the hook
# blocks the commit.
#
# Usage:
#   scripts/check-migration-policy.sh                  # check all migrations
#   scripts/check-migration-policy.sh path1.sql path2.sql   # check specific files
#   scripts/check-migration-policy.sh --staged         # check staged migrations
#
# Intended to run from lint-staged + CI.

set -euo pipefail

MIGRATIONS_DIR="${MIGRATIONS_DIR:-packages/api/src/db/migrations}"

if [[ "${1:-}" == "--staged" ]]; then
  shift
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR -- "${MIGRATIONS_DIR}/*.sql" 2>/dev/null || true)
elif [[ $# -gt 0 ]]; then
  files=("$@")
else
  mapfile -t files < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -print 2>/dev/null | sort)
fi

if [[ ${#files[@]} -eq 0 ]]; then
  exit 0
fi

violations=0

for file in "${files[@]}"; do
  [[ -f "$file" ]] || continue

  base="$(basename "$file")"

  # Allow explicit per-file exemption via filename prefix.
  if [[ "$base" == allow-non-additive_* ]]; then
    continue
  fi

  # Allow explicit in-file exemption marker in the first 10 lines.
  if head -n 10 "$file" | grep -q -- '-- migration-policy: non-additive-exception'; then
    continue
  fi

  # Case-insensitive, ignore comment lines (-- ...).
  content="$(grep -viE '^\s*--' "$file" || true)"

  match() {
    echo "$content" | grep -iE "$1" >/dev/null
  }

  report() {
    echo "ERROR: $base: $1" >&2
    violations=$((violations + 1))
  }

  match 'drop\s+table'                               && report "DROP TABLE"
  match 'alter\s+table[^;]*drop\s+column'            && report "DROP COLUMN"
  match 'alter\s+table[^;]*drop\s+constraint'        && report "DROP CONSTRAINT"
  match 'alter\s+column[^;]*drop\s+not\s+null'       && report "DROP NOT NULL"
  match 'alter\s+column[^;]*set\s+not\s+null'        && report "SET NOT NULL on existing column (may fail on NULL rows)"
  match 'alter\s+table[^;]*rename\s+to'              && report "RENAME TABLE"
  match 'alter\s+table[^;]*rename\s+column'          && report "RENAME COLUMN"
done

if [[ $violations -gt 0 ]]; then
  cat >&2 <<'MSG'

Migration policy violation (CLAUDE.md #13): migrations are additive only.

If the change is a deliberate redesign that needs to drop/modify existing
schema, opt-in with either:
  * rename the file to allow-non-additive_<original-name>.sql, OR
  * add `-- migration-policy: non-additive-exception` in the first 10
    lines and explain the motivation in the surrounding comment block.

MSG
  exit 1
fi

exit 0
