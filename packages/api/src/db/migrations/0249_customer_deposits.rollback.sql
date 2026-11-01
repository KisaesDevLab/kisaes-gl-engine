-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0249 (customer deposits, U-135). The code that reads the
-- columns must be rolled back with it. Lost: which payments are held
-- deposits and which payments drew on them. The postings stay, balanced
-- (Customer Deposits keeps its balance; the old code shows the entries as
-- ordinary payments).

DROP INDEX IF EXISTS idx_txn_from_deposit;
--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN IF EXISTS from_deposit_id;
--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN IF EXISTS holds_deposit;
