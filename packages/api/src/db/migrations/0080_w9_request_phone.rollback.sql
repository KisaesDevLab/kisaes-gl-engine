-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- Rolling back is destructive if any rows have a NULL email — those
-- would need to be backfilled with a placeholder before re-applying
-- NOT NULL. We don't attempt that here; operators rolling back
-- should backfill manually.

ALTER TABLE w9_requests ALTER COLUMN requested_contact_email SET NOT NULL;
ALTER TABLE w9_requests DROP COLUMN IF EXISTS requested_contact_phone;
