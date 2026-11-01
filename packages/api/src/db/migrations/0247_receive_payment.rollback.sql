-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0247 (Receive Payment lifecycle, U-132). The code that reads
-- the columns must be rolled back with it. Application rows that a void,
-- unapply, edit or bounce marked are deleted (the old code deleted them
-- itself); rows of a payment recorded against one invoice
-- (applied_to_invoice_id) are deleted too, since the old code reads that
-- column instead. Lost: which transactions were posted together (source
-- links), and the bounced-payment preferences. Bounced-payment entries
-- (txn_type 'returned_payment') stay posted and balanced; the old code shows
-- them as ordinary entries.

DELETE FROM payment_applications WHERE voided_at IS NOT NULL OR reversed_by_txn_id IS NOT NULL;
--> statement-breakpoint
DELETE FROM payment_applications pa
USING transactions tp
WHERE tp.id = pa.payment_id AND tp.tenant_id = pa.tenant_id
  AND tp.txn_type = 'customer_payment' AND tp.applied_to_invoice_id IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_pa_payment_live;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_pa_reversed_by;
--> statement-breakpoint
ALTER TABLE payment_applications DROP COLUMN IF EXISTS voided_at;
--> statement-breakpoint
ALTER TABLE payment_applications DROP COLUMN IF EXISTS reversed_by_txn_id;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_txn_source_txn;
--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN IF EXISTS source_txn_id;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS nsf_bank_fee_account_id;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS nsf_fee_income_account_id;
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS nsf_customer_fee;
