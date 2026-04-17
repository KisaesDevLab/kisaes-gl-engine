-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
CREATE TABLE IF NOT EXISTS "ai_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_enabled" boolean DEFAULT false,
	"categorization_provider" varchar(30),
	"categorization_model" varchar(100),
	"ocr_provider" varchar(30),
	"ocr_model" varchar(100),
	"document_classification_provider" varchar(30),
	"document_classification_model" varchar(100),
	"fallback_chain" jsonb DEFAULT '["anthropic","openai","gemini","ollama"]',
	"anthropic_api_key_encrypted" text,
	"openai_api_key_encrypted" text,
	"gemini_api_key_encrypted" text,
	"ollama_base_url" varchar(500),
	"glm_ocr_api_key_encrypted" text,
	"glm_ocr_base_url" varchar(500),
	"auto_categorize_on_import" boolean DEFAULT true,
	"auto_ocr_on_upload" boolean DEFAULT true,
	"categorization_confidence_threshold" numeric(3, 2) DEFAULT '0.70',
	"max_concurrent_jobs" integer DEFAULT 5,
	"track_usage" boolean DEFAULT true,
	"monthly_budget_limit" numeric(19, 4),
	"configured_by" uuid,
	"configured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_type" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'pending',
	"provider" varchar(30),
	"model" varchar(100),
	"input_type" varchar(30),
	"input_id" uuid,
	"input_data" jsonb,
	"output_data" jsonb,
	"confidence_score" numeric(3, 2),
	"user_accepted" boolean,
	"user_modified" boolean,
	"user_action_at" timestamp with time zone,
	"input_tokens" integer,
	"output_tokens" integer,
	"estimated_cost" numeric(10, 6),
	"processing_started_at" timestamp with time zone,
	"processing_completed_at" timestamp with time zone,
	"processing_duration_ms" integer,
	"error_message" text,
	"retry_count" integer DEFAULT 0,
	"max_retries" integer DEFAULT 3,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_prompt_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_type" varchar(50) NOT NULL,
	"provider" varchar(30),
	"version" integer DEFAULT 1 NOT NULL,
	"system_prompt" text NOT NULL,
	"user_prompt_template" text NOT NULL,
	"output_schema" jsonb,
	"is_active" boolean DEFAULT true,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_usage_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" varchar(30) NOT NULL,
	"model" varchar(100) NOT NULL,
	"job_type" varchar(50) NOT NULL,
	"input_tokens" integer DEFAULT 0,
	"output_tokens" integer DEFAULT 0,
	"estimated_cost" numeric(10, 6) DEFAULT '0',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "categorization_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payee_pattern" varchar(255) NOT NULL,
	"amount_range_min" numeric(19, 4),
	"amount_range_max" numeric(19, 4),
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"times_confirmed" integer DEFAULT 1,
	"times_overridden" integer DEFAULT 0,
	"last_used_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aij_tenant" ON "ai_jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aij_status" ON "ai_jobs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aij_type" ON "ai_jobs" USING btree ("tenant_id","job_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aij_input" ON "ai_jobs" USING btree ("input_type","input_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aul_tenant_month" ON "ai_usage_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aul_provider" ON "ai_usage_log" USING btree ("provider","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ch_tenant_payee" ON "categorization_history" USING btree ("tenant_id","payee_pattern");