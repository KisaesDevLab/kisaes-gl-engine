-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0253 (sales tax liability, pure-cash receipts; U-149, U-152).
-- The code that reads these must be rolled back with it. LOST: the daily
-- sales template links to a sales tax and tax codes (the posted daily sales
-- and their tax rows stay). The Unapplied receipts account is deleted when
-- nothing posted to it (the engine never does; only the cash-basis report
-- re-points lines onto it), else it loses its system tag and stays as an
-- ordinary income account. The `sales_tax` permission grants stay: code
-- before 0253 still has the resource (0252) and resolves absent keys to
-- none, so removing them would take access away; 0252's rollback code
-- ignores the key.

DROP FUNCTION IF EXISTS sales_tax_liability_upgrade_tenant(uuid);
--> statement-breakpoint
DELETE FROM accounts a WHERE a.system_tag = 'unapplied_receipts'
  AND NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.account_id = a.id);
--> statement-breakpoint
UPDATE accounts SET system_tag = NULL, is_system = false, updated_at = now() WHERE system_tag = 'unapplied_receipts';
--> statement-breakpoint
ALTER TABLE daily_sales_template_lines DROP COLUMN IF EXISTS tax_code_id;
--> statement-breakpoint
ALTER TABLE daily_sales_template_lines DROP COLUMN IF EXISTS sales_tax_id;
