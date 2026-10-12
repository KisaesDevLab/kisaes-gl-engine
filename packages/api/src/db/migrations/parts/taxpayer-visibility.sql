-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator D17 part: taxpayer visibility controls (Kurt, 2026-10-12; MODULE.md D17,
-- OPEN-QUESTIONS.md Q42). Shipped as its OWN migration 0202_tax_est_taxpayer_visibility
-- because 0201 is already applied in production. Additive only.
--
-- 1. Firm switch, DEFAULT ON for every firm, existing rows included (ADD COLUMN ... DEFAULT
--    TRUE fills them): a staff member who is not a firm admin sees a taxpayer only when
--    their D1 allowed-tenant set reaches at least one tenant the taxpayer is linked to; an
--    unlinked taxpayer only by its creator (tax_est_taxpayers.created_by, already stored
--    since Phase 3; NULL = firm admins only). A firm with no settings row is ON too (the
--    service default).
ALTER TABLE tax_est_firm_settings ADD COLUMN IF NOT EXISTS restrict_taxpayers_to_linked_tenants BOOLEAN NOT NULL DEFAULT TRUE;

-- 2. Per-taxpayer staff allow-list. No rows = everyone the linked-tenant rule allows; any
--    rows = only those users (plus firm admins / super admins), still subject to the rule.
--    firm_id is carried so every read is firm-keyed and the index leads with it.
CREATE TABLE IF NOT EXISTS tax_est_taxpayer_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL,
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  -- Loose reference (no FK), like firm_users.user_id.
  user_id UUID NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_taxpayer_staff UNIQUE (firm_id, taxpayer_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tax_est_taxpayer_staff_taxpayer ON tax_est_taxpayer_staff (taxpayer_id, user_id);
