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
# --ignore-npm-errors: cyclonedx-npm runs `npm ls --json --long --all`
# under the hood. On Node 24 (npm 11+) `npm ls` exits 1 with
# ELSPROBLEMS for transitive `invalid:` entries from our overrides
# block (e.g., unzipper / esbuild pinned for security sweeps don't
# match a transitive's declared range). The deps are correct — npm 11
# just flags any version-range mismatch as ELSPROBLEMS where npm 10
# tolerated them. Without this flag, the SBOM step never produces an
# artifact and the docker-publish workflow's `needs: license-check`
# gate skips every downstream job — meaning no GHCR image gets
# published from main.
#
# Stderr is no longer hidden — earlier `2>/dev/null` made the same
# failure invisible for days because the script reported only "exit
# 254" with no context, forcing a Docker-on-Node-24 reproduction to
# unearth the actual `npm ls` error.
npx --yes @cyclonedx/cyclonedx-npm \
  --ignore-npm-errors \
  --output-file "$SBOM" \
  --output-format JSON \
  --spec-version 1.5

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
