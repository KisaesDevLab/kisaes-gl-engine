CREATE TABLE IF NOT EXISTS "bank_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" varchar(50) DEFAULT 'plaid',
	"provider_account_id" varchar(255),
	"provider_item_id" varchar(255),
	"access_token_encrypted" text,
	"institution_name" varchar(255),
	"mask" varchar(10),
	"last_sync_at" timestamp with time zone,
	"sync_status" varchar(20) DEFAULT 'active',
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_feed_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_connection_id" uuid NOT NULL,
	"provider_transaction_id" varchar(255),
	"feed_date" date NOT NULL,
	"description" varchar(500),
	"amount" numeric(19, 4) NOT NULL,
	"category" varchar(255),
	"status" varchar(20) DEFAULT 'pending',
	"matched_transaction_id" uuid,
	"suggested_account_id" uuid,
	"suggested_contact_id" uuid,
	"confidence_score" numeric(3, 2),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"journal_line_id" uuid NOT NULL,
	"is_cleared" boolean DEFAULT false,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"statement_date" date NOT NULL,
	"statement_ending_balance" numeric(19, 4) NOT NULL,
	"beginning_balance" numeric(19, 4) NOT NULL,
	"cleared_balance" numeric(19, 4),
	"difference" numeric(19, 4),
	"status" varchar(20) DEFAULT 'in_progress',
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bfi_tenant" ON "bank_feed_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bfi_status" ON "bank_feed_items" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bfi_date" ON "bank_feed_items" USING btree ("tenant_id","feed_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_bfi_provider_txn" ON "bank_feed_items" USING btree ("tenant_id","provider_transaction_id");