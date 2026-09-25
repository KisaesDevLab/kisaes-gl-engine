-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Close Review becomes period-true and manual-only.
--
-- 1. Bank-feed items were inserted with no company, so every company-scoped
--    Close Review query (buckets, Manual Queue, two checks) matched nothing.
--    Backfill from the bank connection's company, else the tenant's only
--    company. Multi-company tenants whose connection has no company stay
--    NULL (ambiguous; nothing guessed). bank_connections is NOT touched —
--    portal banking relies on NULL-company connections.
UPDATE bank_feed_items b
SET company_id = COALESCE(
  (SELECT c.company_id FROM bank_connections c WHERE c.id = b.bank_connection_id),
  (SELECT MIN(co.id::text)::uuid FROM companies co WHERE co.tenant_id = b.tenant_id
     HAVING COUNT(*) = 1)
)
WHERE b.company_id IS NULL;

UPDATE transaction_classification_state s
SET company_id = b.company_id
FROM bank_feed_items b
WHERE b.id = s.bank_feed_item_id
  AND s.company_id IS NULL
  AND b.company_id IS NOT NULL;

-- 2. Findings with no period came from the removed background sweep and
--    from "Run AI judgment", which passed no period. They could never be
--    listed (the list filters by period) yet inflated the summary cards.
--    User decision 2026-09-25: delete them. finding_events cascade.
--    The pre-deploy pg_dump is the only copy afterwards.
DELETE FROM findings WHERE period_start IS NULL;

-- 3. Noise defaults.
--    Rule sampling re-flagged a random 10% of every rule posting; off by
--    default (re-enable per tenant from the checks registry).
UPDATE check_registry SET enabled = FALSE
WHERE check_key = 'auto_posted_by_rule_sampling';

--    "Transactions over $X" review list at $1,000 (Double's default) as a
--    medium-severity review item, only where the default was never changed.
UPDATE check_registry
SET default_params = jsonb_set(default_params, '{thresholdAmount}', '1000'::jsonb),
    default_severity = 'med'
WHERE check_key = 'transaction_above_materiality'
  AND (default_params->>'thresholdAmount')::numeric = 10000;
