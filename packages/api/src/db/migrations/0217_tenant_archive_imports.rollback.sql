-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the tenant archive import provenance table (0217). The
-- tenant-portability code that reads it must be rolled back with it.
DROP INDEX IF EXISTS idx_tenant_archive_imports_scratch;
DROP TABLE IF EXISTS tenant_archive_imports;
