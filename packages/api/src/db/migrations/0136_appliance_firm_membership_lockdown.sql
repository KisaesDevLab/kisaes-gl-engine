-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Self-signup lockdown for the shared appliance firm.
--
-- register() historically made every self-signup tenant owner a
-- firm_admin member of the super-admin-managed appliance firm, which
-- spans every tenant on the box. Membership exposed the firm surface
-- (Practice/Firm UI, member roster, tenant list) and firm_admin let a
-- client grant themselves access to other tenants' books.
--
-- Deactivate (not delete — reversible from Firm → Staff as super
-- admin) memberships on super-admin-managed firms for users who are
-- neither super admins nor practice staff (accountant/bookkeeper).

UPDATE firm_users fu
SET is_active = false
FROM firms f, users u
WHERE fu.firm_id = f.id
  AND u.id = fu.user_id
  AND f.super_admin_managed = true
  AND fu.is_active = true
  AND u.is_super_admin = false
  AND u.role NOT IN ('accountant', 'bookkeeper');
