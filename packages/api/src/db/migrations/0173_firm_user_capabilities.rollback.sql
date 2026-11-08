-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.

ALTER TABLE firm_users DROP COLUMN IF EXISTS capabilities_updated_by_user_id;
ALTER TABLE firm_users DROP COLUMN IF EXISTS capabilities_updated_at;
ALTER TABLE firm_users DROP COLUMN IF EXISTS capabilities;
