-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- U-290 (ClientLedger P33, lan-sessions-v1): desktop sessions bound to a
-- session chain and a device.
--
-- chain_id: one id for a sign-in and every refresh rotation after it. Access
-- tokens carry it as the `sid` claim; in desktop LAN mode every request
-- checks that a live session of the chain still exists, so revoking a
-- session (delete its rows) ends its access tokens within one request.
-- Existing rows get a fresh chain each (their next refresh carries it on).
--
-- device_id: the LAN device fingerprint (X-CL-Device, 64 hex) the session
-- was created from; NULL for the host app, the server and desktop without
-- LAN. A refresh or request from another device is refused.
--
-- Sessions never travel in tenant archives (excluded table). Additive only.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS chain_id uuid NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id varchar(64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sessions_chain ON sessions (chain_id);