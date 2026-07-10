-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Tenant-defined custom account detail types. Built-in detail types live
-- in @kis-books/shared (DETAIL_TYPES); this table extends them per tenant
-- so a firm can add e.g. 'equipment_leases' under expense. `value` is the
-- snake_case slug stored on accounts.detail_type; `label` is the display
-- name. Additive only (CLAUDE.md rule 13).

CREATE TABLE IF NOT EXISTS tenant_detail_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  account_type varchar(20) NOT NULL,
  value varchar(50) NOT NULL,
  label varchar(100) NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_detail_types_unique
  ON tenant_detail_types (tenant_id, account_type, value);
CREATE INDEX IF NOT EXISTS idx_tenant_detail_types_tenant
  ON tenant_detail_types (tenant_id);
