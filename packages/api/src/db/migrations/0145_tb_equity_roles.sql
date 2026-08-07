-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- TB Schedule M-2 rollforward (plan 9.4, D18): per-entity equity-account
-- role mapping — which equity accounts are retained earnings / capital,
-- distributions, contributions, or other. JSONB map { accountId: role }.
-- Additive: one nullable column.

ALTER TABLE company_tax_profiles ADD COLUMN IF NOT EXISTS equity_roles JSONB;
