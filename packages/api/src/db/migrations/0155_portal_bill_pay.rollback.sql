-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0155_portal_bill_pay.

DELETE FROM tenant_feature_flags WHERE flag_key = 'PORTAL_BILL_PAY_V1';
ALTER TABLE portal_contact_companies DROP COLUMN IF EXISTS bill_pay_access;
ALTER TABLE portal_settings_per_company DROP COLUMN IF EXISTS bill_pay_bank_account_id;
ALTER TABLE portal_settings_per_company DROP COLUMN IF EXISTS bill_pay_notify_user_id;
