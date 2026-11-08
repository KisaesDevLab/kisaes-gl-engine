-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- migration-policy: non-additive-exception
--
-- 3-tier rules plan, Phase 2 — scope columns on conditional_rules.
-- Why non-additive: relaxing NOT NULL on conditional_rules.tenant_id
-- changes the column's contract for any reader doing strict type
-- narrowing. Required so global_firm rows can have NULL tenant.
-- Existing rows are unaffected (every existing row has a non-null
-- tenant_id and remains tenant_user-scoped).
--
-- Order of operations:
--   1. ADD COLUMN with safe default (`scope = 'tenant_user'`).
--   2. Backfill owner_user_id from existing `created_by`, falling
--      back to the tenant's first owner-role user.
--   3. Backfill effective_tier on the audit table.
--   4. Relax tenant_id NOT NULL.
--   5. Add the CHECK constraint AFTER backfill so it validates the
--      already-correct rows rather than a half-migrated state.
--   6. New indexes.

-- 1. ADD COLUMNs (additive). All have safe defaults.
ALTER TABLE conditional_rules
  ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'tenant_user';
ALTER TABLE conditional_rules
  ADD COLUMN IF NOT EXISTS owner_user_id UUID;
ALTER TABLE conditional_rules
  ADD COLUMN IF NOT EXISTS owner_firm_id UUID REFERENCES firms(id) ON DELETE CASCADE;
ALTER TABLE conditional_rules
  ADD COLUMN IF NOT EXISTS forked_from_global_id UUID;

ALTER TABLE conditional_rule_audit
  ADD COLUMN IF NOT EXISTS effective_tier VARCHAR(20);
ALTER TABLE conditional_rule_audit
  ADD COLUMN IF NOT EXISTS effective_firm_id UUID;

-- 2. Backfill owner_user_id on existing rows.
-- Strategy: prefer `created_by` (the actual author). If null,
-- fall back to the tenant's first owner-role user via
-- user_tenant_access. Worst case (very old tenants without an
-- owner role row) leaves owner_user_id NULL; the CHECK constraint
-- below fails those, which we catch by setting them to the
-- tenant's first ANY-role user as a last-resort fallback.
UPDATE conditional_rules
SET owner_user_id = COALESCE(
  created_by,
  (SELECT uta.user_id
   FROM user_tenant_access uta
   WHERE uta.tenant_id = conditional_rules.tenant_id
     AND uta.role = 'owner'
     AND uta.is_active = TRUE
   ORDER BY uta.created_at
   LIMIT 1),
  (SELECT uta.user_id
   FROM user_tenant_access uta
   WHERE uta.tenant_id = conditional_rules.tenant_id
     AND uta.is_active = TRUE
   ORDER BY uta.created_at
   LIMIT 1)
)
WHERE scope = 'tenant_user' AND owner_user_id IS NULL;

-- Edge case: any rule whose tenant has zero user_tenant_access
-- rows (data anomaly). Those would still fail the CHECK — flip
-- them to inactive so they don't break evaluation. Operators can
-- triage from the audit log.
UPDATE conditional_rules
SET active = FALSE
WHERE scope = 'tenant_user' AND owner_user_id IS NULL;

-- 3. Backfill effective_tier on the audit table — every existing
-- fire is a tenant_user fire by definition.
UPDATE conditional_rule_audit
SET effective_tier = 'tenant_user'
WHERE effective_tier IS NULL;

-- 4. Relax tenant_id NOT NULL so global_firm rows can have NULL.
ALTER TABLE conditional_rules
  ALTER COLUMN tenant_id DROP NOT NULL;

-- 5. CHECK constraint enforcing the (scope, tenant_id, owner_*) invariant.
-- Added AFTER backfill so the validation passes against the
-- migrated rows. Drizzle's builder API can't model this; the
-- raw SQL is the source of truth.
ALTER TABLE conditional_rules
  ADD CONSTRAINT conditional_rules_scope_owner_check CHECK (
    (scope = 'tenant_user'  AND tenant_id IS NOT NULL AND owner_user_id IS NOT NULL AND owner_firm_id IS NULL) OR
    (scope = 'tenant_firm'  AND tenant_id IS NOT NULL AND owner_firm_id IS NOT NULL AND owner_user_id IS NULL) OR
    (scope = 'global_firm'  AND tenant_id IS NULL     AND owner_firm_id IS NOT NULL AND owner_user_id IS NULL)
  ) NOT VALID;
-- VALIDATE separately so an already-active replica can validate
-- without taking the full table lock the inline ADD CONSTRAINT
-- otherwise grabs.
ALTER TABLE conditional_rules
  VALIDATE CONSTRAINT conditional_rules_scope_owner_check;

-- 6. New indexes (already declared in Drizzle schema; the migration
-- recreates them so the journal stays in sync). The forked_from
-- index is partial — Drizzle's index API can't express WHERE.
CREATE INDEX IF NOT EXISTS idx_cond_rules_owner_firm_active
  ON conditional_rules (owner_firm_id, scope, active);
DROP INDEX IF EXISTS idx_cond_rules_forked_from;
CREATE INDEX idx_cond_rules_forked_from
  ON conditional_rules (forked_from_global_id)
  WHERE forked_from_global_id IS NOT NULL;
