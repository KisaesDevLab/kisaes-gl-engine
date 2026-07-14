-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Journal-entry templates: reusable JE line skeletons (label, account,
-- debit/credit side, required flag) mirroring the Daily Sales (POS)
-- template builder. Using a template pre-fills the Journal Entry form;
-- no entries table — the posted JE is the only ledger artifact.
-- Additive: two new tables.

CREATE TABLE IF NOT EXISTS je_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  company_id UUID,
  name VARCHAR(255) NOT NULL,
  memo TEXT,
  default_tag_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jet_tenant ON je_templates (tenant_id);

CREATE TABLE IF NOT EXISTS je_template_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  template_id UUID NOT NULL,
  label VARCHAR(120) NOT NULL,
  account_id UUID,
  normal_side VARCHAR(6) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jetl_template ON je_template_lines (tenant_id, template_id);
