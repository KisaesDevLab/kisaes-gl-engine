-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Drops the firm_role vocabulary CHECK; validation reverts to zod only.

ALTER TABLE firm_users DROP CONSTRAINT IF EXISTS firm_users_firm_role_check;
