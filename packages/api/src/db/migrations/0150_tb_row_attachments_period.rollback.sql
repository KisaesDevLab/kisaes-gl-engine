-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

DROP INDEX IF EXISTS uniq_tb_row_attachments_ref;
CREATE UNIQUE INDEX uniq_tb_row_attachments_ref
  ON tb_row_attachments (company_id, tax_year, ref_code);
DROP INDEX IF EXISTS idx_tb_row_attachments_lookup;
CREATE INDEX idx_tb_row_attachments_lookup
  ON tb_row_attachments (company_id, tax_year, grouping_id);
ALTER TABLE tb_row_attachments DROP COLUMN IF EXISTS period_end;
