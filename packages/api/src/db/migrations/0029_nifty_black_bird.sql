-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
CREATE TABLE IF NOT EXISTS "plaid_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plaid_item_id" uuid NOT NULL,
	"plaid_account_id" varchar(255) NOT NULL,
	"persistent_account_id" varchar(255),
	"name" varchar(255),
	"official_name" varchar(255),
	"account_type" varchar(50),
	"account_subtype" varchar(50),
	"mask" varchar(10),
	"mapped_account_id" uuid,
	"is_mapped" boolean DEFAULT false,
	"current_balance" numeric(19, 4),
	"available_balance" numeric(19, 4),
	"balance_currency" varchar(3) DEFAULT 'USD',
	"balance_updated_at" timestamp with time zone,
	"is_sync_enabled" boolean DEFAULT true,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plaid_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" varchar(20) DEFAULT 'sandbox' NOT NULL,
	"client_id_encrypted" text,
	"secret_sandbox_encrypted" text,
	"secret_production_encrypted" text,
	"webhook_url" varchar(500),
	"default_products" text DEFAULT 'transactions',
	"default_country_codes" text DEFAULT 'US',
	"default_language" varchar(5) DEFAULT 'en',
	"max_historical_days" integer DEFAULT 90,
	"is_active" boolean DEFAULT true,
	"configured_by" uuid,
	"configured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plaid_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plaid_item_id" varchar(255) NOT NULL,
	"plaid_institution_id" varchar(100),
	"institution_name" varchar(255),
	"access_token_encrypted" text NOT NULL,
	"sync_cursor" text,
	"last_sync_at" timestamp with time zone,
	"last_sync_status" varchar(30),
	"last_sync_error" text,
	"initial_update_complete" boolean DEFAULT false,
	"historical_update_complete" boolean DEFAULT false,
	"item_status" varchar(30) DEFAULT 'active',
	"error_code" varchar(100),
	"error_message" text,
	"consent_expiration_at" timestamp with time zone,
	"link_session_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plaid_webhook_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now(),
	"plaid_item_id" varchar(255),
	"webhook_type" varchar(100),
	"webhook_code" varchar(100),
	"payload" jsonb NOT NULL,
	"processed" boolean DEFAULT false,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pa_item" ON "plaid_accounts" USING btree ("plaid_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pa_tenant" ON "plaid_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pa_mapped" ON "plaid_accounts" USING btree ("tenant_id","mapped_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pa_plaid_account" ON "plaid_accounts" USING btree ("plaid_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pa_tenant_account" ON "plaid_accounts" USING btree ("tenant_id","plaid_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pa_soft_dedup" ON "plaid_accounts" USING btree ("tenant_id","mask","account_subtype");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_tenant" ON "plaid_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_status" ON "plaid_items" USING btree ("tenant_id","item_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_plaid_item" ON "plaid_items" USING btree ("plaid_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pi_tenant_item" ON "plaid_items" USING btree ("tenant_id","plaid_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pwl_item" ON "plaid_webhook_log" USING btree ("plaid_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pwl_unprocessed" ON "plaid_webhook_log" USING btree ("processed");