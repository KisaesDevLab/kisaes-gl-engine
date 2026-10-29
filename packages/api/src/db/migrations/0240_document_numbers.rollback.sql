-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0240 (document numbering, footers, forms print queue; U-111,
-- U-113). The code that reads the columns must be rolled back with it. Lost:
-- the prefixes and next numbers of cash sales, credit memos and statements
-- (numbers already on transactions stay), the per-type footer overrides and
-- the print-later marks on invoices, cash sales and credit memos.

DROP INDEX IF EXISTS idx_txn_print_later;
--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN IF EXISTS print_later;
--> statement-breakpoint
ALTER TABLE invoice_templates DROP COLUMN IF EXISTS footer_overrides;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS document_numbers;
