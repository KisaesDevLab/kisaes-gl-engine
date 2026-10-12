-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Phase 12 part: immutable estimate snapshots (MODULE.md "Scenarios,
-- snapshots, standards"; TE_SNAPSHOT_IMMUTABLE). Assembled AFTER estimate.sql.
-- Additive only: one new firm-scoped table, its trigger function and trigger.
--
-- The payload (inputs, engine result, resolved federal parameters and state rules
-- with statuses, readiness, assumptions, disclaimer) contains prior-year tax / AGI
-- and figures derived from them: tax return information (D9, IRC §7216). It is
-- AES-256-GCM ciphertext in `*_encrypted` TEXT columns, which enrols it in the
-- credential re-encryption sweep (credential-reencrypt.service.ts). `*_sha256` is
-- the hash of the PLAINTEXT, checked on every read, so a re-encrypted payload still
-- verifies and a swapped one does not.
--
-- Immutability: the service has no update path, and the trigger below rejects any
-- UPDATE that changes a column other than the two ciphertext columns (the sweep
-- rewrites only those). scenario_id has NO foreign key on purpose: a snapshot
-- outlives its scenario, and an ON DELETE SET NULL action would be an UPDATE.
-- Rows go away only with their taxpayer (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS tax_est_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL,
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  scenario_id UUID NOT NULL,
  scenario_name VARCHAR(120) NOT NULL,
  reason VARCHAR(16) NOT NULL CHECK (reason IN ('finalize', 'vouchers', 'pdf', 'report_pack')),
  note TEXT,
  engine_version VARCHAR(40) NOT NULL,
  inputs_hash CHAR(64) NOT NULL,
  -- Books tenants whose companies the snapshot includes (D1: the view is refused to a
  -- caller who can no longer reach one of them).
  tenant_ids UUID[] NOT NULL DEFAULT '{}',
  payload_encrypted TEXT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  summary_encrypted TEXT NOT NULL,
  summary_sha256 CHAR(64) NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_est_snapshots_firm_taxpayer_year
  ON tax_est_snapshots (firm_id, taxpayer_id, tax_year, created_at DESC);

CREATE OR REPLACE FUNCTION tax_est_snapshots_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'payload_encrypted' - 'summary_encrypted')
     IS DISTINCT FROM (to_jsonb(OLD) - 'payload_encrypted' - 'summary_encrypted') THEN
    RAISE EXCEPTION 'TE_SNAPSHOT_IMMUTABLE: tax estimate snapshots cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_tax_est_snapshots_immutable ON tax_est_snapshots;
CREATE TRIGGER trg_tax_est_snapshots_immutable
  BEFORE UPDATE ON tax_est_snapshots
  FOR EACH ROW EXECUTE FUNCTION tax_est_snapshots_immutable();
