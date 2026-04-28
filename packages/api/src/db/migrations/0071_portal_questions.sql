-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 10 — Question System Core.

CREATE TABLE portal_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transaction_id UUID,
  split_line_id UUID,
  assigned_contact_id UUID REFERENCES portal_contacts(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'viewed', 'responded', 'resolved')),
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  current_close_period VARCHAR(7)
);
CREATE INDEX idx_portal_questions_tenant_status ON portal_questions (tenant_id, status);
CREATE INDEX idx_portal_questions_tenant_company ON portal_questions (tenant_id, company_id);
CREATE INDEX idx_portal_questions_contact ON portal_questions (assigned_contact_id);
CREATE INDEX idx_portal_questions_transaction ON portal_questions (transaction_id);
CREATE INDEX idx_portal_questions_notified ON portal_questions (tenant_id, notified_at);

CREATE TABLE portal_question_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES portal_questions(id) ON DELETE CASCADE,
  sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('bookkeeper', 'contact', 'system')),
  sender_id UUID NOT NULL,
  body TEXT NOT NULL,
  attachments_json JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_portal_question_messages_question ON portal_question_messages (question_id, created_at);

CREATE TABLE portal_question_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES portal_questions(id) ON DELETE CASCADE,
  message_id UUID REFERENCES portal_question_messages(id) ON DELETE CASCADE,
  storage_provider VARCHAR(20) NOT NULL DEFAULT 'local',
  storage_key TEXT NOT NULL,
  filename VARCHAR(512) NOT NULL,
  mime_type VARCHAR(120),
  size_bytes BIGINT,
  uploaded_by UUID NOT NULL,
  uploaded_by_type VARCHAR(20) NOT NULL CHECK (uploaded_by_type IN ('bookkeeper', 'contact')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_portal_question_attachments_question ON portal_question_attachments (question_id);
