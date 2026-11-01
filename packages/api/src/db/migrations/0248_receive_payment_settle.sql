-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Receive Payment: write-offs, credits, refunds and early-payment discounts
-- (U-133 payment-settle-v1, U-134 payment-discounts-v1).
--
-- 1. payment_applications.write_off_amount / write_off_account_id: the part
--    of an invoice's balance written off with the payment (Dr the write-off
--    account, Cr A/R).
-- 2. payment_applications.discount_amount / discount_account_id: an
--    early-payment discount taken (Dr the sales discount account, Cr A/R).
-- 3. payment_applications.applied_date / applied_in_txn_id: a credit applied
--    after the payment that holds it: the date it was applied and the
--    customer payment it was applied inside (NULL for POST /payments/:id/apply).
--    NULL applied_date = applied with the payment itself.
-- 4. transactions.source_payment_id: a customer refund of a payment's credit.
-- 5. companies.write_off_account_id, write_off_threshold (the amount under
--    which a shortfall is suggested for write-off; 1.00 for new and existing
--    companies, Q-P21h; NULL = never suggested), sales_discount_account_id.
--
-- Amounts default 0, so existing rows read exactly as before. Additive;
-- idempotent. Ordering: after 0247. Rollback:
-- 0248_receive_payment_settle.rollback.sql.

ALTER TABLE payment_applications ADD COLUMN IF NOT EXISTS write_off_amount numeric(19, 4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE payment_applications ADD COLUMN IF NOT EXISTS write_off_account_id uuid;
--> statement-breakpoint
ALTER TABLE payment_applications ADD COLUMN IF NOT EXISTS discount_amount numeric(19, 4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE payment_applications ADD COLUMN IF NOT EXISTS discount_account_id uuid;
--> statement-breakpoint
ALTER TABLE payment_applications ADD COLUMN IF NOT EXISTS applied_date date;
--> statement-breakpoint
ALTER TABLE payment_applications ADD COLUMN IF NOT EXISTS applied_in_txn_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pa_applied_in
  ON payment_applications (applied_in_txn_id) WHERE applied_in_txn_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_payment_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_txn_source_payment
  ON transactions (tenant_id, source_payment_id) WHERE source_payment_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS write_off_account_id uuid;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS write_off_threshold numeric(19, 4) DEFAULT 1.0000;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sales_discount_account_id uuid;
