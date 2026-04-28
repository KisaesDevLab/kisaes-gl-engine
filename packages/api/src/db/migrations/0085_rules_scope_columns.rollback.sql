-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- migration-policy: non-additive-exception
--
-- Rollback for 0082_rules_scope_columns. Reverses the additive
-- columns + CHECK + NOT NULL relaxation. Any existing global_firm
-- rules (NULL tenant_id) would be invalid after re-applying NOT
-- NULL — the rollback drops them. Operators rolling back must
-- back up the conditional_rules table first.

-- Drop the CHECK first so the table accepts NULL tenant_id rows
-- when we delete them, then re-impose NOT NULL.
ALTER TABLE conditional_rules
  DROP CONSTRAINT IF EXISTS conditional_rules_scope_owner_check;

DROP INDEX IF EXISTS idx_cond_rules_owner_firm_active;
DROP INDEX IF EXISTS idx_cond_rules_forked_from;

-- Any global_firm rows must be deleted before re-applying the
-- NOT NULL constraint on tenant_id. Tenant-scoped fork links
-- are also cleared.
DELETE FROM conditional_rules WHERE tenant_id IS NULL;
UPDATE conditional_rules SET forked_from_global_id = NULL;

ALTER TABLE conditional_rules
  ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE conditional_rules DROP COLUMN IF EXISTS forked_from_global_id;
ALTER TABLE conditional_rules DROP COLUMN IF EXISTS owner_firm_id;
ALTER TABLE conditional_rules DROP COLUMN IF EXISTS owner_user_id;
ALTER TABLE conditional_rules DROP COLUMN IF EXISTS scope;

ALTER TABLE conditional_rule_audit DROP COLUMN IF EXISTS effective_firm_id;
ALTER TABLE conditional_rule_audit DROP COLUMN IF EXISTS effective_tier;
