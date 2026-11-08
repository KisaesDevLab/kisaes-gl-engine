-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.

ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS tin_match_code;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS business_name;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS legal_name;
