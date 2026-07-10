-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS address_zip;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS address_state;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS address_city;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS address_line1;
