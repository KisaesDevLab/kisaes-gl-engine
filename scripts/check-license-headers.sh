#!/bin/bash
# scripts/check-license-headers.sh
# Fails if any source file is missing the ELv2 license header.

HEADER_PATTERN="Licensed under the Elastic License 2.0"
EXTENSIONS=("ts" "tsx")
EXCLUDE_DIRS=("node_modules" ".git" "dist" "build" ".next" "coverage" ".vite")
MISSING=0

EXCLUDE_ARGS=""
for dir in "${EXCLUDE_DIRS[@]}"; do
  EXCLUDE_ARGS="$EXCLUDE_ARGS -not -path '*/$dir/*'"
done

for ext in "${EXTENSIONS[@]}"; do
  while IFS= read -r file; do
    if ! head -5 "$file" | grep -q "$HEADER_PATTERN"; then
      echo "MISSING HEADER: $file"
      MISSING=$((MISSING + 1))
    fi
  done < <(eval "find client/src server/src -name '*.$ext' $EXCLUDE_ARGS -type f")
done

if [ $MISSING -gt 0 ]; then
  echo ""
  echo "ERROR: $MISSING file(s) missing ELv2 license header."
  echo "Run: bash scripts/add-license-header.sh"
  exit 1
fi

echo "All source files have license headers."
exit 0
