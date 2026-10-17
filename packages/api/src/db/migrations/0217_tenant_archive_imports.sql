-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tenant archive import provenance (U-05 tenant portability). One row per
-- tenant that was created by importing a tenant archive: which archive it
-- came from, the fingerprint of the books right after the verified import,
-- the user rows the import created, and whether the tenant is a scratch
-- (test-restore) copy. Install-local bookkeeping: never exported with a
-- tenant and removed with it (ON DELETE CASCADE). Additive only.
CREATE TABLE IF NOT EXISTS tenant_archive_imports (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  scratch BOOLEAN NOT NULL DEFAULT false,
  source_tenant_id UUID,
  archive_id UUID NOT NULL,
  archive_sha256 VARCHAR(64) NOT NULL,
  fingerprint JSONB NOT NULL,
  created_user_ids UUID[] NOT NULL DEFAULT '{}',
  imported_by UUID,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tenant_archive_imports_scratch
  ON tenant_archive_imports (imported_at) WHERE scratch;
