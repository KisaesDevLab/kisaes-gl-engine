-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- PORTAL_BANKING_V1 — portal contacts may view checking/credit-card
-- book balances and registers for a company, when the firm grants it
-- per contact via portal_contact_companies.banking_access.

ALTER TABLE portal_contact_companies
  ADD COLUMN IF NOT EXISTS banking_access boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Feature flag backfill: OFF for all existing tenants (firms opt in).
INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'PORTAL_BANKING_V1', FALSE
FROM tenants t
ON CONFLICT DO NOTHING;
