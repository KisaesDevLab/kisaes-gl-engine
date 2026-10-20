-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0223 (deposit links, equity roles). The code reading these
-- must be rolled back with it.
--
-- Refused while a vendor refund link exists (a deposit_lines row whose
-- source is a vendor credit, U-54): the code before 0223 recomputes a
-- credit's open balance from bill-payment applications only, so the
-- refunded amount would become spendable again. Void or delete those
-- refund deposits first (that releases the links), then roll back.
-- Grouping links (U-52) stay: deposit_lines predates 0223 and the older
-- code reads them as before.
--
-- Deposit lines lose their source and cash-back marks (deposit_lines rows
-- stay). The equity role tags are cleared, and so is is_system on the
-- role accounts, so the older code treats the accounts 0223 (or the
-- engine) created as the ordinary, deletable equity accounts it knows.
-- Adoption never records the account's earlier flag; the built-in
-- templates' equity accounts are not system accounts, so an adopted one
-- loses nothing, but a hand-flagged system equity account that was
-- adopted would come back unflagged. The accounts themselves stay,
-- because they may carry postings by then.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "deposit_lines" dl
    JOIN "transactions" s ON s.id = dl.source_transaction_id
    WHERE s.txn_type = 'vendor_credit'
  ) THEN
    RAISE EXCEPTION '0223 rollback refused: vendor refund deposits are linked to vendor credits. Void or delete those deposits first, then roll back.';
  END IF;
END $$;
--> statement-breakpoint
UPDATE "accounts" SET "system_tag" = NULL, "is_system" = false, "updated_at" = now()
WHERE "system_tag" IN ('owner_draw', 'owner_contribution', 'partner_draws', 'partner_contributions', 'shareholder_distributions', 'paid_in_capital');
--> statement-breakpoint
ALTER TABLE IF EXISTS "journal_lines" DROP COLUMN IF EXISTS "line_role";
--> statement-breakpoint
ALTER TABLE IF EXISTS "journal_lines" DROP COLUMN IF EXISTS "source_transaction_id";
