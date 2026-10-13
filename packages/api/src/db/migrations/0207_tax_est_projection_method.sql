-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Q46 part: projection method per linked business per tax year (Kurt, 2026-10-13:
-- "Add an option to utilize the ordinary net income monthly trends from the prior year to project
-- the annual amount for the current year"; OPEN-QUESTIONS.md Q46). Shipped as its OWN migration
-- 0207_tax_est_projection_method because 0201-0206 are applied (or reserved) elsewhere. Additive only.
--
-- run_rate          = the system default (YTD + recurring YTD / months elapsed x months remaining);
-- prior_year_scaled = ordinary YTD + prior-year remaining months x (CY recurring YTD / PY same months), capped;
-- prior_year_dollar = ordinary YTD + prior-year remaining months as-is.
-- Existing rows take the default, so every estimate is unchanged until a method is chosen.
ALTER TABLE tax_est_entity_year_inputs ADD COLUMN IF NOT EXISTS projection_method TEXT NOT NULL DEFAULT 'run_rate'
  CONSTRAINT chk_tax_est_entity_year_inputs_projection_method
  CHECK (projection_method IN ('run_rate', 'prior_year_scaled', 'prior_year_dollar'));
