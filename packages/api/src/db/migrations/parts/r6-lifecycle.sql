-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator R6 part: parameter-lifecycle review (docs/reviews/R6-parameter-lifecycle.md).
-- Assembled AFTER the R7 verification part. Additive only. R6-06: a federal year created from
-- the prior year carries each row's citation ("Carried from <year>: ...") until the seed for
-- that year ships, so the Verify screen never shows a blank Citation column; overrides set by
-- hand leave it ''. The state override table already had this column.
ALTER TABLE tax_parameter_overrides ADD COLUMN IF NOT EXISTS citation TEXT NOT NULL DEFAULT '';
