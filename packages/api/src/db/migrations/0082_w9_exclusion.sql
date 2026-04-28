-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 14/15 — explicit
-- "not subject to 1099 reporting" exclusion. Distinct from the
-- contacts.is_1099_eligible boolean: the boolean says "would this
-- vendor type ever need a 1099"; this column says "this specific
-- vendor is exempt for {reason}, document the call".
--
-- Why a separate column rather than overloading is_1099_eligible:
-- IRS audit defensibility. When asked "you paid this vendor $50k,
-- why no 1099?", the answer "marked exempt 2026-04-26 by user X
-- because corporation per W-9" is far stronger than a flipped
-- boolean. The reason set is constrained at the service layer to
-- the canonical exemption categories so reports can group them.

ALTER TABLE vendor_1099_profile ADD COLUMN IF NOT EXISTS exclusion_reason VARCHAR(40);
ALTER TABLE vendor_1099_profile ADD COLUMN IF NOT EXISTS exclusion_note TEXT;
ALTER TABLE vendor_1099_profile ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ;
ALTER TABLE vendor_1099_profile ADD COLUMN IF NOT EXISTS excluded_by UUID;

-- Partial index so the threshold scanner's LEFT JOIN can filter
-- out excluded rows without scanning the whole profile table.
CREATE INDEX IF NOT EXISTS idx_vendor_1099_profile_excluded
  ON vendor_1099_profile (tenant_id)
  WHERE exclusion_reason IS NOT NULL;
