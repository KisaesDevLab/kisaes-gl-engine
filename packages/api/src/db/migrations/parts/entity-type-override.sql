-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Q49 part: per-tax-year entity type override on a linked business (Kurt,
-- 2026-10-13: "We need the ability to change entity type in the estimator"; OPEN-QUESTIONS.md
-- Q49). Use case: an LLC filing 1065 elects S corporation status for 2026 while the Trial
-- Balance tax profile still says 1065. When set for a tax year it WINS over the TB profile, the
-- estimator entity setting and the company entity type (MODULE.md D3 amendment); the TB profile
-- itself is never changed. NULL = the D3 precedence as before (every existing estimate unchanged).
-- The CHECK mirrors the shared ENTITY_TAX_TYPES enum. Additive only.
ALTER TABLE tax_est_entity_year_inputs ADD COLUMN IF NOT EXISTS entity_type_override TEXT
  CONSTRAINT chk_tax_est_entity_year_inputs_entity_type_override
  CHECK (entity_type_override IS NULL OR entity_type_override IN ('sch_c', 'sch_f', 's_corp', 'partnership', 'c_corp'));
