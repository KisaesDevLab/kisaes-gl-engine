-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- migration-policy: non-additive-exception
--
-- Rollback for 0238 (Pay Bills discounts; U-101). The code that writes
-- discounts and reads the setting must be rolled back with it. Lost: the
-- company's default bill discount account. Refused while an application row
-- carries no cash (a bill settled by credits plus a discount), because the
-- old CHECK (amount > 0) cannot hold it; void those payments first.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM bill_payment_applications WHERE amount <= 0) THEN
    RAISE EXCEPTION 'rollback 0238 refused: bill payments hold discount-only applications; void those payments first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE bill_payment_applications
  DROP CONSTRAINT IF EXISTS chk_bpa_amount_positive;
--> statement-breakpoint
ALTER TABLE bill_payment_applications
  ADD CONSTRAINT chk_bpa_amount_positive CHECK (amount > 0);
--> statement-breakpoint
ALTER TABLE companies DROP COLUMN IF EXISTS bill_discount_account_id;
