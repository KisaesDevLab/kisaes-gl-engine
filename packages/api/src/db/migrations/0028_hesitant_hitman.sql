-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
CREATE TABLE IF NOT EXISTS "magic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false,
	"used_at" timestamp with time zone,
	"ip_address" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0,
	"device_name" varchar(255),
	"aaguid" varchar(36),
	"transports" text,
	"backed_up" boolean DEFAULT false,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_login_method" varchar(20) DEFAULT 'password';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "magic_link_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "tfa_config" ADD COLUMN "passkeys_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "tfa_config" ADD COLUMN "magic_link_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "tfa_config" ADD COLUMN "magic_link_expiry_minutes" integer DEFAULT 15;--> statement-breakpoint
ALTER TABLE "tfa_config" ADD COLUMN "magic_link_max_attempts" integer DEFAULT 3;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ml_token" ON "magic_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ml_user" ON "magic_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pk_user" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pk_credential" ON "passkeys" USING btree ("credential_id");