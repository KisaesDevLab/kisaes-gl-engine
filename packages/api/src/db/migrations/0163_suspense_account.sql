-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Suspense account: adopt the seeded `89999 Uncategorized` as a system role.
--
-- Until now "uncategorized" meant a bank_feed_items row still at
-- status='pending' — off the ledger entirely, so the books understated real
-- activity until a human touched every line. The suspense account gives those
-- amounts somewhere to POST, so bank balances and reconciliations are
-- complete and the account's balance is the exact size of the unfinished
-- work. Staff clear it from Practice -> Uncategorized.
--
-- Every built-in COA template but two already seeds `89999 Uncategorized`
-- (other_expense) as a plain, editable, unreferenced account. Rather than
-- leaving tenants with two near-identical accounts, this migration ADOPTS
-- that row: system_tag='suspense', is_system=true.
--
-- Deliberately conservative. Only the unambiguous case is backfilled: exactly
-- one untagged other_expense account numbered 89999 for the tenant. Tenants
-- with none (the two templates that omit it, or where it was deleted) and
-- tenants with several are left alone -- getOrCreateSystemAccount() in
-- system-accounts.service.ts adopts or creates lazily on first use, and the
-- admin System Accounts screen can assign the role by hand. No unique index
-- on the tag: no other role has one, and that screen already surfaces
-- duplicates so an operator can fix them.
--
-- Side effect worth calling out in the release note: once adopted, 89999
-- becomes undeletable and its account type frozen, because accounts.service
-- already refuses both for is_system rows. That is the intended protection.

UPDATE accounts a
SET system_tag = 'suspense',
    is_system  = TRUE,
    updated_at = now()
WHERE a.system_tag IS NULL
  AND a.account_number = '89999'
  AND a.account_type = 'other_expense'
  -- the tenant must not already have a suspense account
  AND NOT EXISTS (
    SELECT 1 FROM accounts x
    WHERE x.tenant_id = a.tenant_id AND x.system_tag = 'suspense'
  )
  -- and 89999 must be unambiguous within the tenant
  AND (
    SELECT COUNT(*) FROM accounts y
    WHERE y.tenant_id = a.tenant_id
      AND y.system_tag IS NULL
      AND y.account_number = '89999'
      AND y.account_type = 'other_expense'
  ) = 1;
