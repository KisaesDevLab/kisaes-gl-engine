CREATE TABLE IF NOT EXISTS "bank_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"priority" integer DEFAULT 0,
	"is_active" boolean DEFAULT true,
	"apply_to" varchar(10) DEFAULT 'both' NOT NULL,
	"bank_account_id" uuid,
	"description_contains" varchar(255),
	"description_exact" varchar(255),
	"amount_equals" numeric(19, 4),
	"amount_min" numeric(19, 4),
	"amount_max" numeric(19, 4),
	"assign_account_id" uuid,
	"assign_contact_id" uuid,
	"assign_memo" varchar(500),
	"auto_confirm" boolean DEFAULT false,
	"times_applied" integer DEFAULT 0,
	"last_applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "duplicate_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transaction_id_a" uuid NOT NULL,
	"transaction_id_b" uuid NOT NULL,
	"dismissed_by" uuid,
	"dismissed_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_br_tenant" ON "bank_rules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_br_active" ON "bank_rules" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_dd_pair" ON "duplicate_dismissals" USING btree ("tenant_id","transaction_id_a","transaction_id_b");