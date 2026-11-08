-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.

ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS address_zip;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS address_state;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS address_city;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS address_line1;
