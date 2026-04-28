-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

DROP INDEX IF EXISTS idx_vendor_1099_profile_excluded;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS excluded_by;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS excluded_at;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS exclusion_note;
ALTER TABLE vendor_1099_profile DROP COLUMN IF EXISTS exclusion_reason;
