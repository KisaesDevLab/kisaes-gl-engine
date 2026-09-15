-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Firm member access rights: a per-member capability matrix stored on the
-- membership row. NULL = follow the firm_role defaults (firm_admin: all on;
-- firm_staff / firm_readonly: none). A non-null object is an explicit,
-- customized set keyed by the shared FIRM_CAPABILITIES catalog; absent keys
-- read as false.

ALTER TABLE firm_users ADD COLUMN IF NOT EXISTS capabilities jsonb;
--> statement-breakpoint
ALTER TABLE firm_users ADD COLUMN IF NOT EXISTS capabilities_updated_at timestamptz;
--> statement-breakpoint
ALTER TABLE firm_users ADD COLUMN IF NOT EXISTS capabilities_updated_by_user_id uuid;
--> statement-breakpoint
-- Upgrade-day safety: EXISTING firm_admins start with an explicit empty set
-- (shown as "Customized") so nobody gains owner-level or delegated-admin
-- power silently on deploy. Only firm_admins created after this migration,
-- or members explicitly edited, receive the all-on role default.
UPDATE firm_users
   SET capabilities = '{}'::jsonb,
       capabilities_updated_at = now()
 WHERE firm_role = 'firm_admin'
   AND capabilities IS NULL;
