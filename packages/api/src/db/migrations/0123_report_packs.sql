-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- Report Packs — bulk multi-report combined PDF. A pack is a saved
-- definition (which reports + defaults + chrome); a run is one async
-- render producing a transient PDF artifact with an expires_at.

CREATE TABLE IF NOT EXISTS report_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  period_preset VARCHAR(20) NOT NULL DEFAULT 'this-month',
  custom_range_start DATE,
  custom_range_end DATE,
  as_of_mode VARCHAR(20) NOT NULL DEFAULT 'range-end',
  as_of_custom DATE,
  default_basis VARCHAR(10) NOT NULL DEFAULT 'accrual',
  default_tag_id UUID,
  cover_page BOOLEAN NOT NULL DEFAULT TRUE,
  toc BOOLEAN NOT NULL DEFAULT TRUE,
  page_numbers BOOLEAN NOT NULL DEFAULT TRUE,
  filename_template VARCHAR(255) NOT NULL DEFAULT '{pack}-{date}',
  on_error VARCHAR(10) NOT NULL DEFAULT 'skip',
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_report_packs_tenant_company
  ON report_packs (tenant_id, company_id);

CREATE TABLE IF NOT EXISTS report_pack_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id UUID NOT NULL REFERENCES report_packs(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  report_id VARCHAR(64) NOT NULL,
  options_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_pack_items_pack_order
  ON report_pack_items (pack_id, sort_order);

CREATE TABLE IF NOT EXISTS report_pack_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id UUID NOT NULL REFERENCES report_packs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  range_start DATE,
  range_end DATE,
  as_of_date DATE,
  status VARCHAR(12) NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  current_report_id VARCHAR(64),
  transient_key TEXT,
  expires_at TIMESTAMPTZ,
  page_count INTEGER,
  byte_size INTEGER,
  error_json JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_pack_runs_tenant_pack
  ON report_pack_runs (tenant_id, pack_id);

CREATE INDEX IF NOT EXISTS idx_report_pack_runs_expires
  ON report_pack_runs (expires_at);
