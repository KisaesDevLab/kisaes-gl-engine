-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- 3-tier rules plan, Phase 7 — firm tag templates.
-- Adds two new tables:
--
--   firm_tag_templates       — firm-scoped semantic tag keys
--                              referenced by global_firm rules
--   tenant_firm_tag_bindings — per-tenant binding from a
--                              template_key to the tenant-local
--                              tags.id; the rule symbol resolver
--                              looks up THIS row at fire time
--
-- Purely additive: no changes to existing tables. Marked with no
-- non-additive-exception because every column is new and
-- DEFAULT-safe.

CREATE TABLE firm_tag_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  template_key VARCHAR(80) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_ftt_firm_key
  ON firm_tag_templates (firm_id, template_key);

CREATE TABLE tenant_firm_tag_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_key VARCHAR(80) NOT NULL,
  -- Loose reference (no FK). The tags schema's PK is the only
  -- index that would catch dangling references; the service
  -- layer pre-checks that the tag belongs to the bound tenant
  -- before insert, which is the load-bearing invariant.
  tag_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_tftb_firm_tenant_key
  ON tenant_firm_tag_bindings (firm_id, tenant_id, template_key);
CREATE INDEX idx_tftb_tenant ON tenant_firm_tag_bindings (tenant_id);
