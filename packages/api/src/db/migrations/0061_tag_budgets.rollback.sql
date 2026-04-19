-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- migration-policy: non-additive-exception
-- Reason: ROLLBACK file for 0061_tag_budgets.sql. Drops the new
-- budget_periods table and removes the scope / lifecycle columns
-- added to budgets — the whole point of a rollback. Not registered in
-- _journal.json; never auto-applied. Legacy budget_lines.month_N
-- columns are untouched and remain authoritative after rollback.
-- Tag-scoping and status data written into the new columns is lost.

DROP TABLE IF EXISTS budget_periods;

DROP INDEX IF EXISTS idx_budgets_tenant_fy_start;
DROP INDEX IF EXISTS idx_budgets_tenant_tag;

ALTER TABLE budgets
  DROP CONSTRAINT IF EXISTS ck_budgets_status;
ALTER TABLE budgets
  DROP CONSTRAINT IF EXISTS ck_budgets_period_type;
ALTER TABLE budgets
  DROP CONSTRAINT IF EXISTS fk_budgets_tag_id;

ALTER TABLE budgets
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS fiscal_year_start,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS period_type,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS tag_id;
