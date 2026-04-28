-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 13 — automated reminders.

CREATE TABLE reminder_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  trigger_type VARCHAR(40) NOT NULL CHECK (trigger_type IN ('unanswered_question', 'w9_pending', 'doc_request', 'recurring_non_transaction', 'magic_link_expiring')),
  cadence_days JSONB NOT NULL DEFAULT '[3,7,14]',
  channel_strategy VARCHAR(20) NOT NULL DEFAULT 'email_only' CHECK (channel_strategy IN ('email_only', 'sms_only', 'both', 'escalating')),
  quiet_hours_start INTEGER NOT NULL DEFAULT 20,
  quiet_hours_end INTEGER NOT NULL DEFAULT 8,
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  max_per_week INTEGER NOT NULL DEFAULT 3,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reminder_schedules_tenant_trigger ON reminder_schedules (tenant_id, trigger_type, active);

CREATE TABLE reminder_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID REFERENCES reminder_schedules(id) ON DELETE SET NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  question_id UUID REFERENCES portal_questions(id) ON DELETE SET NULL,
  channel VARCHAR(10) NOT NULL CHECK (channel IN ('email', 'sms')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  bounced_at TIMESTAMPTZ,
  error TEXT
);
CREATE INDEX idx_reminder_sends_contact_sent ON reminder_sends (contact_id, sent_at DESC);
CREATE INDEX idx_reminder_sends_tenant_sent ON reminder_sends (tenant_id, sent_at DESC);

CREATE TABLE reminder_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  reason VARCHAR(30) NOT NULL,
  channel VARCHAR(10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX idx_reminder_suppressions_contact ON reminder_suppressions (contact_id, expires_at);

CREATE TABLE reminder_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  trigger_type VARCHAR(40) NOT NULL,
  channel VARCHAR(10) NOT NULL CHECK (channel IN ('email', 'sms')),
  subject VARCHAR(255),
  body TEXT NOT NULL,
  variables_jsonb JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reminder_templates_trigger_channel ON reminder_templates (tenant_id, trigger_type, channel);
