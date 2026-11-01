-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Customer deposits (U-135 customer-deposits-v1).
--
-- 1. transactions.holds_deposit (boolean, default false): a customer payment
--    held as a deposit (Dr the bank, Cr Customer Deposits) instead of
--    crediting A/R.
-- 2. transactions.from_deposit_id (uuid, soft reference): a customer payment
--    that draws on a held deposit (Dr Customer Deposits, Cr A/R) and carries
--    its applications. Partial index for the deposit's remaining.
--
-- The Customer Deposits account is a lazy system role (customer_deposits),
-- created on first use; nothing is created here. Additive; idempotent.
-- Ordering: after 0248. Rollback: 0249_customer_deposits.rollback.sql.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS holds_deposit boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS from_deposit_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_txn_from_deposit
  ON transactions (tenant_id, from_deposit_id) WHERE from_deposit_id IS NOT NULL;
