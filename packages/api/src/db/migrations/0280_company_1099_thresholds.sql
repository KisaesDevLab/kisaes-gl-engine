-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Per-company 1099 reporting thresholds (U-215, ClientLedger P29, Q-PR6i).
-- One row per company and 1099 box (form_box: 'NEC-1', 'MISC-2', ... the
-- catalog in portal-1099.boxes.ts, checked by the API). No row = the year
-- table (U-212), so nothing changes for any company until an Admin sets an
-- amount. Additive: a new table only.
CREATE TABLE IF NOT EXISTS company_1099_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  form_box VARCHAR(10) NOT NULL,
  amount NUMERIC(19,4) NOT NULL CONSTRAINT chk_company_1099_thresholds_amount CHECK (amount >= 0),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_1099_thresholds_company_box
  ON company_1099_thresholds (company_id, form_box);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_company_1099_thresholds_tenant
  ON company_1099_thresholds (tenant_id);
