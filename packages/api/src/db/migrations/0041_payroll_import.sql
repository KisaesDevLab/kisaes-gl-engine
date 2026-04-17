-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
CREATE TABLE IF NOT EXISTS "payroll_provider_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(100) NOT NULL,
  "provider_key" varchar(50) NOT NULL,
  "description" text,
  "column_map" jsonb,
  "file_format_hints" jsonb,
  "is_system" boolean DEFAULT false,
  "tenant_id" uuid,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_tpl_provider" ON "payroll_provider_templates" USING btree ("provider_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_tpl_tenant" ON "payroll_provider_templates" USING btree ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_import_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "company_id" uuid,
  "import_mode" varchar(20) NOT NULL,
  "template_id" uuid,
  "original_filename" varchar(255) NOT NULL,
  "file_path" varchar(500) NOT NULL,
  "file_hash" varchar(64) NOT NULL,
  "companion_filename" varchar(255),
  "companion_file_path" varchar(500),
  "pay_period_start" date,
  "pay_period_end" date,
  "check_date" date,
  "status" varchar(20) NOT NULL DEFAULT 'uploaded',
  "row_count" integer DEFAULT 0,
  "error_count" integer DEFAULT 0,
  "je_count" integer DEFAULT 1,
  "journal_entry_id" uuid,
  "journal_entry_ids" jsonb,
  "column_map_snapshot" jsonb,
  "metadata" jsonb,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_sess_tenant" ON "payroll_import_sessions" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_sess_company_status" ON "payroll_import_sessions" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_sess_hash" ON "payroll_import_sessions" USING btree ("tenant_id","file_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_import_column_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "source_column" varchar(200) NOT NULL,
  "target_field" varchar(100) NOT NULL,
  "transform_rule" jsonb,
  "created_at" timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_colmap_session" ON "payroll_import_column_mappings" USING btree ("session_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_import_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "row_number" integer NOT NULL,
  "raw_data" jsonb,
  "mapped_data" jsonb,
  "validation_status" varchar(20) DEFAULT 'pending',
  "validation_messages" jsonb,
  "created_at" timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_rows_session_row" ON "payroll_import_rows" USING btree ("session_id","row_number");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_import_errors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "error_type" varchar(50) NOT NULL,
  "message" text NOT NULL,
  "detail" jsonb,
  "created_at" timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_errors_session" ON "payroll_import_errors" USING btree ("session_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_description_account_map" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "company_id" uuid,
  "provider_key" varchar(50) NOT NULL,
  "source_description" varchar(200) NOT NULL,
  "account_id" uuid NOT NULL,
  "line_category" varchar(30),
  "is_system_suggested" boolean DEFAULT false,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_payroll_descmap_unique" ON "payroll_description_account_map" USING btree ("tenant_id","company_id","provider_key","source_description");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_descmap_tenant" ON "payroll_description_account_map" USING btree ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_check_register_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "row_number" integer NOT NULL,
  "check_number" varchar(20),
  "check_date" date NOT NULL,
  "payee_name" varchar(200) NOT NULL,
  "amount" numeric(12,2) NOT NULL,
  "memo" varchar(500),
  "check_type" varchar(20),
  "posted" boolean DEFAULT false,
  "transaction_id" uuid,
  "created_at" timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_checks_session" ON "payroll_check_register_rows" USING btree ("session_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_account_mapping" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "company_id" uuid,
  "line_type" varchar(50) NOT NULL,
  "account_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_payroll_acctmap_unique" ON "payroll_account_mapping" USING btree ("tenant_id","company_id","line_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_acctmap_tenant" ON "payroll_account_mapping" USING btree ("tenant_id");
