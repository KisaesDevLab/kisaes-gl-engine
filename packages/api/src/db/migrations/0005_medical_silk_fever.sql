CREATE TABLE IF NOT EXISTS "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"description" text,
	"quantity" numeric(12, 4),
	"unit_price" numeric(19, 4),
	"is_taxable" boolean DEFAULT false,
	"tax_rate" numeric(5, 4) DEFAULT '0',
	"tax_amount" numeric(19, 4) DEFAULT '0',
	"line_order" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"color" varchar(7),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transaction_tags" (
	"transaction_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"txn_type" varchar(30) NOT NULL,
	"txn_number" varchar(50),
	"txn_date" date NOT NULL,
	"due_date" date,
	"status" varchar(20) DEFAULT 'posted' NOT NULL,
	"contact_id" uuid,
	"memo" text,
	"internal_notes" text,
	"payment_terms" varchar(50),
	"subtotal" numeric(19, 4),
	"tax_amount" numeric(19, 4) DEFAULT '0',
	"total" numeric(19, 4),
	"amount_paid" numeric(19, 4) DEFAULT '0',
	"balance_due" numeric(19, 4),
	"invoice_status" varchar(20),
	"sent_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"is_recurring" boolean DEFAULT false,
	"recurring_schedule_id" uuid,
	"source_estimate_id" uuid,
	"applied_to_invoice_id" uuid,
	"void_reason" text,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jl_transaction" ON "journal_lines" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jl_account" ON "journal_lines" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jl_tenant" ON "journal_lines" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_txn_tenant" ON "transactions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_txn_type" ON "transactions" USING btree ("tenant_id","txn_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_txn_date" ON "transactions" USING btree ("tenant_id","txn_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_txn_contact" ON "transactions" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_txn_status" ON "transactions" USING btree ("tenant_id","status");