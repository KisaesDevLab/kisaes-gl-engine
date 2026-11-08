-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Entity-level activity type on the tax profile (mirrors Vibe TB's
-- "1120S · Business" header). Scopes the assignable-code surface so the
-- picker doesn't repeat every code once per activity type when the
-- entity has no activity units. Additive: one defaulted column.

ALTER TABLE company_tax_profiles
  ADD COLUMN IF NOT EXISTS default_activity_type VARCHAR(20) NOT NULL DEFAULT 'business';
