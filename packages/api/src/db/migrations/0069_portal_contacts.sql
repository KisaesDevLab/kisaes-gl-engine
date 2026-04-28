-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 8 — Client Portal contact
-- management. Five tables (portal_contacts, portal_contact_companies,
-- portal_settings_per_practice, portal_settings_per_company,
-- preview_sessions). All additive — no policy exception needed.

CREATE TABLE portal_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email VARCHAR(320) NOT NULL,
  phone VARCHAR(30),
  first_name VARCHAR(120),
  last_name VARCHAR(120),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'deleted')),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_portal_contacts_tenant_email ON portal_contacts (tenant_id, email);
CREATE INDEX idx_portal_contacts_tenant_status ON portal_contacts (tenant_id, status);

CREATE TABLE portal_contact_companies (
  contact_id UUID NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role VARCHAR(40) NOT NULL DEFAULT 'staff',
  assignable BOOLEAN NOT NULL DEFAULT TRUE,
  financials_access BOOLEAN NOT NULL DEFAULT FALSE,
  files_access BOOLEAN NOT NULL DEFAULT TRUE,
  questions_for_us_access BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, company_id)
);
CREATE INDEX idx_portal_contact_companies_company ON portal_contact_companies (company_id);

CREATE TABLE portal_settings_per_practice (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  reminders_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_cadence_days JSONB NOT NULL DEFAULT '[3,7,14]',
  open_tracking_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  assignable_questions_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  custom_domain VARCHAR(253),
  branding_logo_url TEXT,
  branding_primary_color VARCHAR(9),
  announcement_text TEXT,
  announcement_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  preview_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  preview_allowed_roles VARCHAR(200) NOT NULL DEFAULT 'owner,bookkeeper,accountant',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE portal_settings_per_company (
  company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  reminders_enabled BOOLEAN,
  reminder_cadence_days JSONB,
  assignable_questions_enabled BOOLEAN,
  financials_access_default BOOLEAN,
  files_access_default BOOLEAN,
  preview_require_reauth BOOLEAN NOT NULL DEFAULT FALSE,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE preview_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  contact_id UUID NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  origin VARCHAR(30) NOT NULL CHECK (origin IN ('contact_detail', 'contact_list', 'close_page', 'question_view')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER
);
CREATE INDEX idx_preview_sessions_tenant_started ON preview_sessions (tenant_id, started_at DESC);
CREATE INDEX idx_preview_sessions_contact ON preview_sessions (contact_id, started_at DESC);
