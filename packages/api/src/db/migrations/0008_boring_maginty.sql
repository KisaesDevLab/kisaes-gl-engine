CREATE TABLE IF NOT EXISTS "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_path" varchar(500) NOT NULL,
	"file_size" integer,
	"mime_type" varchar(100),
	"attachable_type" varchar(50) NOT NULL,
	"attachable_id" uuid NOT NULL,
	"ocr_status" varchar(20),
	"ocr_vendor" varchar(255),
	"ocr_date" date,
	"ocr_total" numeric(19, 4),
	"ocr_tax" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurring_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_transaction_id" uuid NOT NULL,
	"frequency" varchar(20) NOT NULL,
	"interval_value" integer DEFAULT 1,
	"mode" varchar(20) DEFAULT 'auto',
	"start_date" date NOT NULL,
	"end_date" date,
	"next_occurrence" date NOT NULL,
	"last_posted_at" timestamp with time zone,
	"is_active" varchar(5) DEFAULT 'true',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attach_tenant" ON "attachments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attach_ref" ON "attachments" USING btree ("attachable_type","attachable_id");