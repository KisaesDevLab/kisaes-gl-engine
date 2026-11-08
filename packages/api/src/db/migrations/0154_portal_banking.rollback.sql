-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0154_portal_banking.

DELETE FROM tenant_feature_flags WHERE flag_key = 'PORTAL_BANKING_V1';
ALTER TABLE portal_contact_companies DROP COLUMN IF EXISTS banking_access;
