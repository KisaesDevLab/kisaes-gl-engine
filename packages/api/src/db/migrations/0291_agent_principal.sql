-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- migration-policy: non-additive-exception
--
-- U-297 (ClientLedger A11, agent-principal-v1): agent principals.
--   1. users.user_type adds 'agent' (a no-login user that owns one API key
--      minted by the engine for an MCP connection). users_user_type_check is
--      widened: dropped and re-added with the extra value in this file; every
--      existing row ('staff' or 'client') satisfies the new rule. The marker
--      above is needed because the policy check treats any constraint
--      replacement as non-additive; no data changes. Idempotent: the check is
--      replaced only while it lacks 'agent'. Locking: a brief ACCESS EXCLUSIVE
--      on users (a small table) while the CHECK is re-validated.
--   2. audit_log.origin (who acted through what, e.g. 'mcp:<connection id>')
--      and audit_log.action_id (the agent action a row belongs to). Nullable,
--      no default, no index and no foreign key: adding them is instant on a
--      large audit_log, and every existing row keeps NULL (a human change).
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'users'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%user_type%'
      AND pg_get_constraintdef(oid) NOT LIKE '%agent%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'users_user_type_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_user_type_check
      CHECK (user_type IN ('staff', 'client', 'agent'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS origin varchar(80);
--> statement-breakpoint
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS action_id uuid;
