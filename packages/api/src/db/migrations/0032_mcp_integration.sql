-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- MCP Integration Migration
-- OAuth tables, MCP config, MCP request log, enhanced api_keys

-- 1. Enhance api_keys with scopes, companies, rate limits
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "scopes" text DEFAULT 'all';
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "allowed_companies" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rate_limit_per_minute" integer DEFAULT 60;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rate_limit_per_hour" integer DEFAULT 1000;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "last_used_ip" varchar(45);
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "total_requests" bigint DEFAULT 0;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "revoked_by" uuid;
CREATE INDEX IF NOT EXISTS "idx_api_keys_user" ON "api_keys" USING btree ("user_id");
--> statement-breakpoint

-- 2. OAuth Clients
CREATE TABLE IF NOT EXISTS "oauth_clients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" varchar(100) NOT NULL UNIQUE,
  "client_secret_hash" varchar(255) NOT NULL,
  "name" varchar(255) NOT NULL,
  "redirect_uris" text NOT NULL,
  "grant_types" text DEFAULT 'authorization_code',
  "scopes" text DEFAULT 'all',
  "is_active" boolean DEFAULT true,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint

-- 3. OAuth Tokens
CREATE TABLE IF NOT EXISTS "oauth_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "access_token_hash" varchar(255) NOT NULL,
  "refresh_token_hash" varchar(255),
  "scopes" text NOT NULL,
  "access_token_expires_at" timestamp with time zone NOT NULL,
  "refresh_token_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now(),
  "revoked_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "idx_ot_access" ON "oauth_tokens" USING btree ("access_token_hash");
CREATE INDEX IF NOT EXISTS "idx_ot_user" ON "oauth_tokens" USING btree ("user_id");
--> statement-breakpoint

-- 4. OAuth Authorization Codes
CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "code_hash" varchar(255) NOT NULL,
  "redirect_uri" text NOT NULL,
  "scopes" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used" boolean DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint

-- 5. MCP Request Log
CREATE TABLE IF NOT EXISTS "mcp_request_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "auth_method" varchar(20) NOT NULL,
  "api_key_id" uuid,
  "oauth_client_id" uuid,
  "tool_name" varchar(100),
  "resource_uri" varchar(500),
  "company_id" uuid,
  "parameters" jsonb,
  "status" varchar(20),
  "error_code" varchar(50),
  "response_summary" text,
  "ip_address" varchar(45),
  "user_agent" text,
  "duration_ms" integer,
  "created_at" timestamp with time zone DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_mrl_user" ON "mcp_request_log" USING btree ("user_id","created_at");
CREATE INDEX IF NOT EXISTS "idx_mrl_key" ON "mcp_request_log" USING btree ("api_key_id","created_at");
CREATE INDEX IF NOT EXISTS "idx_mrl_company" ON "mcp_request_log" USING btree ("company_id","created_at");
--> statement-breakpoint

-- 6. MCP System Configuration
CREATE TABLE IF NOT EXISTS "mcp_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "is_enabled" boolean DEFAULT false,
  "max_keys_per_user" integer DEFAULT 5,
  "system_rate_limit_per_minute" integer DEFAULT 500,
  "allowed_scopes" text DEFAULT 'all,read,write,reports,banking,invoicing',
  "oauth_enabled" boolean DEFAULT false,
  "require_key_expiration" boolean DEFAULT false,
  "max_key_lifetime_days" integer,
  "configured_by" uuid,
  "configured_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint

-- 7. Add mcp_enabled to companies
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "mcp_enabled" boolean DEFAULT false;
