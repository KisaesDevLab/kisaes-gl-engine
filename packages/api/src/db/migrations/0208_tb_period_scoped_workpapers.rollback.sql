-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0208: back to tax-year scoping. LOSSY by nature — marks
-- and notes made on different period ends of one tax year merge back
-- into a single tax-year view. Before the old (grouping, tax_year, role)
-- live-uniqueness index can return, every live sign-off except the most
-- recent per (grouping, tax_year, role) is invalidated (now()).

UPDATE tb_leadsheet_signoffs s
SET invalidated_at = now()
WHERE s.invalidated_at IS NULL
  AND EXISTS (
    SELECT 1 FROM tb_leadsheet_signoffs n
    WHERE n.grouping_id = s.grouping_id
      AND n.tax_year = s.tax_year
      AND n.role = s.role
      AND n.invalidated_at IS NULL
      AND (n.signed_at, n.id) > (s.signed_at, s.id)
  );

DROP INDEX IF EXISTS uniq_tb_leadsheet_signoffs_live;
CREATE UNIQUE INDEX uniq_tb_leadsheet_signoffs_live
  ON tb_leadsheet_signoffs (grouping_id, tax_year, role)
  WHERE invalidated_at IS NULL;
DROP INDEX IF EXISTS idx_tb_leadsheet_signoffs_lookup;
CREATE INDEX idx_tb_leadsheet_signoffs_lookup
  ON tb_leadsheet_signoffs (company_id, tax_year);
DROP INDEX IF EXISTS idx_tb_notes_lookup;
CREATE INDEX idx_tb_notes_lookup
  ON tb_notes (company_id, tax_year);
DROP INDEX IF EXISTS idx_tb_tickmark_apps_lookup;
CREATE INDEX idx_tb_tickmark_apps_lookup
  ON tb_tickmark_applications (company_id, tax_year, account_id);

ALTER TABLE tb_leadsheet_signoffs DROP COLUMN IF EXISTS period_end;
ALTER TABLE tb_notes DROP COLUMN IF EXISTS period_end;
ALTER TABLE tb_tickmark_applications DROP COLUMN IF EXISTS period_end;
