-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- Track when a user last switched into each tenant, so the company/tenant
-- switcher can surface the most-recently-used tenants first.
ALTER TABLE user_tenant_access
  ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;
