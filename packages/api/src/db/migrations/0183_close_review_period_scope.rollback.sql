-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Restores the registry defaults only. The company backfill is harmless to
-- keep (older code ignores it). Deleted unscoped findings are NOT
-- restorable from here — restore the pre-deploy dump if they are needed.

UPDATE check_registry SET enabled = TRUE
WHERE check_key = 'auto_posted_by_rule_sampling';

UPDATE check_registry
SET default_params = jsonb_set(default_params, '{thresholdAmount}', '10000'::jsonb),
    default_severity = 'high'
WHERE check_key = 'transaction_above_materiality'
  AND (default_params->>'thresholdAmount')::numeric = 1000;
