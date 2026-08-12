-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- PORTAL_BILL_PAY_V1 — portal contacts may view unpaid bills and mark
-- them for payment; marking posts bill payments and queues checks for
-- the firm to print. Per-contact grant lives on portal_contact_companies;
-- the bank account the checks draw on and the staff member notified when
-- checks are queued are per-company settings. Both FKs SET NULL so
-- deleting an account/user disables (not breaks) the feature.

ALTER TABLE portal_contact_companies
  ADD COLUMN IF NOT EXISTS bill_pay_access boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE portal_settings_per_company
  ADD COLUMN IF NOT EXISTS bill_pay_bank_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE portal_settings_per_company
  ADD COLUMN IF NOT EXISTS bill_pay_notify_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint

-- Feature flag backfill: OFF for all existing tenants (firms opt in).
INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'PORTAL_BILL_PAY_V1', FALSE
FROM tenants t
ON CONFLICT DO NOTHING;
