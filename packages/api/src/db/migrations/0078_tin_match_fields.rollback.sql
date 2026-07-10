-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS tin_match_code;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS business_name;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS legal_name;
