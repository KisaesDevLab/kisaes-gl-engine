-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- Cloud Storage Providers Migration

-- 1. Storage providers table
CREATE TABLE IF NOT EXISTS "storage_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "provider" varchar(30) NOT NULL,
  "is_active" boolean DEFAULT true,
  "access_token_encrypted" text,
  "refresh_token_encrypted" text,
  "token_expires_at" timestamp with time zone,
  "config" jsonb NOT NULL DEFAULT '{}',
  "last_health_check_at" timestamp with time zone,
  "health_status" varchar(20) DEFAULT 'unknown',
  "health_error" text,
  "display_name" varchar(100),
  "connected_by" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_sp_tenant_active" ON "storage_providers" USING btree ("tenant_id");
--> statement-breakpoint

-- 2. Storage migrations tracking
CREATE TABLE IF NOT EXISTS "storage_migrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "from_provider" varchar(30) NOT NULL,
  "to_provider" varchar(30) NOT NULL,
  "status" varchar(20) DEFAULT 'pending',
  "total_files" integer NOT NULL DEFAULT 0,
  "migrated_files" integer NOT NULL DEFAULT 0,
  "failed_files" integer NOT NULL DEFAULT 0,
  "error_log" jsonb DEFAULT '[]',
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint

-- 3. Add storage columns to attachments
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "storage_key" varchar(500);
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "storage_provider" varchar(30) DEFAULT 'local';
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "provider_file_id" varchar(500);
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "local_cache_path" varchar(500);
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "cache_expires_at" timestamp with time zone;
--> statement-breakpoint

-- 4. Backfill existing attachments with storage_key from file_path
UPDATE "attachments" SET "storage_key" = "file_path", "storage_provider" = 'local' WHERE "storage_key" IS NULL;
