-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
-- migration-policy: non-additive-exception
-- (Index swap + SET NOT NULL on a table shipped hours ago in 0149 with
-- no external consumers; the backfill fully populates period_end before
-- the constraint, and the ref-code uniqueness must move from tax-year
-- to period grain in the same transaction to avoid a window where
-- duplicate per-period codes could be allocated.)
--
-- Leadsheet row attachments become PERIOD-scoped: a file attached while
-- working the 12/31 workpaper belongs to 12/31 and must not surface in
-- a 7/31 interim package. Numbering restarts per (company, period_end)
-- instead of per tax year. Existing rows backfill to their tax year's
-- fiscal year end.

ALTER TABLE tb_row_attachments ADD COLUMN IF NOT EXISTS period_end DATE;

UPDATE tb_row_attachments ra
SET period_end = CASE
  WHEN COALESCE(c.fiscal_year_start_month, 1) <= 1 THEN make_date(ra.tax_year, 12, 31)
  ELSE (make_date(ra.tax_year, COALESCE(c.fiscal_year_start_month, 1), 1) - INTERVAL '1 day')::date
END
FROM companies c
WHERE c.id = ra.company_id AND ra.period_end IS NULL;

ALTER TABLE tb_row_attachments ALTER COLUMN period_end SET NOT NULL;

DROP INDEX IF EXISTS uniq_tb_row_attachments_ref;
CREATE UNIQUE INDEX uniq_tb_row_attachments_ref
  ON tb_row_attachments (company_id, period_end, ref_code);
DROP INDEX IF EXISTS idx_tb_row_attachments_lookup;
CREATE INDEX idx_tb_row_attachments_lookup
  ON tb_row_attachments (company_id, period_end, grouping_id);
