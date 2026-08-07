-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Vendor-export consolidation options (Vibe TB parity, screenshot 9):
-- per-entity map of dataset line key → { exportCode, description }.
-- A consolidated tax code exports as ONE line under the custom code
-- instead of per-account/percode vendor rows. Additive: one defaulted
-- jsonb column.

ALTER TABLE company_tax_profiles
  ADD COLUMN IF NOT EXISTS consolidation_prefs JSONB NOT NULL DEFAULT '{}';
