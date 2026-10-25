-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- A/P documents (U-86 bill-terms-v1, U-87 bill-received-v1; P18 discount
-- applications). Additive only: new nullable columns, or NOT NULL with a
-- default, so every existing row keeps its meaning.
--
-- transactions (bills):
--   discount_percent / discount_days   the early-payment discount of the
--                                      bill's terms (2 % 10 Net 30), NULL
--                                      without one
--   discount_date                      bill date + discount_days, or the
--                                      owner's override
--   due_date_overridden /              true when the owner typed the date
--   discount_date_overridden           (the engine did not compute it)
--   bill_received                      false = the bill is in A/P but not
--                                      payable yet (left out of Pay Bills);
--                                      existing bills are received
-- contacts (vendor custom terms):
--   default_discount_percent / default_discount_days
-- bill_payment_applications:
--   discount_amount                    early-payment discount taken on the
--                                      bill by this payment (P18 Pay Bills);
--                                      counts toward the bill like the cash
--                                      amount. 0 for every existing row.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS discount_percent numeric(7,4);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS discount_days integer;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS discount_date date;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS due_date_overridden boolean NOT NULL DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS discount_date_overridden boolean NOT NULL DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS bill_received boolean NOT NULL DEFAULT true;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS default_discount_percent numeric(7,4);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS default_discount_days integer;

ALTER TABLE bill_payment_applications ADD COLUMN IF NOT EXISTS discount_amount numeric(19,4) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bill_payment_applications_discount_amount_chk') THEN
    ALTER TABLE bill_payment_applications
      ADD CONSTRAINT bill_payment_applications_discount_amount_chk CHECK (discount_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_discount_percent_chk') THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_discount_percent_chk
      CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent < 100));
  END IF;
END $$;
