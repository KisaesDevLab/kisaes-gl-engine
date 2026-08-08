-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Per-row leadsheet PDF attachments: each file gets an immutable ref
-- code (leadsheet code + sequence, e.g. A001) unique per company +
-- tax year. Tickmark stamps live as jsonb annotations and are burned
-- onto the PDF at download time — the stored original is never
-- modified. File bytes ride the existing polymorphic attachments
-- table (attachable_type 'tb_leadsheet').

CREATE TABLE IF NOT EXISTS tb_row_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  company_id UUID NOT NULL,
  grouping_id UUID NOT NULL REFERENCES tb_groupings(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  tax_year INTEGER NOT NULL,
  ref_code VARCHAR(12) NOT NULL,
  attachment_id UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  source_file_name VARCHAR(255) NOT NULL DEFAULT '',
  annotations JSONB NOT NULL DEFAULT '[]',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tb_row_attachments_ref
  ON tb_row_attachments (company_id, tax_year, ref_code);
CREATE INDEX IF NOT EXISTS idx_tb_row_attachments_lookup
  ON tb_row_attachments (company_id, tax_year, grouping_id);
CREATE INDEX IF NOT EXISTS idx_tb_row_attachments_tenant
  ON tb_row_attachments (tenant_id);
