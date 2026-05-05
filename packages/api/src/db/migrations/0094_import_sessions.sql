-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- Bulk-import staging table — one row per CSV / XLSX upload through
-- the new /admin/import flow. Holds parsed canonical rows + validation
-- errors as JSONB so a single table covers all four import kinds
-- (coa, contacts, trial_balance, gl_transactions). Purely additive:
-- no changes to existing tables.

CREATE TABLE import_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  company_id UUID NOT NULL,
  kind VARCHAR(20) NOT NULL,            -- coa | contacts | trial_balance | gl_transactions
  source_system VARCHAR(30) NOT NULL,   -- accounting_power | quickbooks_online
  status VARCHAR(20) NOT NULL DEFAULT 'uploaded',
  original_filename VARCHAR(255) NOT NULL,
  file_hash VARCHAR(64) NOT NULL,       -- sha256 hex; lets the upload endpoint
                                        -- detect a re-upload of the same bytes.
  row_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  parsed_rows JSONB,
  validation_errors JSONB,
  commit_result JSONB,
  options JSONB,
  report_date DATE,                     -- TB only — drives the opening-JE date.
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ
);

-- List queries on the admin page filter by (tenant, company, kind, status).
CREATE INDEX idx_imp_sess_tck
  ON import_sessions (tenant_id, company_id, kind, status);

-- Upload-time duplicate check: same bytes for the same company.
CREATE INDEX idx_imp_sess_hash
  ON import_sessions (tenant_id, company_id, file_hash);
