-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 16 + 17 — Report Builder.

CREATE TABLE report_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  layout_jsonb JSONB NOT NULL DEFAULT '[]',
  theme_jsonb JSONB NOT NULL DEFAULT '{}',
  default_period VARCHAR(20) NOT NULL DEFAULT 'this_month',
  is_practice_template BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_report_templates_tenant ON report_templates (tenant_id);

CREATE TABLE report_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id UUID REFERENCES report_templates(id) ON DELETE SET NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'archived')),
  layout_snapshot_jsonb JSONB NOT NULL DEFAULT '[]',
  data_snapshot_jsonb JSONB NOT NULL DEFAULT '{}',
  pdf_url TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX idx_report_instances_tenant_company ON report_instances (tenant_id, company_id);
CREATE INDEX idx_report_instances_status ON report_instances (tenant_id, status);
CREATE INDEX idx_report_instances_published ON report_instances (company_id, published_at DESC);

CREATE TABLE kpi_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key VARCHAR(80) NOT NULL,
  name VARCHAR(200) NOT NULL,
  category VARCHAR(40) NOT NULL,
  formula_jsonb JSONB NOT NULL,
  format VARCHAR(20) NOT NULL,
  threshold_jsonb JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_kpi_definitions_tenant_key ON kpi_definitions (tenant_id, key);

CREATE TABLE report_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES report_instances(id) ON DELETE CASCADE,
  block_ref VARCHAR(80),
  author_id UUID NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_report_comments_instance ON report_comments (instance_id, created_at);

CREATE TABLE report_ai_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES report_instances(id) ON DELETE CASCADE,
  block_ref VARCHAR(80),
  prompt_template_id UUID,
  generated_text TEXT NOT NULL,
  edited_text TEXT,
  model_used VARCHAR(80),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_by UUID,
  edited_at TIMESTAMPTZ
);
CREATE INDEX idx_report_ai_summaries_instance ON report_ai_summaries (instance_id);
