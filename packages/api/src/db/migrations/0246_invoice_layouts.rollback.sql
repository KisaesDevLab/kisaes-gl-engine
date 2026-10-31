-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0246 (invoice print layouts, U-130). The code that reads the
-- columns must be rolled back with it. Lost: which line columns each layout
-- shows and which layout each invoice prints with (every invoice prints with
-- the company default again). The extra layouts stay as rows the old code
-- ignores. The default that 0246 renamed is renamed back, so a default the
-- owner named 'Standard' himself also becomes 'Default'. The one-default
-- clean-up is kept (it only fixed duplicates).

UPDATE invoice_templates SET name = 'Default' WHERE name = 'Standard' AND is_default IS TRUE;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_invoice_templates_company_default;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_txn_invoice_layout;
--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN IF EXISTS invoice_layout_id;
--> statement-breakpoint
ALTER TABLE invoice_templates DROP COLUMN IF EXISTS line_columns;
