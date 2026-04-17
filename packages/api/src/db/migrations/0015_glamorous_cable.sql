-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
CREATE TABLE IF NOT EXISTS "budget_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"month_1" numeric(19, 4) DEFAULT '0',
	"month_2" numeric(19, 4) DEFAULT '0',
	"month_3" numeric(19, 4) DEFAULT '0',
	"month_4" numeric(19, 4) DEFAULT '0',
	"month_5" numeric(19, 4) DEFAULT '0',
	"month_6" numeric(19, 4) DEFAULT '0',
	"month_7" numeric(19, 4) DEFAULT '0',
	"month_8" numeric(19, 4) DEFAULT '0',
	"month_9" numeric(19, 4) DEFAULT '0',
	"month_10" numeric(19, 4) DEFAULT '0',
	"month_11" numeric(19, 4) DEFAULT '0',
	"month_12" numeric(19, 4) DEFAULT '0'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"fiscal_year" integer NOT NULL,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bl_budget" ON "budget_lines" USING btree ("budget_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_bl_budget_account" ON "budget_lines" USING btree ("budget_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_budgets_tenant_year" ON "budgets" USING btree ("tenant_id","fiscal_year");