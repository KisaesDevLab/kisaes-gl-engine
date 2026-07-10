-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Per-member permissions (templates + per-user overrides). Only the
-- `bookkeeper` role consults these; a bookkeeper with no user_permissions
-- row keeps today's full access (no backfill needed). Permission maps are
-- stored as jsonb `{ resourceKey: level }` keyed by the shared resource
-- catalog. Additive only (CLAUDE.md rule 13).

CREATE TABLE IF NOT EXISTS permission_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  description varchar(500),
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS perm_tpl_tenant_name_idx
  ON permission_templates (tenant_id, name);

CREATE TABLE IF NOT EXISTS user_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  template_id uuid REFERENCES permission_templates(id) ON DELETE SET NULL,
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_perms_tenant_user_idx
  ON user_permissions (tenant_id, user_id);
