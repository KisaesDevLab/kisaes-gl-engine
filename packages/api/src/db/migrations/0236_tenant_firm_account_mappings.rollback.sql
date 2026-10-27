-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0236_tenant_firm_account_mappings. Lost: every per-client
-- account mapping for global rules; those rules go back to resolving only
-- through system_tag. The code that reads the table must be rolled back too.

DROP TABLE IF EXISTS tenant_firm_account_mappings;
