-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
CREATE TABLE IF NOT EXISTS "global_rule_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submitted_by_user_id" uuid NOT NULL,
	"submitted_by_email" varchar(255),
	"source_tenant_id" uuid,
	"source_rule_id" uuid,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"name" varchar(255) NOT NULL,
	"apply_to" varchar(10) DEFAULT 'both' NOT NULL,
	"description_contains" varchar(255),
	"description_exact" varchar(255),
	"amount_equals" numeric(19, 4),
	"amount_min" numeric(19, 4),
	"amount_max" numeric(19, 4),
	"assign_account_name" varchar(255),
	"assign_contact_name" varchar(255),
	"assign_memo" varchar(500),
	"auto_confirm" boolean DEFAULT false,
	"note" varchar(500),
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
