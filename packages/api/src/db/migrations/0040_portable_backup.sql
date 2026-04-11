-- Remote backup configuration columns on companies table
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "remote_backup_enabled" boolean DEFAULT false;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "remote_backup_destination" varchar(30);
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "remote_backup_config" jsonb;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "remote_backup_schedule" varchar(20);
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "remote_backup_passphrase_hash" varchar(255);
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "remote_backup_last_at" timestamp with time zone;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "remote_backup_last_status" varchar(20);
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "remote_backup_last_size" bigint;
