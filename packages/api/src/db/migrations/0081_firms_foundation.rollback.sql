-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- migration-policy: non-additive-exception
--
-- Reason: ROLLBACK file for 0081_firms_foundation.sql. DROP TABLE
-- is the point of a rollback. Not registered in _journal.json;
-- never auto-applied. Any persisted firms / firm_users /
-- tenant_firm_assignments rows are lost.

DROP TABLE IF EXISTS tenant_firm_assignments;
DROP TABLE IF EXISTS firm_users;
DROP TABLE IF EXISTS firms;
