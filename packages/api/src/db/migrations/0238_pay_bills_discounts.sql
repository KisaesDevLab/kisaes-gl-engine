-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- migration-policy: non-additive-exception
--
-- Pay Bills early-payment discounts (U-101; capability bill-discounts-v1).
--
-- 1. companies.bill_discount_account_id (nullable, additive): the account a
--    discount taken in Pay Bills posts to when the request names none.
-- 2. bill_payment_applications.chk_bpa_amount_positive is widened from
--    CHECK (amount > 0) to CHECK (amount >= 0 AND amount + discount_amount > 0):
--    a bill settled by vendor credits plus an early-payment discount (no
--    cash) still needs its application row to carry the discount. Every
--    existing row (amount > 0, discount_amount >= 0) satisfies the new rule;
--    the marker is needed because the policy check treats any constraint
--    replacement as non-additive (the 0087 / 0235 precedent).
--
-- Rollback: 0238_pay_bills_discounts.rollback.sql.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS bill_discount_account_id uuid;
--> statement-breakpoint
ALTER TABLE bill_payment_applications
  DROP CONSTRAINT IF EXISTS chk_bpa_amount_positive;
--> statement-breakpoint
ALTER TABLE bill_payment_applications
  ADD CONSTRAINT chk_bpa_amount_positive
  CHECK (amount >= 0 AND amount + discount_amount > 0);
