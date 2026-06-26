-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- Daily Sales (POS X/Z report) templates + entries. A business defines a
-- reusable template mapping Z-report lines to GL accounts/sides, then enters
-- daily totals that stage a balanced journal entry to review and post. Posting
-- reuses ledger.postTransaction; these tables hold only the template + entered
-- totals. Additive only (CLAUDE.md rule 13).

CREATE TABLE IF NOT EXISTS daily_sales_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid,
  name varchar(255) NOT NULL,
  preset_type varchar(20) NOT NULL DEFAULT 'custom',
  default_tag_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dst_tenant ON daily_sales_templates (tenant_id);

CREATE TABLE IF NOT EXISTS daily_sales_template_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  section varchar(20) NOT NULL,
  label varchar(120) NOT NULL,
  account_id uuid,
  normal_side varchar(6) NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_required boolean NOT NULL DEFAULT false,
  allow_tag boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dstl_template ON daily_sales_template_lines (tenant_id, template_id);

CREATE TABLE IF NOT EXISTS daily_sales_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid,
  template_id uuid NOT NULL,
  business_date date NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'draft',
  transaction_id uuid,
  tag_id uuid,
  over_short_amount decimal(19,4) NOT NULL DEFAULT 0,
  total_sales decimal(19,4) NOT NULL DEFAULT 0,
  total_tax decimal(19,4) NOT NULL DEFAULT 0,
  total_payments decimal(19,4) NOT NULL DEFAULT 0,
  notes text,
  posted_at timestamptz,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dse_tenant_status ON daily_sales_entries (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_dse_tenant_date ON daily_sales_entries (tenant_id, business_date);

CREATE TABLE IF NOT EXISTS daily_sales_entry_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  template_line_id uuid NOT NULL,
  amount decimal(19,4) NOT NULL DEFAULT 0,
  tag_id uuid
);
CREATE INDEX IF NOT EXISTS idx_dsev_entry ON daily_sales_entry_values (tenant_id, entry_id);
