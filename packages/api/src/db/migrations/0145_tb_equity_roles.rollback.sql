-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback companion for 0145_tb_equity_roles.sql (manual only).

ALTER TABLE company_tax_profiles DROP COLUMN IF EXISTS equity_roles;
