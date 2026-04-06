#!/usr/bin/env bash
# =============================================================================
# license-audit.sh — Automated license compliance audit for vibe-tb
# License: Elastic-2.0
#
# Usage:  ./scripts/license-audit.sh [--quiet] [--json]
#   --quiet   Suppress passing checks; show only warnings and failures
#   --json    Write machine-readable results to scripts/license-audit-result.json
#
# Requires: node, npm, npx
# On first run installs license-checker via npx (cached automatically).
# =============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY="$ROOT/scripts/license-policy.json"
REPORT="$ROOT/scripts/license-audit-result.txt"
QUIET=false
EMIT_JSON=false

for arg in "$@"; do
  case $arg in
    --quiet) QUIET=true ;;
    --json)  EMIT_JSON=true ;;
  esac
done

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[0;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

pass()  { $QUIET || echo -e "${GREEN}  ✔ $*${RESET}"; }
warn()  { echo -e "${YELLOW}  ⚠  $*${RESET}"; }
fail()  { echo -e "${RED}  ✘ $*${RESET}"; }
info()  { echo -e "${CYAN}  ▶ $*${RESET}"; }
header(){ echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}"; }

FAILURES=0
WARNINGS=0

bump_fail() { FAILURES=$((FAILURES+1)); }
bump_warn() { WARNINGS=$((WARNINGS+1)); }

# ── 1. Required project files ─────────────────────────────────────────────────
header "1. Required project files"

if [[ -f "$ROOT/LICENSE" ]]; then
  pass "LICENSE file present"
else
  fail "LICENSE file MISSING — required for ELv2 distribution"
  bump_fail
fi

if [[ -f "$ROOT/README.md" ]] || [[ -f "$ROOT/README" ]]; then
  pass "README present"
else
  warn "No README found"
  bump_warn
fi

# ── 2. ELv2 source file headers ─────────────────────────────────────────────
header "2. Source file headers"

HEADER_PATTERN="Licensed under the Elastic License 2.0|Elastic-2.0|ELv2|Copyright.*Kisaes"
TS_FILES=$(find "$ROOT/client/src" "$ROOT/server/src" -name "*.ts" -o -name "*.tsx" 2>/dev/null | wc -l | tr -d ' ')
HEADERS_FOUND=$(find "$ROOT/client/src" "$ROOT/server/src" -name "*.ts" -o -name "*.tsx" 2>/dev/null \
  | xargs grep -l -E "$HEADER_PATTERN" 2>/dev/null | wc -l | tr -d ' ')

info "$HEADERS_FOUND / $TS_FILES source files have license headers"

if [[ "$HEADERS_FOUND" -eq 0 ]]; then
  warn "No source files contain license headers"
  warn "Minimum header:  // Licensed under the Elastic License 2.0 (ELv2)"
  bump_warn
elif [[ "$HEADERS_FOUND" -lt "$TS_FILES" ]]; then
  warn "$(( TS_FILES - HEADERS_FOUND )) source files missing license headers"
  bump_warn
else
  pass "All source files have license headers"
fi

# ── 3. Source code visibility ────────────────────────────────────────────────
header "3. Source code visibility"

S13_PATTERN="source|Source|github|GitHub|repository|git\.io"
S13_HITS=$(grep -r -l -E "$S13_PATTERN" \
  "$ROOT/client/src" 2>/dev/null | wc -l | tr -d ' ')

if [[ "$S13_HITS" -gt 0 ]]; then
  pass "Found source-code link in client source ($S13_HITS file(s))"
  info "Verify a visible link to the source repo exists in the UI (footer, About page, etc.)"
else
  warn "No source-code link detected in UI source"
  warn "Recommended: add a link to the source repository in the app footer"
  bump_warn
fi

# ── 4. Vendored / embedded third-party code ───────────────────────────────────
header "4. Vendored / embedded third-party code"

VENDOR_DIRS=$(find "$ROOT" \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*" \
  -type d \( -name "vendor" -o -name "vendors" -o -name "third_party" -o -name "thirdparty" \) 2>/dev/null)

if [[ -z "$VENDOR_DIRS" ]]; then
  pass "No vendor directories found"
else
  warn "Vendor directories found — manually verify licenses:"
  echo "$VENDOR_DIRS" | while read -r d; do warn "  $d"; done
  bump_warn
fi

# Check for bundled minified third-party files
MINIFIED=$(find "$ROOT/client/src" "$ROOT/server/src" \
  -not -path "*/node_modules/*" \
  -name "*.min.js" -o -name "*.min.css" 2>/dev/null)

if [[ -n "$MINIFIED" ]]; then
  warn "Minified files found in source (may be vendored third-party code):"
  echo "$MINIFIED" | while read -r f; do warn "  $f"; done
  bump_warn
else
  pass "No minified files in source tree"
fi

# ── 5. Client dependency licenses ────────────────────────────────────────────
header "5. Client dependency licenses"

CLIENT_DIR="$ROOT/client"
if [[ ! -d "$CLIENT_DIR/node_modules" ]]; then
  warn "client/node_modules not installed — run: cd client && npm install"
  bump_warn
else
  info "Scanning client dependencies with license-checker…"
  CLIENT_LICENSES=$(cd "$CLIENT_DIR" && npx --yes license-checker \
    --excludePrivatePackages --summary 2>/dev/null || true)
  echo "$CLIENT_LICENSES" | while read -r line; do
    echo "  $line"
  done

  # Check for denied licenses (AGPL denied under ELv2)
  DENIED_PATTERN="GPL-2.0-only|SSPL|AGPL|Commons Clause|Proprietary|Commercial|UNLICENSED"
  CLIENT_DENIED=$(cd "$CLIENT_DIR" && npx license-checker \
    --excludePrivatePackages --csv 2>/dev/null \
    | grep -E "$DENIED_PATTERN" || true)

  if [[ -n "$CLIENT_DENIED" ]]; then
    fail "Denied licenses found in client dependencies:"
    echo "$CLIENT_DENIED" | while read -r line; do fail "  $line"; done
    bump_fail
  else
    pass "No denied licenses in client dependencies"
  fi
fi

# ── 6. Server dependency licenses ────────────────────────────────────────────
header "6. Server dependency licenses"

SERVER_DIR="$ROOT/server"
if [[ ! -d "$SERVER_DIR/node_modules" ]]; then
  warn "server/node_modules not installed — run: cd server && npm install"
  bump_warn
else
  info "Scanning server dependencies with license-checker…"
  SERVER_LICENSES=$(cd "$SERVER_DIR" && npx license-checker \
    --excludePrivatePackages --summary 2>/dev/null || true)
  echo "$SERVER_LICENSES" | while read -r line; do
    echo "  $line"
  done

  # Check for denied licenses
  SERVER_DENIED=$(cd "$SERVER_DIR" && npx license-checker \
    --excludePrivatePackages --csv 2>/dev/null \
    | grep -E "$DENIED_PATTERN" || true)

  if [[ -n "$SERVER_DENIED" ]]; then
    fail "Denied licenses found in server dependencies:"
    echo "$SERVER_DENIED" | while read -r line; do fail "  $line"; done
    bump_fail
  else
    pass "No denied licenses in server dependencies"
  fi

  # Check for unlicensed packages
  SERVER_UNLICENSED=$(cd "$SERVER_DIR" && npx license-checker \
    --excludePrivatePackages --csv 2>/dev/null \
    | grep -i '"Custom:' || true)

  if [[ -n "$SERVER_UNLICENSED" ]]; then
    warn "Packages with non-standard/custom license entries (manual review required):"
    echo "$SERVER_UNLICENSED" | while read -r line; do warn "  $line"; done
    warn "Known issue: buffers@0.1.1 — no license field (transitive via exceljs). See license-policy.json."
    bump_warn
  fi
fi

# ── 7. Known issues from policy file ─────────────────────────────────────────
header "7. Known issues (from license-policy.json)"

if command -v node &>/dev/null && [[ -f "$POLICY" ]]; then
  node -e "
    const p = require('$POLICY');
    (p.knownIssues || []).forEach(i => {
      const sev = i.severity === 'HIGH' ? '✘ HIGH' : '⚠  ' + i.severity;
      console.log('  ' + sev + ' — ' + i.package + '@' + i.version);
      console.log('    License : ' + (i.detectedLicense || i.actualLicense));
      console.log('    Action  : ' + i.action);
      console.log('');
    });
  " 2>/dev/null || warn "Could not parse license-policy.json"
else
  warn "license-policy.json not found or node unavailable"
fi

info "ELv2 requirements:"
node -e "
  const p = require('$POLICY');
  const r = p.elv2Requirements || {};
  Object.entries(r).forEach(([k, v]) => {
    const status = v.status || '';
    const ok = status.toLowerCase().includes('missing') ||
                status.toLowerCase().includes('not ') ? false : true;
    const icon = ok ? '✔' : '✘';
    console.log('  ' + icon + ' ' + k + ': ' + status);
  });
" 2>/dev/null || true

# ── 8. Summary ───────────────────────────────────────────────────────────────
header "8. Audit Summary"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo ""
echo "  Timestamp : $TIMESTAMP"
echo "  Failures  : $FAILURES"
echo "  Warnings  : $WARNINGS"
echo ""

if [[ $FAILURES -gt 0 ]]; then
  echo -e "${RED}${BOLD}  AUDIT FAILED — $FAILURES issue(s) require attention before distribution.${RESET}"
elif [[ $WARNINGS -gt 0 ]]; then
  echo -e "${YELLOW}${BOLD}  AUDIT PASSED WITH WARNINGS — $WARNINGS item(s) need review.${RESET}"
else
  echo -e "${GREEN}${BOLD}  AUDIT PASSED — No issues found.${RESET}"
fi

# Save plain-text report
{
  echo "vibe-tb License Audit"
  echo "Timestamp: $TIMESTAMP"
  echo "Failures: $FAILURES  |  Warnings: $WARNINGS"
  echo ""
  echo "Run ./scripts/license-audit.sh for full details."
  echo "See scripts/license-policy.json for policy and known issues."
} > "$REPORT"

echo ""
echo "  Report saved to: scripts/license-audit-result.txt"
echo ""

exit $FAILURES
