-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- firm_admin auto-access backfill. From this release, every ACTIVE
-- firm_admin automatically holds `accountant` access on every tenant
-- actively assigned to their firm (services/firm-admin-access.service.ts
-- keeps this true going forward on assign / invite / promote). This
-- one-time pass brings existing data in line.
--
-- Semantics match the service exactly: insert ONLY where no
-- user_tenant_access row exists at all (any role, active or not) — an
-- existing owner row is never downgraded and a deliberately revoked row
-- stays revoked. Idempotent: re-running inserts nothing. One audit row
-- per grant so the change is traceable per tenant.

WITH grants AS (
  INSERT INTO user_tenant_access (user_id, tenant_id, role, is_active)
  SELECT fu.user_id, tfa.tenant_id, 'accountant', true
  FROM firm_users fu
  JOIN firms f ON f.id = fu.firm_id AND f.is_active = true
  JOIN tenant_firm_assignments tfa ON tfa.firm_id = fu.firm_id AND tfa.is_active = true
  WHERE fu.firm_role = 'firm_admin'
    AND fu.is_active = true
    AND NOT EXISTS (
      SELECT 1 FROM user_tenant_access uta
      WHERE uta.user_id = fu.user_id AND uta.tenant_id = tfa.tenant_id
    )
  ON CONFLICT (user_id, tenant_id) DO NOTHING
  RETURNING user_id, tenant_id
)
INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, after_data)
SELECT g.tenant_id, NULL, 'create', 'user_access', g.user_id,
       jsonb_build_object('role', 'accountant', 'source', 'firm_admin_backfill')
FROM grants g;
