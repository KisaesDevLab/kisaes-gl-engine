-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

DROP INDEX IF EXISTS idx_reminder_sends_provider_msg;
ALTER TABLE reminder_sends
  DROP COLUMN IF EXISTS provider_message_id,
  DROP COLUMN IF EXISTS provider_status;
ALTER TABLE portal_settings_per_practice
  DROP COLUMN IF EXISTS sms_outbound_enabled,
  DROP COLUMN IF EXISTS sms_allow_multi_segment;
DELETE FROM tenant_feature_flags WHERE flag_key = 'DOC_REQUEST_SMS_V1';
