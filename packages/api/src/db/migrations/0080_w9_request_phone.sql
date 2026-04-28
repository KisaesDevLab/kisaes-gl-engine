-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- migration-policy: non-additive-exception
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 15.1 — SMS delivery for
-- W-9 requests. Adds a phone column (additive) and relaxes the
-- email NOT NULL constraint so an SMS-only invite can be recorded.
--
-- Why non-additive: dropping NOT NULL on an existing column is a
-- constraint change, not a column add/drop. It's safe (no data
-- loss; existing rows already satisfy the relaxed constraint), but
-- the migration policy lint requires the marker on any schema
-- change that isn't pure column/table addition.

ALTER TABLE w9_requests ADD COLUMN IF NOT EXISTS requested_contact_phone VARCHAR(30);
ALTER TABLE w9_requests ALTER COLUMN requested_contact_email DROP NOT NULL;
