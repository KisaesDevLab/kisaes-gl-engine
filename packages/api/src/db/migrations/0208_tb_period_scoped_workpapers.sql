-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
-- migration-policy: non-additive-exception
-- (SET NOT NULL after a full backfill in the same transaction, plus the
-- sign-off live-uniqueness index moving from tax-year to period-end
-- grain — same shape as 0150 did for tb_row_attachments. No column is
-- dropped or renamed; tax_year stays as a derived/indexing column.)
--
-- Tickmark applications, TB notes and leadsheet sign-offs become
-- PERIOD-END scoped (Kurt, 2026-10-13): a mark/note/sign-off made on
-- the 08/31 workpaper must not show on 07/31 (and vice versa). The
-- tickmark LIBRARY (tb_tickmarks) stays shared. No roll-forward: a new
-- period end starts blank.
--
-- "Fiscal-year end of the tax year" below is the SQL form of
-- fiscalYearEnd(taxYear, fyStartMonth) in services/tb/tax-profile.service.ts
-- (identical to the 0150 backfill): FY start month <= 1 → Dec 31 of the
-- tax year; otherwise the day before the start month, in the tax-year
-- label year. A row whose company no longer exists falls back to a
-- calendar year (start month 1) so the NOT NULL step can never fail.
--
-- Backfill rules:
--   tb_tickmark_applications: tax_year 2026 → 2026-07-31 (owner's
--     explicit choice for the 4 live prod marks) — but only where
--     2026-07-31 actually falls inside tax year 2026 for that company
--     (FY start month 1 or 8–12); everything else → FY end of tax_year.
--   tb_notes: FY end of tax_year.
--   tb_leadsheet_signoffs: FY end of tax_year (invalidated rows too).

ALTER TABLE tb_tickmark_applications ADD COLUMN IF NOT EXISTS period_end DATE;
--> statement-breakpoint
ALTER TABLE tb_notes ADD COLUMN IF NOT EXISTS period_end DATE;
--> statement-breakpoint
ALTER TABLE tb_leadsheet_signoffs ADD COLUMN IF NOT EXISTS period_end DATE;
--> statement-breakpoint
UPDATE tb_tickmark_applications t
SET period_end = CASE
  WHEN t.tax_year = 2026 AND (s.m <= 1 OR s.m >= 8) THEN DATE '2026-07-31'
  WHEN s.m <= 1 THEN make_date(t.tax_year, 12, 31)
  ELSE (make_date(t.tax_year, s.m, 1) - INTERVAL '1 day')::date
END
FROM (
  SELECT x.id, COALESCE((SELECT c.fiscal_year_start_month FROM companies c WHERE c.id = x.company_id), 1) AS m
  FROM tb_tickmark_applications x
) s
WHERE s.id = t.id AND t.period_end IS NULL;
--> statement-breakpoint
UPDATE tb_notes t
SET period_end = CASE
  WHEN s.m <= 1 THEN make_date(t.tax_year, 12, 31)
  ELSE (make_date(t.tax_year, s.m, 1) - INTERVAL '1 day')::date
END
FROM (
  SELECT x.id, COALESCE((SELECT c.fiscal_year_start_month FROM companies c WHERE c.id = x.company_id), 1) AS m
  FROM tb_notes x
) s
WHERE s.id = t.id AND t.period_end IS NULL;
--> statement-breakpoint
UPDATE tb_leadsheet_signoffs t
SET period_end = CASE
  WHEN s.m <= 1 THEN make_date(t.tax_year, 12, 31)
  ELSE (make_date(t.tax_year, s.m, 1) - INTERVAL '1 day')::date
END
FROM (
  SELECT x.id, COALESCE((SELECT c.fiscal_year_start_month FROM companies c WHERE c.id = x.company_id), 1) AS m
  FROM tb_leadsheet_signoffs x
) s
WHERE s.id = t.id AND t.period_end IS NULL;
--> statement-breakpoint
ALTER TABLE tb_tickmark_applications ALTER COLUMN period_end SET NOT NULL;
--> statement-breakpoint
ALTER TABLE tb_notes ALTER COLUMN period_end SET NOT NULL;
--> statement-breakpoint
ALTER TABLE tb_leadsheet_signoffs ALTER COLUMN period_end SET NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_tb_tickmark_apps_lookup;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_tickmark_apps_lookup
  ON tb_tickmark_applications (company_id, period_end, account_id);
--> statement-breakpoint
DROP INDEX IF EXISTS idx_tb_notes_lookup;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_notes_lookup
  ON tb_notes (company_id, period_end);
--> statement-breakpoint
DROP INDEX IF EXISTS uniq_tb_leadsheet_signoffs_live;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tb_leadsheet_signoffs_live
  ON tb_leadsheet_signoffs (grouping_id, period_end, role)
  WHERE invalidated_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_tb_leadsheet_signoffs_lookup;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_leadsheet_signoffs_lookup
  ON tb_leadsheet_signoffs (company_id, period_end);
