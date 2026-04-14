-- Extended P&L: reclassify accounts into the new account types.
-- Adds cogs / other_revenue / other_expense alongside the existing
-- revenue / expense so the Profit & Loss report can render Gross Profit,
-- Operating Income, and below-the-line Other Revenue / Other Expense
-- sections.
--
-- Classification is by standard COA number range, which matches how the
-- built-in BUSINESS_TEMPLATES are structured:
--   5xxxx expense  -> cogs
--   8xxxx expense  -> other_expense
--   48xxx / 49xxx / 8xxxx revenue -> other_revenue
-- 6xxxx/7xxxx expenses and 40xxx-47xxx revenues stay as they are.
--
-- Forward-only and idempotent (re-running is a no-op because the source
-- account_type values no longer match after the first run).

UPDATE accounts
SET account_type = 'cogs'
WHERE account_type = 'expense'
  AND account_number IS NOT NULL
  AND account_number ~ '^5';
--> statement-breakpoint

UPDATE accounts
SET account_type = 'other_expense'
WHERE account_type = 'expense'
  AND account_number IS NOT NULL
  AND account_number ~ '^8';
--> statement-breakpoint

UPDATE accounts
SET account_type = 'other_revenue'
WHERE account_type = 'revenue'
  AND account_number IS NOT NULL
  AND (account_number ~ '^48' OR account_number ~ '^49' OR account_number ~ '^8');
--> statement-breakpoint

-- Normalize detail_type on the freshly reclassified COGS accounts so the
-- UI detail-type dropdowns stay internally consistent. The templates used
-- 'other_expense' as a catch-all for almost every expense; now that the
-- row is a COGS row, the canonical detail_type is 'cost_of_goods_sold'.
UPDATE accounts
SET detail_type = 'cost_of_goods_sold'
WHERE account_type = 'cogs'
  AND (detail_type IS NULL OR detail_type = 'other_expense');
--> statement-breakpoint

-- Drop built-in COA template rows so index.ts bootstrap re-seeds them
-- from the updated BUSINESS_TEMPLATES constant (which already carries
-- the new account types after the accompanying code change). Admin-
-- authored templates are preserved (is_builtin = false).
DELETE FROM coa_templates WHERE is_builtin = true;
