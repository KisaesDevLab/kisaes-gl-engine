#!/usr/bin/env bash
# Copyright 2026 Kisaes LLC
# Licensed under the PolyForm Small Business License 1.0.0.
# Free for small businesses; see LICENSE for terms.
# =============================================================================
# generate-sbom.sh — Produce a CycloneDX SBOM and a flat license inventory
#                    for Vibe MyBooks.
# License: PolyForm Small Business 1.0.0 (SEE LICENSE IN LICENSE)
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
#
# Belt-and-suspenders (v0.9.25 release fix): even WITH
# --ignore-npm-errors, some cyclonedx-npm / npm 11 pairings still
# propagate `npm ls`'s non-zero ELSPROBLEMS exit through the CLI —
# which under `set -e` aborts the whole license-check job and skips
# every downstream docker-publish job (no GHCR image ships). The SBOM
# is still written correctly in that case, so we assert on the
# ARTIFACT (present + valid JSON), not the exit code. The tool is
# pinned so an unrelated `npx @latest` bump can't reintroduce the
# regression.
is_valid_json() { node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$1" >/dev/null 2>&1; }

set +e
npx --yes @cyclonedx/cyclonedx-npm@5.0.0 \
  --ignore-npm-errors \
  --output-file "$SBOM" \
  --output-format JSON \
  --spec-version 1.5
CDX_EXIT=$?
set -e

if [[ ! -s "$SBOM" ]] || ! is_valid_json "$SBOM"; then
  # cyclonedx-npm shells `npm ls --json --all`, which on the CI runner's
  # npm emits UNPARSEABLE output under ELSPROBLEMS (our intentional
  # `invalid:` overrides — unzipper/esbuild), so --ignore-npm-errors
  # can't save it and NO SBOM is written. That broke the v0.9.25 release
  # (license-check gates docker-publish). Fall back to deriving the SBOM
  # straight from package-lock.json — no npm ls, npm-version independent.
  info "cyclonedx-npm produced no valid SBOM (exit ${CDX_EXIT}); deriving from package-lock.json"
  SBOM_OUT="$SBOM" node scripts/lockfile-sbom.mjs
fi

if [[ ! -s "$SBOM" ]] || ! is_valid_json "$SBOM"; then
  echo "SBOM generation failed: neither cyclonedx nor the lockfile fallback produced valid JSON" >&2
  exit 1
fi

pass "SBOM written to scripts/sbom.cdx.json ($(wc -c < "$SBOM" | tr -d ' ') bytes)"

info "Generating flat license inventory…"
# Note: --production is omitted because workspaces root has no dependencies;
# the CycloneDX SBOM is the authoritative "shipped" set. The inventory here
# lists everything resolved under node_modules (prod + dev) for diffing.
# Same resilience as the SBOM step: validate the produced JSON rather than
# trusting the exit code, so a benign npm-tree warning can't fail the job.
set +e
npx --yes license-checker \
  --json \
  --excludePrivatePackages \
  > "$INVENTORY"
LC_EXIT=$?
set -e
if [[ ! -s "$INVENTORY" ]] || ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$INVENTORY" >/dev/null 2>&1; then
  echo "license inventory did not produce valid JSON (license-checker exit ${LC_EXIT})" >&2
  exit 1
fi

PKG_COUNT=$(INV_PATH="$INVENTORY" node -e 'console.log(Object.keys(require(process.env.INV_PATH)).length)' 2>/dev/null || echo "?")
pass "Inventory written to scripts/license-inventory.json ($PKG_COUNT packages)"
