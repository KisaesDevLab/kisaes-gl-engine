-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0291 (U-297, agent principals). The code that mints agent
-- users must be rolled back with it. Fails closed: every agent user is turned
-- off first (its API keys and company access too) and kept as an inactive
-- 'staff' row, so no agent key keeps working under the older engine and the
-- audit rows that name it still resolve. LOST: which users were agents, and
-- the origin / action id on audit rows (the rows themselves stay).
UPDATE api_keys SET is_active = false
  WHERE user_id IN (SELECT id FROM users WHERE user_type = 'agent');
--> statement-breakpoint
UPDATE user_tenant_access SET is_active = false
  WHERE user_id IN (SELECT id FROM users WHERE user_type = 'agent');
--> statement-breakpoint
UPDATE users SET user_type = 'staff', is_active = false, updated_at = now()
  WHERE user_type = 'agent';
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_user_type_check;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_user_type_check CHECK (user_type IN ('staff', 'client'));
--> statement-breakpoint
ALTER TABLE audit_log DROP COLUMN IF EXISTS action_id;
--> statement-breakpoint
ALTER TABLE audit_log DROP COLUMN IF EXISTS origin;
