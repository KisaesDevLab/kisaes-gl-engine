-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0224 (journal entry adjusting flag, reversing link). The code
-- reading these must be rolled back with it.
--
-- Reversing entries stay as ordinary posted journal entries (their lines
-- balance on their own); only the link to the entry they reverse is lost,
-- so voiding an original no longer voids its reversal. The adjusting flag is
-- dropped: reports include every entry again, as before 0224.
DROP INDEX IF EXISTS "idx_txn_reverses";
--> statement-breakpoint
ALTER TABLE IF EXISTS "transactions" DROP COLUMN IF EXISTS "reverses_transaction_id";
--> statement-breakpoint
ALTER TABLE IF EXISTS "transactions" DROP COLUMN IF EXISTS "is_adjusting";
