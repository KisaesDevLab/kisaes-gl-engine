#!/bin/bash
# scripts/check-license-headers.sh [file1 file2 ...]
# Fails if any source file is missing the PolyForm Internal Use license header.
# Without arguments: scans every source file under packages/ (full audit mode).
# With arguments: scans only the supplied files (lint-staged / CI diff mode).

HEADER_PATTERN="Licensed under the PolyForm Internal Use License"
EXTENSIONS=("ts" "tsx" "js" "jsx" "mjs" "cjs" "sql" "sh" "py")
EXCLUDE_DIRS=("node_modules" ".git" "dist" "build" ".next" "coverage" ".vite")
MISSING=0

is_tracked_ext() {
  local f="$1"
  for ext in "${EXTENSIONS[@]}"; do
    [[ "$f" == *.$ext ]] && return 0
  done
  return 1
}

check_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  # Use bash builtins instead of `head -5 | grep` because, on
  # Windows MSYS, lint-staged passing 400+ staged files exhausts
  # the Cygwin fork pool (cygheap read copy failed / couldn't
  # create signal pipe). `read` is a builtin, no fork. Same
  # semantics: scan the first 5 lines for HEADER_PATTERN.
  local i=0 line
  while (( i < 5 )) && IFS= read -r line; do
    if [[ "$line" == *"$HEADER_PATTERN"* ]]; then
      return 0
    fi
    i=$((i + 1))
  done < "$file"
  echo "MISSING HEADER: $file"
  MISSING=$((MISSING + 1))
}

if [ $# -gt 0 ]; then
  # Argument mode: check only the files provided (filtered by extension).
  for file in "$@"; do
    is_tracked_ext "$file" || continue
    check_file "$file"
  done
else
  # Full-audit mode.
  EXCLUDE_ARGS=""
  for dir in "${EXCLUDE_DIRS[@]}"; do
    EXCLUDE_ARGS="$EXCLUDE_ARGS -not -path '*/$dir/*'"
  done
  for ext in "${EXTENSIONS[@]}"; do
    while IFS= read -r file; do
      check_file "$file"
    done < <(eval "find packages -name '*.$ext' $EXCLUDE_ARGS -type f")
  done
fi

if [ $MISSING -gt 0 ]; then
  echo ""
  echo "ERROR: $MISSING file(s) missing PolyForm license header."
  echo "Run: npm run license:headers:fix"
  exit 1
fi

echo "All source files have license headers."
exit 0
