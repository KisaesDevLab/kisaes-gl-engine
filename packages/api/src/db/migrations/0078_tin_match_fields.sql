-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 15.5 — IRS Bulk TIN
-- Matching support (Pub 2108A). Adds the W-9-captured legal /
-- business name to the profile so the export uses what the vendor
-- swore to (rather than the generic display_name we use for AR/AP),
-- and stores the IRS match-code response so the operator can
-- distinguish "TIN not on file" from "TIN/Name mismatch" when
-- triaging mismatches.

ALTER TABLE vendor_1099_profile ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255);
ALTER TABLE vendor_1099_profile ADD COLUMN IF NOT EXISTS business_name VARCHAR(255);
ALTER TABLE vendor_1099_profile ADD COLUMN IF NOT EXISTS tin_match_code VARCHAR(2);
