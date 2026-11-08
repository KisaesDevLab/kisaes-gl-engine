-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Portal password login (legacy, unlinked contacts) had no per-account
-- lockout — only the spoofable per-IP limiter. Mirror the staff users /
-- portal_identities contract: count failures, lock after MAX attempts.

ALTER TABLE portal_passwords
  ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE portal_passwords
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;
