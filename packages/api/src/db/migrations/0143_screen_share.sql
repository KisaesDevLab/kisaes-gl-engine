-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Peer screen share (rrweb DOM mirroring) — sessions, per-viewer participants,
-- append-only audit. No rrweb event payloads are ever persisted.

CREATE TYPE "share_session_status" AS ENUM ('pending', 'active', 'ended', 'expired', 'revoked');
--> statement-breakpoint
CREATE TYPE "share_participant_status" AS ENUM ('requested', 'approved', 'denied', 'lapsed', 'ejected', 'left');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "share_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "sharer_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "join_code_hash" text NOT NULL,
  "status" "share_session_status" DEFAULT 'pending' NOT NULL,
  "entity_context" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "ended_reason" text,
  "sharer_ip" text,
  "sharer_user_agent" text,
  "bytes_relayed" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "share_session_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "share_sessions"("id") ON DELETE CASCADE,
  "viewer_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "viewer_tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "status" "share_participant_status" DEFAULT 'requested' NOT NULL,
  "is_cross_firm" boolean NOT NULL,
  "scope_warning_shown" boolean DEFAULT false,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "approved_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "viewer_ip" text,
  "viewer_user_agent" text,
  "bytes_relayed" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "share_session_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "share_sessions"("id") ON DELETE CASCADE,
  "participant_id" uuid REFERENCES "share_session_participants"("id") ON DELETE SET NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "actor_user_id" uuid,
  "event" text NOT NULL,
  "detail" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_sessions_tenant_created_idx" ON "share_sessions" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "share_sessions_live_code_idx" ON "share_sessions" ("join_code_hash") WHERE status in ('pending', 'active');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_participants_session_idx" ON "share_session_participants" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "share_participants_session_viewer_idx" ON "share_session_participants" ("session_id", "viewer_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_participants_viewer_requested_idx" ON "share_session_participants" ("viewer_user_id", "requested_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_audit_session_idx" ON "share_session_audit" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_audit_at_idx" ON "share_session_audit" ("at");
--> statement-breakpoint
-- Append-only enforcement. The appliance runs on a single database role, so
-- REVOKE UPDATE/DELETE would also bind the migration/retention role. A trigger
-- enforces immutability for the application while still allowing the
-- retention job's targeted purge (which sets the session-local flag below).
CREATE OR REPLACE FUNCTION share_audit_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('mybooks.share_audit_retention', true) = 'on' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'share_session_audit is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER share_session_audit_append_only
  BEFORE UPDATE OR DELETE ON "share_session_audit"
  FOR EACH ROW EXECUTE FUNCTION share_audit_append_only();
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "share_settings" jsonb;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "share_allowed" boolean;
