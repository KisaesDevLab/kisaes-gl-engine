-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

ALTER TABLE firm_users DROP COLUMN IF EXISTS capabilities_updated_by_user_id;
ALTER TABLE firm_users DROP COLUMN IF EXISTS capabilities_updated_at;
ALTER TABLE firm_users DROP COLUMN IF EXISTS capabilities;
