-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Receive Payment lifecycle (U-132 receive-payment-v1, payment-bounce-v1).
--
-- 1. payment_applications.voided_at (timestamptz): application rows are no
--    longer deleted. A void, an unapply or an edit of the payment marks them.
-- 2. payment_applications.reversed_by_txn_id (uuid, soft reference): the
--    returned_payment ('Bounced payment') that took the row back. A live
--    application has both columns NULL; a partial index serves the readers.
-- 3. transactions.source_txn_id (uuid, soft reference): a transaction posted
--    as part of another one (a bounce's bank fee -> the bounce; a bounce ->
--    the payment it returns). Not reverses_transaction_id, which U-61 voids
--    together with its original.
-- 4. companies.nsf_bank_fee_account_id / nsf_fee_income_account_id (uuid,
--    soft references) and nsf_customer_fee (numeric, NULL until set): the
--    bounced-payment preferences.
-- 5. Backfill: a posted customer payment recorded against one invoice
--    (applied_to_invoice_id) without application rows gets one row for its
--    total, so a void or a bounce reopens the invoice. Nothing is posted and
--    no balance changes.
--
-- Additive; idempotent. Ordering: after 0246. Rollback:
-- 0247_receive_payment.rollback.sql.

ALTER TABLE payment_applications ADD COLUMN IF NOT EXISTS voided_at timestamptz;
--> statement-breakpoint
ALTER TABLE payment_applications ADD COLUMN IF NOT EXISTS reversed_by_txn_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pa_payment_live
  ON payment_applications (payment_id) WHERE voided_at IS NULL AND reversed_by_txn_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pa_reversed_by
  ON payment_applications (reversed_by_txn_id) WHERE reversed_by_txn_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_txn_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_txn_source_txn
  ON transactions (tenant_id, source_txn_id) WHERE source_txn_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS nsf_bank_fee_account_id uuid;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS nsf_fee_income_account_id uuid;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS nsf_customer_fee numeric(19, 4);
--> statement-breakpoint
INSERT INTO payment_applications (tenant_id, company_id, payment_id, invoice_id, amount, created_at)
SELECT tp.tenant_id, tp.company_id, tp.id, tp.applied_to_invoice_id, tp.total, tp.created_at
FROM transactions tp
WHERE tp.txn_type = 'customer_payment' AND tp.status = 'posted'
  AND tp.applied_to_invoice_id IS NOT NULL AND tp.total IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.tenant_id = tp.tenant_id AND pa.payment_id = tp.id
  );
