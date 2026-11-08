-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- migration-policy: non-additive-exception
--
-- AI judgment-based review check (`ai_personal_expense_review`).
-- The check_registry.category CHECK constraint enumerates the
-- four allowed values: ('close', 'data', 'compliance'). A new
-- 'judgment' value is needed for AI-driven handlers because
-- those run on-demand (not nightly) and are surfaced separately
-- in the UI from the deterministic checks.
--
-- The widening is strictly additive: no value is removed and no
-- existing row is invalidated. We use the
-- non-additive-exception marker because the migration policy
-- check considers any constraint replacement non-additive even
-- when the change is a strict superset.
--
-- After widening, seed the new check row. The handler is
-- `ai_personal_expense_review` (registered in handlers/index.ts).
-- Default params:
--   * minAmountDollars   = 25  (skip pocket change)
--   * maxCallsPerRun     = 100 (cap LLM spend per run)
--   * lookbackDays       = 30  (one close cycle)
--   * confidenceThreshold = 0.7 (only flag when AI is confident)

ALTER TABLE check_registry
  DROP CONSTRAINT IF EXISTS check_registry_category_check;

ALTER TABLE check_registry
  ADD CONSTRAINT check_registry_category_check
  CHECK (category IN ('close', 'data', 'compliance', 'judgment'));

INSERT INTO check_registry (check_key, name, handler_name, default_severity, default_params, category) VALUES
  (
    'ai_personal_expense_review',
    'Likely-personal expense (AI judgment)',
    'ai_personal_expense_review',
    'med',
    '{"minAmountDollars":25,"maxCallsPerRun":100,"lookbackDays":30,"confidenceThreshold":0.7}'::JSONB,
    'judgment'
  )
ON CONFLICT (check_key) DO NOTHING;
