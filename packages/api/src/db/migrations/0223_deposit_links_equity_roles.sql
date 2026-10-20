-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Deposits and equity roles (ClientLedger U-52..U-55). Additive only.
--
-- 1. journal_lines.source_transaction_id (uuid, NULL): the document a line
--    settles; on a deposit, the Payments Clearing item it deposits (U-52)
--    or the vendor credit it refunds (U-54). deposit_lines stays the
--    settlement registry; this ties a registry row to its line. No FK,
--    like deposit_lines. journal_lines.line_role (varchar(20), NULL):
--    'cash_back' on a deposit's cash-back line (U-53). Both are
--    metadata-only ADD COLUMNs (no default); existing lines are unchanged.
--
-- 2. Equity roles (U-55): accounts.system_tag gains owner_draw,
--    owner_contribution, partner_draws, partner_contributions,
--    shareholder_distributions, paid_in_capital (retained_earnings exists).
--    a) Untagged equity accounts the built-in templates seeded are adopted:
--       "Owner Withdraw" (30170) -> owner_draw and "Owner Contribution"
--       (30160) -> owner_contribution in every tenant; the other roles'
--       known names only where a company of the tenant needs that role.
--       Only names that can mean nothing but the role are adopted; generic
--       ones ("Distributions", "Dividends", "Common Stock", "Capital
--       Stock") are left alone, except that "Dividends Paid" (the name a
--       C corporation gives the role) is adopted in a tenant with a
--       C corporation.
--    b) Each tenant then gets the accounts its companies' entity types need
--       and still lack (sole_prop / single_member_llc: Owner's Draw +
--       Owner's Contribution; partnership: Partner Draws + Partner
--       Contributions; s_corp: Shareholder Distributions + Paid-in Capital;
--       c_corp: Paid-in Capital + Dividends Paid). Companies of a tenant
--       share one chart, so the accounts are tenant-wide (company_id NULL)
--       and system accounts (is_system true, as the engine's other role
--       accounts; renameable, not deletable). Adopted accounts keep their
--       flag. The template number is used when free, else NULL (account
--       numbers are unique per tenant).
--    Every statement skips a role the tenant already has, so running the
--    file again changes nothing (idempotent). Only accounts rows change:
--    no journal line, balance or posting is touched.
ALTER TABLE "journal_lines" ADD COLUMN IF NOT EXISTS "source_transaction_id" uuid;
--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN IF NOT EXISTS "line_role" varchar(20);
--> statement-breakpoint
-- Adopt: owner_draw
UPDATE "accounts" AS t SET "system_tag" = 'owner_draw', "updated_at" = now()
FROM (
  SELECT DISTINCT ON (a.tenant_id) a.id
  FROM "accounts" a
  WHERE a.system_tag IS NULL AND a.account_type = 'equity'
    AND (a.account_number = ANY(ARRAY['30170']::text[]) OR lower(a.name) = ANY(ARRAY['owner withdraw', 'owner withdrawal', 'owner withdrawals', 'owner''s draw', 'owner draw', 'owners draw', 'owner draws', 'owner''s draws']::text[]))
    AND NOT EXISTS (SELECT 1 FROM "accounts" x WHERE x.tenant_id = a.tenant_id AND x.system_tag = 'owner_draw')
  ORDER BY a.tenant_id, a.account_number ASC NULLS LAST, a.created_at ASC, a.id ASC
) AS pick
WHERE t.id = pick.id;
--> statement-breakpoint
-- Adopt: owner_contribution
UPDATE "accounts" AS t SET "system_tag" = 'owner_contribution', "updated_at" = now()
FROM (
  SELECT DISTINCT ON (a.tenant_id) a.id
  FROM "accounts" a
  WHERE a.system_tag IS NULL AND a.account_type = 'equity'
    AND (a.account_number = ANY(ARRAY['30160']::text[]) OR lower(a.name) = ANY(ARRAY['owner contribution', 'owner''s contribution', 'owners contribution', 'owner contributions', 'owner''s contributions']::text[]))
    AND NOT EXISTS (SELECT 1 FROM "accounts" x WHERE x.tenant_id = a.tenant_id AND x.system_tag = 'owner_contribution')
  ORDER BY a.tenant_id, a.account_number ASC NULLS LAST, a.created_at ASC, a.id ASC
) AS pick
WHERE t.id = pick.id;
--> statement-breakpoint
-- Adopt: partner_draws
UPDATE "accounts" AS t SET "system_tag" = 'partner_draws', "updated_at" = now()
FROM (
  SELECT DISTINCT ON (a.tenant_id) a.id
  FROM "accounts" a
  WHERE a.system_tag IS NULL AND a.account_type = 'equity'
    AND (lower(a.name) = ANY(ARRAY['partner draws', 'partner draw', 'partners'' draws', 'partners draws', 'partner distributions']::text[]))
    AND NOT EXISTS (SELECT 1 FROM "accounts" x WHERE x.tenant_id = a.tenant_id AND x.system_tag = 'partner_draws')
    AND EXISTS (SELECT 1 FROM "companies" c WHERE c.tenant_id = a.tenant_id
                AND c.entity_type IN ('partnership'))
  ORDER BY a.tenant_id, a.account_number ASC NULLS LAST, a.created_at ASC, a.id ASC
) AS pick
WHERE t.id = pick.id;
--> statement-breakpoint
-- Adopt: partner_contributions
UPDATE "accounts" AS t SET "system_tag" = 'partner_contributions', "updated_at" = now()
FROM (
  SELECT DISTINCT ON (a.tenant_id) a.id
  FROM "accounts" a
  WHERE a.system_tag IS NULL AND a.account_type = 'equity'
    AND (lower(a.name) = ANY(ARRAY['partner contributions', 'partner contribution', 'partners'' contributions', 'partners contributions']::text[]))
    AND NOT EXISTS (SELECT 1 FROM "accounts" x WHERE x.tenant_id = a.tenant_id AND x.system_tag = 'partner_contributions')
    AND EXISTS (SELECT 1 FROM "companies" c WHERE c.tenant_id = a.tenant_id
                AND c.entity_type IN ('partnership'))
  ORDER BY a.tenant_id, a.account_number ASC NULLS LAST, a.created_at ASC, a.id ASC
) AS pick
WHERE t.id = pick.id;
--> statement-breakpoint
-- Adopt: shareholder_distributions
UPDATE "accounts" AS t SET "system_tag" = 'shareholder_distributions', "updated_at" = now()
FROM (
  SELECT DISTINCT ON (a.tenant_id) a.id
  FROM "accounts" a
  WHERE a.system_tag IS NULL AND a.account_type = 'equity'
    AND NOT EXISTS (SELECT 1 FROM "accounts" x WHERE x.tenant_id = a.tenant_id AND x.system_tag = 'shareholder_distributions')
    AND (
      (lower(a.name) = ANY(ARRAY['shareholder distributions', 'shareholder distribution']::text[])
        AND EXISTS (SELECT 1 FROM "companies" c WHERE c.tenant_id = a.tenant_id
                    AND c.entity_type IN ('s_corp', 'c_corp')))
      OR (lower(a.name) = 'dividends paid'
        AND EXISTS (SELECT 1 FROM "companies" c WHERE c.tenant_id = a.tenant_id
                    AND c.entity_type = 'c_corp'))
    )
  ORDER BY a.tenant_id, a.account_number ASC NULLS LAST, a.created_at ASC, a.id ASC
) AS pick
WHERE t.id = pick.id;
--> statement-breakpoint
-- Adopt: paid_in_capital
UPDATE "accounts" AS t SET "system_tag" = 'paid_in_capital', "updated_at" = now()
FROM (
  SELECT DISTINCT ON (a.tenant_id) a.id
  FROM "accounts" a
  WHERE a.system_tag IS NULL AND a.account_type = 'equity'
    AND (lower(a.name) = ANY(ARRAY['paid-in capital', 'paid in capital', 'additional paid-in capital', 'additional paid in capital']::text[]))
    AND NOT EXISTS (SELECT 1 FROM "accounts" x WHERE x.tenant_id = a.tenant_id AND x.system_tag = 'paid_in_capital')
    AND EXISTS (SELECT 1 FROM "companies" c WHERE c.tenant_id = a.tenant_id
                AND c.entity_type IN ('s_corp', 'c_corp'))
  ORDER BY a.tenant_id, a.account_number ASC NULLS LAST, a.created_at ASC, a.id ASC
) AS pick
WHERE t.id = pick.id;
--> statement-breakpoint
-- Create the roles each tenant's entity types need and still lack.
WITH need(entity_type, role, name, num) AS (VALUES
  ('sole_prop', 'owner_draw', 'Owner''s Draw', '30170'),
  ('sole_prop', 'owner_contribution', 'Owner''s Contribution', '30160'),
  ('single_member_llc', 'owner_draw', 'Owner''s Draw', '30170'),
  ('single_member_llc', 'owner_contribution', 'Owner''s Contribution', '30160'),
  ('partnership', 'partner_draws', 'Partner Draws', '30180'),
  ('partnership', 'partner_contributions', 'Partner Contributions', '30190'),
  ('s_corp', 'shareholder_distributions', 'Shareholder Distributions', '30200'),
  ('s_corp', 'paid_in_capital', 'Paid-in Capital', '30140'),
  ('c_corp', 'paid_in_capital', 'Paid-in Capital', '30140'),
  ('c_corp', 'shareholder_distributions', 'Dividends Paid', '30200')
),
wanted AS (
  SELECT DISTINCT ON (c.tenant_id, n.role) c.tenant_id, n.role, n.name, n.num
  FROM "companies" c
  JOIN need n ON n.entity_type = c.entity_type
  ORDER BY c.tenant_id, n.role, c.created_at ASC, c.id ASC
)
INSERT INTO "accounts" ("tenant_id", "company_id", "account_number", "name", "account_type", "detail_type", "is_active", "is_system", "system_tag")
SELECT w.tenant_id, NULL,
  CASE WHEN EXISTS (SELECT 1 FROM "accounts" x WHERE x.tenant_id = w.tenant_id AND x.account_number = w.num) THEN NULL ELSE w.num END,
  w.name, 'equity', 'owners_equity', true, true, w.role
FROM wanted w
WHERE NOT EXISTS (SELECT 1 FROM "accounts" x WHERE x.tenant_id = w.tenant_id AND x.system_tag = w.role);
