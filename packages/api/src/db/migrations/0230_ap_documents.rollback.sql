-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0230 (A/P documents). The code that reads these columns must
-- be rolled back with it. Lost: bill discount terms and dates, the
-- due-date / discount-date override flags, vendor default discounts, and
-- the "not received" mark (every bill becomes payable again). Refused while
-- a bill payment application holds a discount (P18), because dropping it
-- would change that bill's balance.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM bill_payment_applications WHERE discount_amount <> 0) THEN
    RAISE EXCEPTION 'rollback 0230 refused: bill payments hold early-payment discounts; void those payments first';
  END IF;
END $$;

ALTER TABLE bill_payment_applications DROP CONSTRAINT IF EXISTS bill_payment_applications_discount_amount_chk;
ALTER TABLE bill_payment_applications DROP COLUMN IF EXISTS discount_amount;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_default_discount_days_chk;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_default_discount_percent_chk;
ALTER TABLE contacts DROP COLUMN IF EXISTS default_discount_days;
ALTER TABLE contacts DROP COLUMN IF EXISTS default_discount_percent;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_discount_days_chk;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_discount_percent_chk;
ALTER TABLE transactions DROP COLUMN IF EXISTS bill_received;
ALTER TABLE transactions DROP COLUMN IF EXISTS discount_date_overridden;
ALTER TABLE transactions DROP COLUMN IF EXISTS due_date_overridden;
ALTER TABLE transactions DROP COLUMN IF EXISTS discount_date;
ALTER TABLE transactions DROP COLUMN IF EXISTS discount_days;
ALTER TABLE transactions DROP COLUMN IF EXISTS discount_percent;
