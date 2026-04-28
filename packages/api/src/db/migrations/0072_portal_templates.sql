-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 11.2 + 11.4 — question
-- template library + recurring question schedules.

CREATE TABLE portal_question_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  variables_jsonb JSONB NOT NULL DEFAULT '[]',
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_portal_question_templates_tenant ON portal_question_templates (tenant_id);
CREATE INDEX idx_portal_question_templates_company ON portal_question_templates (company_id);

CREATE TABLE portal_recurring_question_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_body TEXT NOT NULL,
  cadence VARCHAR(20) NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('monthly', 'quarterly', 'custom')),
  day_of_period VARCHAR(4) NOT NULL DEFAULT '5',
  next_fire DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_portal_recurring_q_next_fire ON portal_recurring_question_schedules (tenant_id, next_fire, active);
