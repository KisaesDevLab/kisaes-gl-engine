-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- 3-tier rules plan, Phase 1 — firms foundation.
-- Three new tables anchor firm-scoped rules so ownership survives
-- staff turnover. No changes to existing tables; purely additive.
--
-- See plan: ~/.claude/plans/create-a-plan-to-enumerated-moler.md

CREATE TABLE firms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  -- URL-safe handle. Mirrors `tenants.slug` style.
  slug VARCHAR(100) NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  -- When TRUE, only super-admins can edit firm settings.
  super_admin_managed BOOLEAN NOT NULL DEFAULT FALSE,
  -- Audit only; not an FK because the original creator may have
  -- left their tenant.
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- firm_users joins users to firms with a firm-internal role
-- (firm_admin / firm_staff / firm_readonly). Orthogonal to
-- per-tenant user_tenant_access.role.
CREATE TABLE firm_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  -- Loose reference (no FK). Same pattern as user_tenant_access.
  user_id UUID NOT NULL,
  firm_role VARCHAR(50) NOT NULL DEFAULT 'firm_staff',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX firm_users_firm_user_idx ON firm_users (firm_id, user_id);
CREATE INDEX idx_firm_users_user ON firm_users (user_id);

-- tenant_firm_assignments: 1:N (a tenant has at most one ACTIVE
-- managing firm). Soft-detach via is_active=false preserves
-- historical attribution. The PARTIAL unique index enforces the
-- 1:N invariant on active rows only.
CREATE TABLE tenant_firm_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
  -- Loose reference; audit only.
  assigned_by_user_id UUID,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX idx_tfa_tenant ON tenant_firm_assignments (tenant_id);
CREATE INDEX idx_tfa_firm ON tenant_firm_assignments (firm_id);
-- Partial unique enforcing one ACTIVE assignment per tenant.
-- Drizzle's index API can't express partial indexes; the service
-- layer also checks before insert as belt-and-suspenders.
CREATE UNIQUE INDEX tfa_tenant_active_unique_idx
  ON tenant_firm_assignments (tenant_id)
  WHERE is_active = TRUE;
