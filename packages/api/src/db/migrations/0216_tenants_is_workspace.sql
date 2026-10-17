-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Desktop mode (CL_MODE=desktop) workspace tenant. /api/v1/desktop/initialize
-- creates one hidden tenant that holds every user row and no company; real
-- companies are ordinary tenants reached through user_tenant_access. The
-- partial unique index allows at most one workspace. The server appliance
-- never sets the flag, so every existing and new server tenant reads false.
-- Additive only.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_workspace BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenants_workspace ON tenants (is_workspace) WHERE is_workspace;
