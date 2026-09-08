-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

ALTER TABLE company_tax_profiles DROP CONSTRAINT IF EXISTS company_tax_profiles_mapping_mode_check;
ALTER TABLE company_tax_profiles DROP COLUMN IF EXISTS tax_code_mapping_mode;
