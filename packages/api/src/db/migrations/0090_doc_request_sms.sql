-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- DOC_REQUEST_SMS_V1 — wires the SMS channel through the doc-request
-- reminder dispatch path. Three additive changes:
--   1. portal_settings_per_practice gets a per-tenant kill-switch and
--      a multi-segment opt-in.
--   2. reminder_sends gets provider_message_id + provider_status so
--      inbound delivery-status webhooks can correlate back.
--   3. tenant_feature_flags backfills DOC_REQUEST_SMS_V1 = FALSE for
--      existing tenants.

ALTER TABLE portal_settings_per_practice
  ADD COLUMN sms_outbound_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN sms_allow_multi_segment BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE reminder_sends
  ADD COLUMN provider_message_id VARCHAR(120),
  ADD COLUMN provider_status VARCHAR(40);
CREATE INDEX idx_reminder_sends_provider_msg
  ON reminder_sends (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'DOC_REQUEST_SMS_V1', FALSE
FROM tenants t
ON CONFLICT DO NOTHING;
