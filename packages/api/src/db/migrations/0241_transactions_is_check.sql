-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- transactions.is_check (boolean, default false): the transaction was
-- created as a check (Write Checks, or a Pay Bills payment by check that
-- pays cash). Check lists and check reads use it (U-117, Q-PR2e), so a
-- check voided while waiting to print (its print status cleared, U-115)
-- is still a check, and a plain Expense paid "by check" never is.
--
-- Backfill: every row with a print status was created as a check. Checks
-- voided while queued before this migration have lost that status; a
-- bill payment by check paying cash is one of them, and so is a void
-- expense that kept the payee name a written check always stores.
--
-- Additive only; PostgreSQL 11+ adds the column without a rewrite.
-- Ordering: after 0240. Rollback: 0241_transactions_is_check.rollback.sql.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_check boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE transactions SET is_check = true
WHERE NOT is_check AND (
  print_status IS NOT NULL
  OR (status = 'void' AND payment_method = 'check' AND (
    (txn_type = 'bill_payment' AND total > 0)
    OR (txn_type = 'expense' AND payee_name_on_check IS NOT NULL)
  ))
);
