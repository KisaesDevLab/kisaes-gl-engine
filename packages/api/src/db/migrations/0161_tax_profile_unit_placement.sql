-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Vendor tax exports attach the activity-unit number to the account
-- number on unit-split rows. Firms differ on which side their tax
-- software expects it: 'suffix' (1000-2, existing behavior) or
-- 'prefix' (2-1000). Per-company preference on the tax profile.

ALTER TABLE company_tax_profiles
  ADD COLUMN IF NOT EXISTS unit_number_placement varchar(10) NOT NULL DEFAULT 'suffix';
