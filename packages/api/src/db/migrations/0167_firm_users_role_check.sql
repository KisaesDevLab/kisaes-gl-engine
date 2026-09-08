-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- firm_users.firm_role was only enforced by the zod enum (FIRM_ROLES in
-- shared). Pin the vocabulary at the DB level so a raw-SQL or backfill
-- path cannot write a role string that every `=== 'firm_admin'` check
-- would silently treat as "not staff" while membership lookups still
-- return it as a truthy role.

ALTER TABLE firm_users
  ADD CONSTRAINT firm_users_firm_role_check
  CHECK (firm_role IN ('firm_admin', 'firm_staff', 'firm_readonly'));
