#!/usr/bin/env bash
# =============================================================================
# generate-sbom.sh — Produce a CycloneDX SBOM and a flat license inventory
#                    for Vibe MyBooks.
# License: PolyForm Internal Use 1.0.0 (SEE LICENSE IN LICENSE)
#
# Outputs:
#   scripts/sbom.cdx.json          — CycloneDX 1.5 JSON (all workspaces)
#   scripts/license-inventory.json — Flat {package@version: {licenses,...}}
#                                    from license-checker (production deps)
#
# Both artifacts are uploaded by the license-check GitHub Actions workflow.
# =============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SBOM="$ROOT/scripts/sbom.cdx.json"
INVENTORY="$ROOT/scripts/license-inventory.json"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RESET='\033[0m'
info()  { echo -e "${CYAN}  ▶ $*${RESET}"; }
pass()  { echo -e "${GREEN}  ✔ $*${RESET}"; }

info "Generating CycloneDX SBOM…"
cd "$ROOT"
npx --yes @cyclonedx/cyclonedx-npm \
  --output-file "$SBOM" \
  --output-format JSON \
  --spec-version 1.5 \
  2>/dev/null

pass "SBOM written to scripts/sbom.cdx.json ($(wc -c < "$SBOM" | tr -d ' ') bytes)"

info "Generating flat license inventory…"
# Note: --production is omitted because workspaces root has no dependencies;
# the CycloneDX SBOM is the authoritative "shipped" set. The inventory here
# lists everything resolved under node_modules (prod + dev) for diffing.
npx --yes license-checker \
  --json \
  --excludePrivatePackages \
  > "$INVENTORY"

PKG_COUNT=$(INV_PATH="$INVENTORY" node -e 'console.log(Object.keys(require(process.env.INV_PATH)).length)' 2>/dev/null || echo "?")
pass "Inventory written to scripts/license-inventory.json ($PKG_COUNT packages)"
