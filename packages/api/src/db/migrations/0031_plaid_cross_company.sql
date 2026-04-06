-- Plaid Cross-Company Addendum Migration
-- Converts plaid_items and plaid_accounts from tenant-scoped to system-scoped
-- Adds plaid_account_mappings bridge table and plaid_item_activity log

-- 1. Drop old tenant-specific indexes on plaid_items
DROP INDEX IF EXISTS "idx_pi_tenant";
DROP INDEX IF EXISTS "idx_pi_status";
DROP INDEX IF EXISTS "idx_pi_plaid_item";
DROP INDEX IF EXISTS "idx_pi_tenant_item";

-- 2. Modify plaid_items: remove tenant_id, add attribution columns
ALTER TABLE "plaid_items" DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "plaid_items" ADD COLUMN IF NOT EXISTS "created_by" uuid;
ALTER TABLE "plaid_items" ADD COLUMN IF NOT EXISTS "created_by_name" varchar(255);
ALTER TABLE "plaid_items" ADD COLUMN IF NOT EXISTS "created_by_email" varchar(255);
ALTER TABLE "plaid_items" ADD COLUMN IF NOT EXISTS "removed_by" uuid;
ALTER TABLE "plaid_items" ADD COLUMN IF NOT EXISTS "removed_by_name" varchar(255);
--> statement-breakpoint

-- 3. Make plaid_item_id unique at system level
ALTER TABLE "plaid_items" DROP CONSTRAINT IF EXISTS "plaid_items_plaid_item_id_unique";
ALTER TABLE "plaid_items" ADD CONSTRAINT "plaid_items_plaid_item_id_unique" UNIQUE("plaid_item_id");
--> statement-breakpoint

-- 4. Create new indexes for system-scoped plaid_items
CREATE INDEX IF NOT EXISTS "idx_pi_status" ON "plaid_items" USING btree ("item_status");
CREATE INDEX IF NOT EXISTS "idx_pi_institution" ON "plaid_items" USING btree ("plaid_institution_id");
CREATE INDEX IF NOT EXISTS "idx_pi_created_by" ON "plaid_items" USING btree ("created_by");
--> statement-breakpoint

-- 5. Drop old tenant-specific indexes and columns on plaid_accounts
DROP INDEX IF EXISTS "idx_pa_tenant";
DROP INDEX IF EXISTS "idx_pa_mapped";
DROP INDEX IF EXISTS "idx_pa_tenant_account";
DROP INDEX IF EXISTS "idx_pa_soft_dedup";

ALTER TABLE "plaid_accounts" DROP COLUMN IF EXISTS "tenant_id";
ALTER TABLE "plaid_accounts" DROP COLUMN IF EXISTS "mapped_account_id";
ALTER TABLE "plaid_accounts" DROP COLUMN IF EXISTS "is_mapped";
ALTER TABLE "plaid_accounts" DROP COLUMN IF EXISTS "is_sync_enabled";
--> statement-breakpoint

-- 6. Make plaid_account_id unique at system level
ALTER TABLE "plaid_accounts" DROP CONSTRAINT IF EXISTS "plaid_accounts_plaid_account_id_unique";
ALTER TABLE "plaid_accounts" ADD CONSTRAINT "plaid_accounts_plaid_account_id_unique" UNIQUE("plaid_account_id");
--> statement-breakpoint

-- 7. Create new indexes for system-scoped plaid_accounts
CREATE INDEX IF NOT EXISTS "idx_pa_mask_subtype" ON "plaid_accounts" USING btree ("mask","account_subtype");
--> statement-breakpoint

-- 8. Create plaid_account_mappings bridge table
CREATE TABLE IF NOT EXISTS "plaid_account_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plaid_account_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "mapped_account_id" uuid NOT NULL,
  "sync_start_date" date,
  "is_sync_enabled" boolean DEFAULT true,
  "mapped_by" uuid NOT NULL,
  "mapped_by_name" varchar(255),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_pam_tenant" ON "plaid_account_mappings" USING btree ("tenant_id");
CREATE INDEX IF NOT EXISTS "idx_pam_plaid" ON "plaid_account_mappings" USING btree ("plaid_account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pam_plaid_account_uniq" ON "plaid_account_mappings" USING btree ("plaid_account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pam_tenant_coa_uniq" ON "plaid_account_mappings" USING btree ("tenant_id","mapped_account_id");
--> statement-breakpoint

-- 9. Create plaid_item_activity log
CREATE TABLE IF NOT EXISTS "plaid_item_activity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plaid_item_id" uuid NOT NULL,
  "tenant_id" uuid,
  "action" varchar(50) NOT NULL,
  "performed_by" uuid,
  "performed_by_name" varchar(255),
  "details" jsonb,
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_pia_item" ON "plaid_item_activity" USING btree ("plaid_item_id");
CREATE INDEX IF NOT EXISTS "idx_pia_tenant" ON "plaid_item_activity" USING btree ("tenant_id");
