-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Drops the firm_role vocabulary CHECK; validation reverts to zod only.

ALTER TABLE firm_users DROP CONSTRAINT IF EXISTS firm_users_firm_role_check;
