-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 15 — capture the
-- mailing address the vendor entered on the W-9. Lives on
-- vendor_1099_profile rather than on contacts because:
--
--   1. It's an audit-trail field — what the vendor swore to under
--      penalty of perjury — and shouldn't be silently overwritten
--      by AR/AP edits to contacts.billing_*.
--   2. The 1099 mailing address sometimes differs from the AP
--      billing address (e.g. contractor uses personal address for
--      tax forms but a P.O. box for invoices).
--
-- The bookkeeper UI offers an explicit "Apply to contact billing
-- address" action so updates from W-9 to contacts are intentional.

ALTER TABLE vendor_1099_profile ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(255);
ALTER TABLE vendor_1099_profile ADD COLUMN IF NOT EXISTS address_city VARCHAR(100);
ALTER TABLE vendor_1099_profile ADD COLUMN IF NOT EXISTS address_state VARCHAR(50);
ALTER TABLE vendor_1099_profile ADD COLUMN IF NOT EXISTS address_zip VARCHAR(20);
