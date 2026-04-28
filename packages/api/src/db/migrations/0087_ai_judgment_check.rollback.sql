-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- migration-policy: non-additive-exception
--
-- Rollback for 0087: drop the seeded ai_personal_expense_review
-- registry row and any findings/overrides/suppressions tied to
-- it, then narrow the category CHECK constraint back to the
-- original three values.
DELETE FROM findings WHERE check_key = 'ai_personal_expense_review';
DELETE FROM check_suppressions WHERE check_key = 'ai_personal_expense_review';
DELETE FROM check_params_overrides WHERE check_key = 'ai_personal_expense_review';
DELETE FROM check_registry WHERE check_key = 'ai_personal_expense_review';

ALTER TABLE check_registry
  DROP CONSTRAINT IF EXISTS check_registry_category_check;

ALTER TABLE check_registry
  ADD CONSTRAINT check_registry_category_check
  CHECK (category IN ('close', 'data', 'compliance'));
