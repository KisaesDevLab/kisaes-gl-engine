CREATE TABLE IF NOT EXISTS "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_number" varchar(20),
	"name" varchar(255) NOT NULL,
	"account_type" varchar(20) NOT NULL,
	"detail_type" varchar(100),
	"description" text,
	"is_active" boolean DEFAULT true,
	"is_system" boolean DEFAULT false,
	"system_tag" varchar(50),
	"parent_id" uuid,
	"balance" numeric(19, 4) DEFAULT '0',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_name" varchar(255) NOT NULL,
	"legal_name" varchar(255),
	"ein" varchar(20),
	"address_line1" varchar(255),
	"address_line2" varchar(255),
	"city" varchar(100),
	"state" varchar(50),
	"zip" varchar(20),
	"country" varchar(3) DEFAULT 'US',
	"phone" varchar(30),
	"email" varchar(255),
	"website" varchar(255),
	"logo_url" varchar(500),
	"industry" varchar(100),
	"entity_type" varchar(50) DEFAULT 'sole_prop' NOT NULL,
	"fiscal_year_start_month" integer DEFAULT 1,
	"accounting_method" varchar(10) DEFAULT 'accrual',
	"default_payment_terms" varchar(50) DEFAULT 'net_30',
	"invoice_prefix" varchar(20) DEFAULT 'INV-',
	"invoice_next_number" integer DEFAULT 1001,
	"default_sales_tax_rate" numeric(5, 4) DEFAULT '0',
	"currency" varchar(3) DEFAULT 'USD',
	"date_format" varchar(20) DEFAULT 'MM/DD/YYYY',
	"setup_complete" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_tenant" ON "accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_type" ON "accounts" USING btree ("tenant_id","account_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_system_tag" ON "accounts" USING btree ("tenant_id","system_tag");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_accounts_tenant_number" ON "accounts" USING btree ("tenant_id","account_number");