-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- TB vendor-export history (plan 11.9): one row per generated export
-- file with the provenance that makes staleness detectable (rule TB11):
-- glVersionStamp + basis at generation, validation-override flag, and
-- the storage key for re-download. Additive: new table only.

CREATE TABLE IF NOT EXISTS tb_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  tax_year INTEGER NOT NULL,
  software VARCHAR(20) NOT NULL,
  basis VARCHAR(10) NOT NULL,
  gl_version_stamp BIGINT NOT NULL,
  override_used BOOLEAN NOT NULL DEFAULT FALSE,
  file_name VARCHAR(255) NOT NULL,
  storage_key VARCHAR(500) NOT NULL,
  storage_provider VARCHAR(30),
  row_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_exports_lookup
  ON tb_exports (company_id, tax_year, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_exports_tenant
  ON tb_exports (tenant_id);
