-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
CREATE TABLE IF NOT EXISTS "deposit_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deposit_id" uuid NOT NULL,
	"source_transaction_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"unit_price" numeric(19, 4),
	"income_account_id" uuid NOT NULL,
	"is_taxable" boolean DEFAULT true,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "default_line_entry_mode" varchar(20) DEFAULT 'category';--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "item_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dl_deposit" ON "deposit_lines" USING btree ("deposit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dl_source" ON "deposit_lines" USING btree ("source_transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_items_tenant" ON "items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_items_active" ON "items" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_items_tenant_name" ON "items" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pa_payment" ON "payment_applications" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pa_invoice" ON "payment_applications" USING btree ("invoice_id");