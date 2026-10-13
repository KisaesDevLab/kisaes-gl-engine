-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Q52 part: dashboard cards (Kurt, 2026-10-13; OPEN-QUESTIONS.md Q52). Shipped as its
-- OWN migration 0212_tax_est_dashboard_summaries (0209-0211 are reserved by parallel branches).
-- Additive only: one new table, nothing existing is altered.
--
-- A per-taxpayer-year summary of the latest LIVE estimate of the Base scenario (default range),
-- written whenever the estimate service computes or serves one, so the firm-wide cards ("Vouchers
-- due in the next 30 days", "Behind on payments") never compute estimates on page load.
--
-- Scoped like tax_est_snapshots (D1): firm_id + taxpayer (ON DELETE CASCADE). `tenant_ids` = the
-- books tenants the estimate actually read (same rule as tax_est_snapshots.tenant_ids); a row is
-- shown only to a viewer whose scope (D17 / D18) covers every one of them, so a summary can never
-- show figures from a client the viewer cannot reach. One row per distinct tenant set
-- (`tenant_set_key` = sha256 of the sorted set), replaced in place by newer computations.
--
-- The figures (voucher schedule with the engine's payment application, totals, penalty) are tax
-- return information (D9): AES-256-GCM ciphertext in `summary_encrypted` (utils/encryption.ts),
-- which also enrols the column in the key-rotation re-encryption sweep. Nothing is plaintext but
-- ids, the year, hashes and timestamps.
CREATE TABLE IF NOT EXISTS tax_est_dashboard_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL,
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  scenario_id UUID NOT NULL REFERENCES tax_est_scenarios(id) ON DELETE CASCADE,
  tenant_set_key CHAR(64) NOT NULL,
  tenant_ids UUID[] NOT NULL DEFAULT '{}',
  inputs_hash CHAR(64) NOT NULL,
  engine_version VARCHAR(40) NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  summary_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_dashboard_summaries UNIQUE (firm_id, taxpayer_id, tax_year, tenant_set_key)
);
CREATE INDEX IF NOT EXISTS idx_tax_est_dashboard_summaries_firm_year
  ON tax_est_dashboard_summaries (firm_id, tax_year, taxpayer_id);
