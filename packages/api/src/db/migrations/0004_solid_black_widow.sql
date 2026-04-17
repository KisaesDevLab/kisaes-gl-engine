-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_type" varchar(20) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"company_name" varchar(255),
	"first_name" varchar(100),
	"last_name" varchar(100),
	"email" varchar(255),
	"phone" varchar(30),
	"billing_line1" varchar(255),
	"billing_line2" varchar(255),
	"billing_city" varchar(100),
	"billing_state" varchar(50),
	"billing_zip" varchar(20),
	"billing_country" varchar(3) DEFAULT 'US',
	"shipping_line1" varchar(255),
	"shipping_line2" varchar(255),
	"shipping_city" varchar(100),
	"shipping_state" varchar(50),
	"shipping_zip" varchar(20),
	"shipping_country" varchar(3) DEFAULT 'US',
	"default_payment_terms" varchar(50),
	"opening_balance" numeric(19, 4) DEFAULT '0',
	"opening_balance_date" date,
	"default_expense_account_id" uuid,
	"tax_id" varchar(30),
	"is_1099_eligible" boolean DEFAULT false,
	"notes" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contacts_tenant" ON "contacts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contacts_type" ON "contacts" USING btree ("tenant_id","contact_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contacts_name" ON "contacts" USING btree ("tenant_id","display_name");