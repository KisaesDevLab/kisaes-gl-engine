-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- TB tax-code mapping mode per company (docs/tb/BUILD_PLAN.md ADR-TB-02
-- follow-up). 'account' (default) keeps today's behaviour: a unit slice
-- falls back to the account-level code. 'unit' makes P&L codes resolve
-- strictly per activity unit — the account-level row serves only the
-- default unit / untagged bucket, and every other unit with a balance
-- needs its own code (export-blocking `unit_gap` diagnostic otherwise).

ALTER TABLE company_tax_profiles
  ADD COLUMN IF NOT EXISTS tax_code_mapping_mode varchar(10) NOT NULL DEFAULT 'account';
--> statement-breakpoint
ALTER TABLE company_tax_profiles
  ADD CONSTRAINT company_tax_profiles_mapping_mode_check
  CHECK (tax_code_mapping_mode IN ('account', 'unit'));
