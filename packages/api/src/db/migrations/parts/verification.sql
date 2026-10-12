-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator R7 part: in-app Verify (super-admin sign-off, UI-SPEC §04). Assembled
-- LAST. Additive only. A row is verified for its CURRENT value: the startup seed re-sync
-- keeps verified_* (and status verified) only while the shipped value is unchanged, and
-- a new override value clears them. Never set by seeds or migrations.
ALTER TABLE tax_parameters ADD COLUMN IF NOT EXISTS verified_by UUID;
ALTER TABLE tax_parameters ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE tax_parameters ADD COLUMN IF NOT EXISTS verification_note TEXT;
ALTER TABLE tax_parameter_overrides ADD COLUMN IF NOT EXISTS verified_by UUID;
ALTER TABLE tax_parameter_overrides ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE tax_parameter_overrides ADD COLUMN IF NOT EXISTS verification_note TEXT;
ALTER TABLE state_estimate_rules ADD COLUMN IF NOT EXISTS verified_by UUID;
ALTER TABLE state_estimate_rules ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE state_estimate_rules ADD COLUMN IF NOT EXISTS verification_note TEXT;
ALTER TABLE state_estimate_rule_overrides ADD COLUMN IF NOT EXISTS verified_by UUID;
ALTER TABLE state_estimate_rule_overrides ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE state_estimate_rule_overrides ADD COLUMN IF NOT EXISTS verification_note TEXT;
