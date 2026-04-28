-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN — 1099 account mapping.
-- Each Chart-of-Accounts expense account can be associated with
-- exactly one (form, box) combination so journal lines hitting
-- that account roll up under the right 1099 box.
--
-- Modelled on payroll_account_mapping (migration 0041): a single
-- row per (tenant, account), with a unique index that prevents
-- the same account from being assigned to two different boxes.
-- The exporter rewrite that consumes this mapping ships in a
-- separate PR; the present migration is infrastructure-only.

CREATE TABLE vendor_1099_account_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Closed enum validated at the service layer:
  --   NEC-1, MISC-1, MISC-2, MISC-3, MISC-6, MISC-10
  form_box VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

-- Hard "one account → one box" rule at the DB level so a misbehaving
-- client can't double-map an account.
CREATE UNIQUE INDEX idx_vendor_1099_account_mappings_account
  ON vendor_1099_account_mappings (tenant_id, account_id);

-- Lookup index for the grouped-by-box list endpoint.
CREATE INDEX idx_vendor_1099_account_mappings_form_box
  ON vendor_1099_account_mappings (tenant_id, form_box);
