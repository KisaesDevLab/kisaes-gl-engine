CREATE TABLE IF NOT EXISTS "saved_report_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"report_type" varchar(100) NOT NULL,
	"filters" text NOT NULL,
	"is_default" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tag_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"is_single_select" boolean DEFAULT false,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "is_active" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "usage_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "sort_order" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "transaction_tags" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_tags" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tags_tenant" ON "tags" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tags_group" ON "tags" USING btree ("tenant_id","group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tags_active" ON "tags" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tt_tag" ON "transaction_tags" USING btree ("tenant_id","tag_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tt_transaction" ON "transaction_tags" USING btree ("transaction_id");