-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Report-ready financial statements (FINANCIAL_STATEMENTS_V1, TB module).
-- Firm-owned library (letterhead, accountant's-report letters, style
-- presets, layout templates) uses the firm_tax_codes "exactly one owner"
-- pattern: firm_id for firm-managed tenants, tenant_id for standalone
-- installs. Company-scoped layouts, reports and IMMUTABLE finalized
-- versions. Additive only; flag seeded OFF for every tenant.

CREATE TABLE IF NOT EXISTS fs_firm_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID,
  tenant_id UUID,
  display_name VARCHAR(200),
  address_line1 VARCHAR(200),
  address_line2 VARCHAR(200),
  city VARCHAR(100),
  state VARCHAR(50),
  postal_code VARCHAR(20),
  phone VARCHAR(50),
  email VARCHAR(200),
  website VARCHAR(200),
  logo_data_uri TEXT,
  accountant_signature VARCHAR(300),
  letterhead_align VARCHAR(10) NOT NULL DEFAULT 'left',
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_fs_firm_profiles_one_owner CHECK (num_nonnulls(firm_id, tenant_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fs_firm_profiles_owner
  ON fs_firm_profiles (COALESCE(firm_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS fs_report_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID,
  tenant_id UUID,
  name VARCHAR(200) NOT NULL,
  letter_type VARCHAR(30) NOT NULL,
  title VARCHAR(200),
  body_html TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  source_report_letter_id UUID,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_fs_report_letters_one_owner CHECK (num_nonnulls(firm_id, tenant_id) = 1)
);
CREATE INDEX IF NOT EXISTS idx_fs_report_letters_owner ON fs_report_letters (firm_id, tenant_id);
-- Lazy seeding from the global library is idempotent per source letter.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fs_report_letters_seed
  ON fs_report_letters (COALESCE(firm_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), source_report_letter_id)
  WHERE source_report_letter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fs_style_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID,
  tenant_id UUID,
  name VARCHAR(200) NOT NULL,
  style_json JSONB NOT NULL,
  builtin_key VARCHAR(40),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_fs_style_presets_one_owner CHECK (num_nonnulls(firm_id, tenant_id) = 1)
);
CREATE INDEX IF NOT EXISTS idx_fs_style_presets_owner ON fs_style_presets (firm_id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fs_style_presets_builtin
  ON fs_style_presets (COALESCE(firm_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), builtin_key)
  WHERE builtin_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS fs_layout_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID,
  tenant_id UUID,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  entity_kind VARCHAR(20) NOT NULL DEFAULT 'any',
  layout_json JSONB NOT NULL,
  builtin_key VARCHAR(40),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_fs_layout_templates_one_owner CHECK (num_nonnulls(firm_id, tenant_id) = 1)
);
CREATE INDEX IF NOT EXISTS idx_fs_layout_templates_owner ON fs_layout_templates (firm_id, tenant_id);

CREATE TABLE IF NOT EXISTS fs_company_layouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  layout_json JSONB NOT NULL,
  style_json JSONB NOT NULL,
  source_template_id UUID,
  source_style_preset_id UUID,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_fs_company_layouts_company ON fs_company_layouts (tenant_id, company_id);

CREATE TABLE IF NOT EXISTS fs_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  company_layout_id UUID NOT NULL REFERENCES fs_company_layouts(id),
  name VARCHAR(200) NOT NULL,
  period_end DATE NOT NULL,
  framework VARCHAR(10) NOT NULL CHECK (framework IN ('gaap', 'cash', 'tax')),
  book_basis VARCHAR(10) NOT NULL CHECK (book_basis IN ('accrual', 'cash')),
  columns_json JSONB NOT NULL,
  tag_id UUID,
  front_matter_json JSONB NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
  current_version_id UUID,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_fs_reports_company ON fs_reports (tenant_id, company_id, period_end);

-- Finalized versions never change: numbers, layout, style, resolved letter
-- and the rendered PDF are frozen here. Only status + publish metadata move.
CREATE TABLE IF NOT EXISTS fs_report_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  report_id UUID NOT NULL REFERENCES fs_reports(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'final' CHECK (status IN ('final', 'superseded')),
  period_end DATE NOT NULL,
  framework VARCHAR(10) NOT NULL,
  book_basis VARCHAR(10) NOT NULL,
  gl_version_stamp BIGINT NOT NULL,
  model_json JSONB NOT NULL,
  layout_json JSONB NOT NULL,
  style_json JSONB NOT NULL,
  settings_json JSONB NOT NULL,
  front_matter_json JSONB NOT NULL,
  letter_json JSONB,
  letterhead_json JSONB,
  numbers_hash VARCHAR(64) NOT NULL,
  pdf_storage_key TEXT NOT NULL,
  pdf_sha256 VARCHAR(64) NOT NULL,
  pdf_bytes INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  validation_override BOOLEAN NOT NULL DEFAULT FALSE,
  override_reason TEXT,
  finalized_by UUID,
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,
  reopened_by UUID,
  reopened_at TIMESTAMPTZ,
  published_instance_id UUID,
  published_by UUID,
  published_at TIMESTAMPTZ,
  CONSTRAINT uniq_fs_report_versions_no UNIQUE (report_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_fs_report_versions_report ON fs_report_versions (report_id);

CREATE TABLE IF NOT EXISTS fs_cash_flow_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id UUID,
  grouping_id UUID,
  classification VARCHAR(30) NOT NULL CHECK (classification IN ('cash', 'operating', 'noncash_adjustment', 'investing', 'financing', 'excluded')),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_fs_cf_overrides_target CHECK (num_nonnulls(account_id, grouping_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fs_cf_overrides_target
  ON fs_cash_flow_overrides (company_id, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(grouping_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Portal publishing rides the existing published-report path.
ALTER TABLE report_instances ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'report_builder';
ALTER TABLE report_instances ADD COLUMN IF NOT EXISTS fs_report_version_id UUID;
CREATE INDEX IF NOT EXISTS idx_report_instances_source ON report_instances (tenant_id, source);

INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'FINANCIAL_STATEMENTS_V1', FALSE FROM tenants t
ON CONFLICT DO NOTHING;
