#!/bin/bash
# scripts/add-license-header.sh
# Adds the ELv2 license header to source files that are missing it.

HEADER_PATTERN="Licensed under the Elastic License 2.0"
HEADER='// Copyright 2025-2026 Kisaes LLC
// Licensed under the Elastic License 2.0 (ELv2); you may not use this file
// except in compliance with the Elastic License 2.0.
// See LICENSE file in the project root for full license text.
'
EXTENSIONS=("ts" "tsx")
EXCLUDE_DIRS=("node_modules" ".git" "dist" "build" ".next" "coverage" ".vite")
ADDED=0

EXCLUDE_ARGS=""
for dir in "${EXCLUDE_DIRS[@]}"; do
  EXCLUDE_ARGS="$EXCLUDE_ARGS -not -path '*/$dir/*'"
done

for ext in "${EXTENSIONS[@]}"; do
  while IFS= read -r file; do
    if ! head -5 "$file" | grep -q "$HEADER_PATTERN"; then
      { echo "$HEADER"; cat "$file"; } > "$file.tmp" && mv "$file.tmp" "$file"
      echo "Added header: $file"
      ADDED=$((ADDED + 1))
    fi
  done < <(eval "find client/src server/src -name '*.$ext' $EXCLUDE_ARGS -type f")
done

if [ $ADDED -eq 0 ]; then
  echo "All source files already have license headers."
else
  echo ""
  echo "Added headers to $ADDED file(s)."
fi
