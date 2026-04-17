-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
CREATE TABLE IF NOT EXISTS "tfa_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" varchar(255) NOT NULL,
	"method" varchar(20) NOT NULL,
	"destination" varchar(255),
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tfa_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_enabled" boolean DEFAULT false,
	"allowed_methods" text DEFAULT 'email,totp',
	"trust_device_enabled" boolean DEFAULT true,
	"trust_device_duration_days" integer DEFAULT 30,
	"code_expiry_seconds" integer DEFAULT 300,
	"code_length" integer DEFAULT 6,
	"max_attempts" integer DEFAULT 5,
	"lockout_duration_minutes" integer DEFAULT 15,
	"sms_provider" varchar(20),
	"sms_twilio_account_sid_encrypted" text,
	"sms_twilio_auth_token_encrypted" text,
	"sms_twilio_from_number" varchar(20),
	"sms_textlink_api_key_encrypted" text,
	"sms_textlink_service_name" varchar(100),
	"configured_by" uuid,
	"configured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tfa_trusted_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_fingerprint_hash" varchar(255) NOT NULL,
	"device_name" varchar(255),
	"ip_address" varchar(45),
	"trusted_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"is_active" boolean DEFAULT true
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_methods" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_preferred_method" varchar(20);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_phone" varchar(30);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_phone_verified" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_totp_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_totp_verified" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_recovery_codes_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_recovery_codes_remaining" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_failed_attempts" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_locked_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tfa_codes_user" ON "tfa_codes" USING btree ("user_id","used","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_tfa_td_user_device" ON "tfa_trusted_devices" USING btree ("user_id","device_fingerprint_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tfa_td_user_active" ON "tfa_trusted_devices" USING btree ("user_id","is_active");