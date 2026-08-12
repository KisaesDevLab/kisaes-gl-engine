-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0154_portal_banking.

DELETE FROM tenant_feature_flags WHERE flag_key = 'PORTAL_BANKING_V1';
ALTER TABLE portal_contact_companies DROP COLUMN IF EXISTS banking_access;
