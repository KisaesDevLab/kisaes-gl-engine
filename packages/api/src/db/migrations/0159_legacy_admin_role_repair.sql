-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Data repair: tenants imported (.vmx "import as new tenant") before
-- 2026-08-18 assigned their users user_tenant_access.role = 'admin', which
-- is not a tenant role (owner|accountant|bookkeeper|readonly). The
-- permission resolver treats an unknown role as "no access to anything",
-- so those users were silently locked out of the imported tenant. The
-- import now writes 'owner' (the intent of "assign this user to the new
-- tenant"); this backfills the existing rows the same way.

UPDATE user_tenant_access
   SET role = 'owner'
 WHERE role = 'admin';
