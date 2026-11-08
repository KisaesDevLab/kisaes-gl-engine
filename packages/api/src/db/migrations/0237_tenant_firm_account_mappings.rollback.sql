-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0237_tenant_firm_account_mappings. Lost: every per-client
-- account mapping for global rules; those rules go back to resolving only
-- through system_tag. The code that reads the table must be rolled back too.

DROP TABLE IF EXISTS tenant_firm_account_mappings;
